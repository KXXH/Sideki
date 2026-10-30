import { defineCommand } from 'just-bash'
import type { Command } from 'just-bash'
import { debugSession } from './debug-session'
import type { NetworkEntry, ConsoleEntry } from './debug-session'
import { formatSize } from '../shared/format'

function parseFlag(args: string[], flag: string): string | null {
  const prefix = `--${flag}=`
  const found = args.find(a => a.startsWith(prefix))
  if (found) return found.slice(prefix.length)
  // Reason: AI agents frequently write "--flag value" instead of "--flag=value" —
  // accept both so e.g. `debug source 24 --search 留观` doesn't silently no-op
  const idx = args.indexOf(`--${flag}`)
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) return args[idx + 1]
  return null
}

function positional(args: string[]): string[] {
  return args.filter(a => !a.startsWith('--'))
}


const USAGE = `Usage: debug <subcommand>

Subcommands:
  elements "selector"                      Inspect element styles, box model, listeners
  network start|stop|list|clear [--filter] Capture network requests
  console start|stop|list|clear [--filter] Capture console output
  scripts [--filter=pat]                   List loaded scripts
  source <id> [--col=N] [--search=pat] [--beautify] [--line=N]  Read source
  inject "code"                            Inject JS that persists across navigations
  perf                                     Performance metrics
`

// --- Formatters ---

function formatNetworkTable(entries: NetworkEntry[]): string {
  if (entries.length === 0) return '(no requests captured)\n'

  const lines: string[] = []
  lines.push('ID              STATUS  METHOD  URL                                        DURATION  SIZE')

  for (const e of entries) {
    const id = e.requestId.padEnd(14)
    const status = e.status != null ? String(e.status) : (e.error ? 'ERR' : '...')
    const method = e.method
    // Reason: truncate long URLs to keep the table readable in terminal
    const url = e.url.length > 40 ? e.url.slice(0, 37) + '...' : e.url
    const duration = e.endTime ? `${e.endTime - e.startTime}ms` : '...'
    const size = e.size != null ? formatSize(e.size) : '...'

    lines.push(
      `${id}  ${status.padEnd(6)}  ${method.padEnd(6)}  ${url.padEnd(40)}  ${duration.padEnd(8)}  ${size}`
    )
  }

  return lines.join('\n') + '\n'
}

function formatConsoleEntries(entries: ConsoleEntry[]): string {
  if (entries.length === 0) return '(no console messages)\n'

  return entries.map(e => {
    const loc = e.stackTrace ? ` (${e.stackTrace.split('\n')[0].trim().replace('  at ', '')})` : ''
    const argsInfo = e.args && e.args.length > 1 ? `\n    args: ${e.args.join(', ')}` : ''
    return `[${e.level}] ${e.text}${loc}${argsInfo}`
  }).join('\n') + '\n'
}

// --- Command ---

export function createDebugCommand(): Command {
  return defineCommand('debug', async (args) => {
    const sub = positional(args)[0]

    if (!sub) {
      return { stdout: USAGE, stderr: '', exitCode: 0 }
    }

    // Reason: auto-attach if not connected — Pro mode should "just work"
    if (!debugSession.isAttached()) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!tab?.id) return { stdout: '', stderr: 'No active tab to attach debugger\n', exitCode: 1 }
        await debugSession.attach(tab.id)
      } catch (e) {
        return { stdout: '', stderr: `Failed to attach debugger: ${(e as Error).message}\n`, exitCode: 1 }
      }
    }

    switch (sub) {
      case 'elements':
        return handleElements(args)
      case 'network':
        return handleNetwork(args)
      case 'console':
        return handleConsole(args)
      case 'scripts':
        return handleScripts(args)
      case 'source':
        return handleSource(args)
      case 'inject':
        return handleInject(args)
      case 'perf':
        return handlePerf()
      default:
        return { stdout: USAGE, stderr: `Unknown subcommand: ${sub}\n`, exitCode: 1 }
    }
  })
}

// --- Subcommand handlers ---

async function handleElements(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {

  const selector = positional(args)[1]
  if (!selector) {
    return { stdout: '', stderr: 'Usage: debug elements "selector"\n', exitCode: 1 }
  }

  try {
    // Reason: DOM-domain calls must run sequentially — getBoxModel and
    // getComputedStyles each do enable/getDocument/disable, and a concurrent
    // DOM.disable invalidates the other call's freshly resolved nodeId
    // ("Could not find node with given id").
    const boxModel = await debugSession.getBoxModel(selector)
    const styles = await debugSession.getComputedStyles(selector)
    const listeners = await debugSession.getEventListeners(selector)

    const lines: string[] = []

    // Box Model section
    lines.push('=== Box Model ===')
    lines.push(`width: ${boxModel.width}px, height: ${boxModel.height}px`)
    lines.push(`content: [${boxModel.content.join(', ')}]`)
    lines.push(`padding: [${boxModel.padding.join(', ')}]`)
    lines.push(`border: [${boxModel.border.join(', ')}]`)
    lines.push(`margin: [${boxModel.margin.join(', ')}]`)
    lines.push('')

    // Computed Styles section
    lines.push('=== Computed Styles ===')
    for (const [key, value] of Object.entries(styles)) {
      lines.push(`${key}: ${value}`)
    }
    lines.push('')

    // Event Listeners section
    lines.push(`=== Event Listeners (${listeners.length}) ===`)
    if (listeners.length === 0) {
      lines.push('(none)')
    } else {
      for (const l of listeners) {
        // Reason: show first line of handler to give context without overwhelming output
        const handlerPreview = l.handler.split('\n')[0].slice(0, 80)
        lines.push(`${l.type} → script:${l.scriptId} line:${l.lineNumber} | ${handlerPreview}`)
      }
    }

    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
  }
}

async function handleNetwork(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const pos = positional(args)
  const action = pos[1] // pos[0] is 'network'

  if (!action) {
    return { stdout: '', stderr: 'Usage: debug network start|stop|list [--filter=pattern]\n', exitCode: 1 }
  }


  switch (action) {
    case 'start': {
      const filter = parseFlag(args, 'filter') ?? undefined
      try {
        await debugSession.startNetworkCapture(filter)
        const msg = filter
          ? `Network capture started (filter: ${filter})\n`
          : 'Network capture started\n'
        return { stdout: msg, stderr: '', exitCode: 0 }
      } catch (e) {
        return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
      }
    }

    case 'stop': {
      try {
        const entries = await debugSession.stopNetworkCapture()
        if (entries.length === 0) {
          return { stdout: '(no requests captured)\n', stderr: '', exitCode: 0 }
        }
        // Reason: output JSONL format so the user can redirect to a file
        const jsonl = entries.map(e => JSON.stringify(e)).join('\n')
        return { stdout: jsonl + '\n', stderr: `Captured ${entries.length} requests\n`, exitCode: 0 }
      } catch (e) {
        return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
      }
    }

    case 'list': {
      const filter = parseFlag(args, 'filter') ?? undefined
      const entries = debugSession.getNetworkBuffer(filter)
      return { stdout: formatNetworkTable(entries), stderr: '', exitCode: 0 }
    }

    case 'clear':
      debugSession.clearNetworkBuffer()
      return { stdout: 'Network buffer cleared\n', stderr: '', exitCode: 0 }

    case 'headers': {
      const reqId = pos[2]
      if (!reqId) return { stdout: '', stderr: 'Usage: debug network headers <requestId>\n', exitCode: 1 }
      const all = debugSession.getNetworkBuffer()
      const entry = all.find(e => e.requestId === reqId)
      if (!entry) return { stdout: '', stderr: `Request ${reqId} not found in buffer\n`, exitCode: 1 }
      const lines: string[] = []
      lines.push(`--- ${entry.method} ${entry.url} ---`)
      if (entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0) {
        lines.push('\nRequest Headers:')
        for (const [k, v] of Object.entries(entry.requestHeaders)) lines.push(`  ${k}: ${v}`)
      }
      if (entry.postData) {
        lines.push(`\nRequest Body:\n  ${entry.postData.slice(0, 2000)}`)
      }
      if (entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0) {
        lines.push('\nResponse Headers:')
        for (const [k, v] of Object.entries(entry.responseHeaders)) lines.push(`  ${k}: ${v}`)
      }
      return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
    }

    case 'body': {
      const reqId = pos[2]
      if (!reqId) return { stdout: '', stderr: 'Usage: debug network body <requestId>\n', exitCode: 1 }
      const result = await debugSession.getResponseBody(reqId)
      if ('error' in result) return { stdout: '', stderr: result.error + '\n', exitCode: 1 }
      return { stdout: (result.base64Encoded ? `[base64, ${result.body.length} chars]\n` : result.body) + '\n', stderr: '', exitCode: 0 }
    }

    default:
      return { stdout: '', stderr: 'Usage: debug network start|stop|list|clear|headers|body [--filter=pattern]\n', exitCode: 1 }
  }
}

async function handleConsole(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const pos = positional(args)
  const action = pos[1] // pos[0] is 'console'

  if (!action) {
    return { stdout: '', stderr: 'Usage: debug console start|stop|list [--filter=pattern]\n', exitCode: 1 }
  }


  switch (action) {
    case 'start': {
      try {
        await debugSession.startConsoleCapture()
        return { stdout: 'Console capture started\n', stderr: '', exitCode: 0 }
      } catch (e) {
        return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
      }
    }

    case 'stop': {
      try {
        const entries = await debugSession.stopConsoleCapture()
        if (entries.length === 0) {
          return { stdout: '(no console messages)\n', stderr: '', exitCode: 0 }
        }
        // Reason: structured output for potential redirection; one JSON per line
        const jsonl = entries.map(e => JSON.stringify(e)).join('\n')
        return { stdout: jsonl + '\n', stderr: `Captured ${entries.length} messages\n`, exitCode: 0 }
      } catch (e) {
        return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
      }
    }

    case 'list': {
      const filter = parseFlag(args, 'filter') ?? undefined
      let entries = debugSession.getConsoleBuffer()
      if (filter) {
        const lower = filter.toLowerCase()
        entries = entries.filter(e =>
          e.text.toLowerCase().includes(lower) || e.level.toLowerCase().includes(lower)
        )
      }
      return { stdout: formatConsoleEntries(entries), stderr: '', exitCode: 0 }
    }

    case 'clear':
      debugSession.clearConsoleBuffer()
      return { stdout: 'Console buffer cleared\n', stderr: '', exitCode: 0 }

    default:
      return { stdout: '', stderr: 'Usage: debug console start|stop|list|clear [--filter=pattern]\n', exitCode: 1 }
  }
}

async function handleScripts(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {

  const filter = parseFlag(args, 'filter') ?? undefined

  try {
    const scripts = await debugSession.getScripts(filter)
    if (scripts.length === 0) {
      return { stdout: '(no scripts found)\n', stderr: '', exitCode: 0 }
    }

    const lines: string[] = []
    lines.push('ID    LINES        URL')

    // Reason: URL goes last and untruncated — same-prefix bundle chunks must stay
    // distinguishable and pipeable (e.g. debug scripts | grep chunk-name)
    for (const s of scripts) {
      const id = s.scriptId.padEnd(4)
      const range = `${s.startLine}-${s.endLine}`.padEnd(11)
      lines.push(`${id}  ${range}  ${s.url}`)
    }

    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
  }
}

// Reason: bundlers often emit CJK strings as \uXXXX escapes — convert non-ASCII
// chars so searching "留观" also matches "\u7559\u89c2" in the raw source
function toUnicodeEscapes(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    out += code < 0x80 ? text[i] : '\\u' + code.toString(16).padStart(4, '0')
  }
  return out
}

// Reason: minified bundles are single-line monsters — naive beautify for greppability
function naiveBeautify(source: string): string {
  let result = ''
  let indent = 0
  let inString: string | null = null
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    // Reason: track string boundaries to avoid splitting inside literals
    if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
      inString = ch
      result += ch
    } else if (inString && ch === inString && source[i - 1] !== '\\') {
      inString = null
      result += ch
    } else if (inString) {
      result += ch
    } else if (ch === '{') {
      indent++
      result += ' {\n' + '  '.repeat(indent)
    } else if (ch === '}') {
      indent = Math.max(0, indent - 1)
      result += '\n' + '  '.repeat(indent) + '}'
      if (source[i + 1] !== ';' && source[i + 1] !== ',') result += '\n' + '  '.repeat(indent)
    } else if (ch === ';') {
      result += ';\n' + '  '.repeat(indent)
    } else {
      result += ch
    }
    i++
  }
  return result
}

async function handleSource(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {

  const pos = positional(args)
  const scriptId = pos[1]

  if (!scriptId) {
    return { stdout: '', stderr: 'Usage: debug source <scriptId> [--line=N] [--col=N] [--search=pattern] [--beautify]\n', exitCode: 1 }
  }

  const lineFlag = parseFlag(args, 'line')
  const colFlag = parseFlag(args, 'col')
  const searchFlag = parseFlag(args, 'search')
  const doBeautify = args.includes('--beautify')
  const targetLine = lineFlag ? parseInt(lineFlag, 10) : null
  const targetCol = colFlag ? parseInt(colFlag, 10) : null

  try {
    const source = await debugSession.getScriptSource(scriptId)
    const isMinified = source.split('\n').length <= 5 && source.length > 1024

    // --col: extract context around column position (best for minified files with stack trace)
    if (targetCol !== null) {
      const rawLine = source.split('\n')[(targetLine ?? 1) - 1] ?? source
      const ctx = 300
      const start = Math.max(0, targetCol - ctx)
      const end = Math.min(rawLine.length, targetCol + ctx)
      const snippet = rawLine.slice(start, end)
      const pointer = ' '.repeat(Math.min(ctx, targetCol - start)) + '^'
      const header = `--- script:${scriptId} line:${targetLine ?? 1} col:${targetCol} (±${ctx} chars) ---`
      return { stdout: header + '\n' + snippet + '\n' + pointer + '\n', stderr: '', exitCode: 0 }
    }

    // --search: find pattern in raw source, return matches with surrounding context
    if (searchFlag) {
      // Reason: search both the literal form and the \uXXXX escaped form so
      // CJK queries match sources that store non-ASCII text as escapes
      const needles = [searchFlag]
      const escaped = toUnicodeEscapes(searchFlag)
      if (escaped !== searchFlag) needles.push(escaped)
      const srcLower = source.toLowerCase()
      const found = new Map<number, string>()
      for (const needle of needles) {
        const lower = needle.toLowerCase()
        let pos = 0
        while (found.size < 10) {
          const idx = srcLower.indexOf(lower, pos)
          if (idx < 0) break
          if (!found.has(idx)) {
            const start = Math.max(0, idx - 80)
            const end = Math.min(source.length, idx + needle.length + 80)
            found.set(idx, `  [col:${idx}] ...${source.slice(start, end)}...`)
          }
          pos = idx + needle.length
        }
      }
      if (found.size === 0) return { stdout: `No matches for "${searchFlag}" in script:${scriptId}\n`, stderr: '', exitCode: 0 }
      const matches = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line)
      const header = `--- script:${scriptId} search "${searchFlag}" (${matches.length} matches) ---`
      return { stdout: header + '\n' + matches.join('\n') + '\n', stderr: '', exitCode: 0 }
    }

    // --beautify: format minified code for readability
    if (doBeautify) {
      if (!isMinified) {
        return { stdout: source, stderr: '', exitCode: 0 }
      }
      const beautified = naiveBeautify(source)
      return { stdout: beautified, stderr: `Beautified ${source.length} chars → ${beautified.split('\n').length} lines\n`, exitCode: 0 }
    }

    // --line with beautified output
    if (targetLine !== null && isMinified) {
      const lines = naiveBeautify(source).split('\n')
      const start = Math.max(0, targetLine - 11)
      const end = Math.min(lines.length, targetLine + 10)
      const outputLines = lines.slice(start, end).map((line, i) => {
        const num = start + i + 1
        const m = num === targetLine ? '>' : ' '
        const display = line.length > 200 ? line.slice(0, 200) + '...' : line
        return `${m} ${String(num).padStart(5)} | ${display}`
      })
      return { stdout: `--- script:${scriptId} lines ${start + 1}-${end} (beautified) ---\n` + outputLines.join('\n') + '\n', stderr: '', exitCode: 0 }
    }

    // --line for normal files
    if (targetLine !== null) {
      const allLines = source.split('\n')
      const start = Math.max(0, targetLine - 11)
      const end = Math.min(allLines.length, targetLine + 10)
      const outputLines = allLines.slice(start, end).map((line, i) => {
        const num = start + i + 1
        const m = num === targetLine ? '>' : ' '
        const display = line.length > 200 ? line.slice(0, 200) + '...' : line
        return `${m} ${String(num).padStart(5)} | ${display}`
      })
      return { stdout: `--- script:${scriptId} lines ${start + 1}-${end} ---\n` + outputLines.join('\n') + '\n', stderr: '', exitCode: 0 }
    }

    // Default: emit the full raw source. Output-size protection belongs to the
    // shell layer (truncateOutput) — truncating here would corrupt redirections
    // like `debug source 42 > /tmp/s.js`. Metadata goes to stderr to keep stdout clean.
    const meta = `script:${scriptId}: ${source.length} bytes${isMinified ? ' (minified — use --beautify, --search or --col)' : ''}\n`
    return { stdout: source.endsWith('\n') ? source : source + '\n', stderr: meta, exitCode: 0 }
  } catch (e) {
    return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
  }
}

async function handlePerf(): Promise<{ stdout: string; stderr: string; exitCode: number }> {

  try {
    const metrics = await debugSession.getPerformanceMetrics()
    if (Object.keys(metrics).length === 0) {
      return { stdout: '(no metrics available)\n', stderr: '', exitCode: 0 }
    }

    const lines: string[] = ['=== Performance Metrics ===']

    // Reason: group key metrics at the top for quick scanning
    const keyMetrics = [
      'Timestamp', 'Documents', 'Frames', 'JSEventListeners',
      'Nodes', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration',
      'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration',
      'JSHeapUsedSize', 'JSHeapTotalSize',
    ]

    const printed = new Set<string>()
    for (const key of keyMetrics) {
      if (key in metrics) {
        const value = formatMetricValue(key, metrics[key])
        lines.push(`${key}: ${value}`)
        printed.add(key)
      }
    }

    // Remaining metrics
    const remaining = Object.entries(metrics).filter(([k]) => !printed.has(k))
    if (remaining.length > 0) {
      lines.push('')
      for (const [key, value] of remaining) {
        lines.push(`${key}: ${formatMetricValue(key, value)}`)
      }
    }

    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
  }
}

function formatMetricValue(key: string, value: number): string {
  // Reason: duration metrics are in seconds — convert to ms for readability
  if (key.endsWith('Duration')) {
    return `${(value * 1000).toFixed(2)}ms`
  }
  // Reason: heap sizes are in bytes — show in MB
  if (key.includes('HeapUsedSize') || key.includes('HeapTotalSize')) {
    return `${(value / (1024 * 1024)).toFixed(2)}MB`
  }
  if (Number.isInteger(value)) {
    return String(value)
  }
  return value.toFixed(4)
}

async function handleInject(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const removeId = parseFlag(args, 'remove')
  if (removeId) {
    try {
      await debugSession.removeScriptOnNewDocument(removeId)
      return { stdout: `Removed injected script ${removeId}\n`, stderr: '', exitCode: 0 }
    } catch (e) {
      return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
    }
  }

  const pos = positional(args)
  const code = pos.slice(1).join(' ')

  if (!code) {
    return { stdout: '', stderr: 'Usage: debug inject "code"\n       debug inject --remove=<id>\n\nInjects JS that runs on every page load (survives navigation/refresh).\n', exitCode: 1 }
  }

  try {
    const id = await debugSession.addScriptOnNewDocument(code)
    return { stdout: `Injected and executed. Will re-run on every navigation.\nRemove with: debug inject --remove=${id}\n`, stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: '', stderr: `${(e as Error).message}\n`, exitCode: 1 }
  }
}
