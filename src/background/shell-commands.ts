import { defineCommand } from 'just-bash'
import type { ExecutionApproval } from '../shared/approval-types'
import type { Command, CommandContext } from 'just-bash'

// Reason: just-bash stdin is ByteString (Latin-1 encoded UTF-8 bytes).
// String() reads it as Latin-1 → mojibake for non-ASCII. This decodes correctly.
function decodeStdin(stdin: string): string {
  if (!stdin) return ''
  let hasHigh = false
  for (let i = 0; i < stdin.length; i++) {
    if (stdin.charCodeAt(i) > 127) { hasHigh = true; break }
  }
  if (!hasHigh) return stdin
  const bytes = new Uint8Array(stdin.length)
  for (let i = 0; i < stdin.length; i++) bytes[i] = stdin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}
import {
  execInTab, requireConsent as requestConsent, execScript,
  handleClick, handleType, handleScroll, handleScreenshot,
  handleWait, handleGetElementInfo, handleFindElement,
  handleDomSnapshot, handleNavigate, handleGetPageContent, handleExecuteJS,
  INJECT_HEADROOM_MS,
} from './tool-handlers'
import { ensureSelectorLib } from './element-resolver'
import { debugSession } from './debug-session'
import { getVersion, parsePdf, MAX_PAGES_PER_CALL } from './pdf-engine'
import { readNotes, appendNote, removeNotes, type PdfNote } from '../shared/pdf-note-store'
import { normalizeMarkdownText, splitMarkdownPages } from '../shared/pdf-anchor'
import { pdfDocumentVersion } from '../shared/pdf-version'
import { getSkillIndex, saveUserSkill, removeUserSkill } from '../shared/skills'
import { loadConfig } from '../shared/storage'
import {
  getGlobalMemory, setGlobalMemory,
  getSiteMemory, setSiteMemory,
  addNote, removeNote, searchNotes, getNotes,
  addMemoryEntry, replaceMemoryEntry, removeMemoryEntry,
} from '../shared/memory-storage'

function parseFlag(args: string[], flag: string): string | null {
  const prefix = `--${flag}=`
  const found = args.find(a => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : null
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(`--${flag}`)
}

function positional(args: string[]): string[] {
  return args.filter(a => !a.startsWith('--'))
}

const DENIED = { stdout: '', stderr: 'Action denied by user\n', exitCode: 126 }

// Reason: enables pipe composition — commands read target from stdin when no arg given.
// Decode before trim — trim() on latin1-packed bytes strips 0xA0 continuation
// bytes (JS treats U+00A0 as whitespace), corrupting multibyte targets.
function stdinTarget(ctx: CommandContext): string | undefined {
  const text = decodeStdin(ctx.stdin as unknown as string || '')
  return text.trim().split('\n')[0]?.trim() || undefined
}

// Reason: an element wait must be able to report its own timeout, so it has to
// finish before shell.ts aborts the command. These mirror that module's exec
// budgets (5s Chat / 30s Pro) minus room for the reply hop. Duplicated rather
// than imported because shell.ts is what builds these commands — importing back
// would close a cycle.
const WAIT_CAP_CHAT_MS = 4_000
const WAIT_CAP_PRO_MS = 28_000

type CmdResult = { stdout: string; stderr: string; exitCode: number; stdoutKind?: 'text' }

// Reason: quote validation happens against the single requested page — a
// quote spanning pages would have to anchor across two text layers, so the
// contract is "verbatim from page N, nothing else".
async function validateQuoteOnPage(
  ctx: CommandContext,
  path: string,
  page: number,
  quote: string,
  disambiguators?: { prefix?: string; suffix?: string },
): Promise<CmdResult | null> {
  if (normalizeMarkdownText(quote).length < 8) {
    return { stdout: '', stderr: `pdf: quote too short — at least 8 significant characters required\n`, exitCode: 1 }
  }
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.readFileBuffer(path)
  } catch {
    return { stdout: '', stderr: `pdf: ${path}: cannot read file\n`, exitCode: 1 }
  }
  let result
  try {
    result = await parsePdf(bytes, [page], { includePageMarkers: true })
  } catch (e) {
    return { stdout: '', stderr: `pdf: ${path}: ${e instanceof Error ? e.message : String(e)}\n`, exitCode: 1 }
  }
  const md = result.markdown ?? ''
  if (!md.trim()) {
    return {
      stdout: '',
      stderr: `pdf: page ${page} has no extractable text (${result.pdfType}; no OCR) — cannot anchor a note\n`,
      exitCode: 1,
    }
  }
  if (page > result.pageCount) {
    return { stdout: '', stderr: `pdf: page ${page} is out of range — the document has ${result.pageCount} pages\n`, exitCode: 1 }
  }
  const pages = splitMarkdownPages(md)
  const pageMd = pages.get(page) ?? md
  const pageNorm = normalizeMarkdownText(pageMd)
  const q = normalizeMarkdownText(quote)
  if (!pageNorm.includes(q)) {
    return {
      stdout: '',
      stderr: `pdf: quote not found on page ${page} — the exact string must appear in that page's text (pdf ${path} --pages=${page}). Quotes must not span page boundaries. Try a shorter, verbatim clause from that page.\n`,
      exitCode: 1,
    }
  }
  // Reason: a quote matching several places on the page cannot be highlighted
  // uniquely in the reader (e.g. the opening sentence of abstract and
  // introduction) — without prefix/suffix it silently degrades to a page-level
  // box, so the ambiguity must be rejected here where it is still actionable.
  if (!disambiguators?.prefix && !disambiguators?.suffix) {
    let count = 0
    let i = pageNorm.indexOf(q)
    while (i !== -1) {
      count++
      i = pageNorm.indexOf(q, i + 1)
    }
    if (count > 1) {
      return {
        stdout: '',
        stderr: `pdf: quote matches ${count} places on page ${page} — the reader cannot tell which occurrence to highlight. Extend the quote so it is unique on the page, or pass --prefix/--suffix (verbatim text immediately before/after the quote).\n`,
        exitCode: 1,
      }
    }
  }
  return null
}

// Reason: an open reader re-reads the sidecar on this broadcast — same channel
// the reader's own writes use. No listener is the normal case, so the rejection
// is swallowed rather than surfaced in the command's output.
function notifyReader(sessionId?: string): void {
  if (!sessionId) return
  chrome.runtime.sendMessage({ type: 'pdfnote:changed', sessionId }).catch(() => {
    /* no reader open */
  })
}

async function runPdfSubcommand(
  verb: 'open' | 'note',
  args: string[],
  ctx: CommandContext,
  sessionId?: string,
): Promise<CmdResult> {
  // Reason: positional args arrive as [verb, action?, path, ...ids] — `open` has
  // no action so its path sits one slot earlier than `note`'s.
  const pos = positional(args)
  const action = pos[1]
  if (verb === 'note' && !['list', 'add', 'rm'].includes(action ?? '')) {
    return { stdout: '', stderr: 'Usage: pdf note list|add|rm <file.pdf> …\n', exitCode: 1 }
  }
  const path = verb === 'note' ? (pos[2] ?? stdinTarget(ctx)) : (pos[1] ?? stdinTarget(ctx))
  if (!path || path.startsWith('-')) {
    return { stdout: '', stderr: `pdf: missing <file.pdf> — usage: pdf ${verb} <file.pdf> …\n`, exitCode: 1 }
  }

  if (verb === 'open') {
    const pageSpec = parseFlag(args, 'page')
    const page = pageSpec ? parseInt(pageSpec, 10) : 1
    if (!Number.isInteger(page) || page < 1) return { stdout: '', stderr: 'pdf: --page must be a positive integer\n', exitCode: 1 }
    if (!sessionId) return { stdout: '', stderr: 'pdf open: no session context\n', exitCode: 1 }
    try {
      await ctx.fs.stat(path)
    } catch {
      return { stdout: '', stderr: `pdf: ${path}: cannot read file\n`, exitCode: 1 }
    }
    // Reason: the real extension ID is unknown to this context — getURL owns it.
    const real = (chrome.runtime.getURL as (p: string) => string)('src/reader/index.html')
    const target = `${real}?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(path)}&page=${page}`
    await chrome.tabs.create({ url: target, active: true })
    return { stdout: '', stderr: `pdf: opened reader for ${path} (page ${page})\n`, exitCode: 0 }
  }

  if (action === 'list') {
    const pageSpec = parseFlag(args, 'page')
    const authorSpec = parseFlag(args, 'author')
    const asJson = hasFlag(args, 'json')
    let notes: PdfNote[]
    try {
      notes = await readNotes(ctx.fs, path)
    } catch {
      return { stdout: '', stderr: `pdf: ${path}: cannot read file\n`, exitCode: 1 }
    }
    if (pageSpec) {
      const p = parseInt(pageSpec, 10)
      notes = notes.filter(n => n.page === p)
    }
    if (authorSpec === 'ai' || authorSpec === 'user') {
      notes = notes.filter(n => n.author === authorSpec)
    }
    if (notes.length === 0) {
      return { stdout: '', stderr: `pdf: no notes on ${path}${pageSpec ? ` page ${pageSpec}` : ''}\n`, exitCode: 0 }
    }
    if (asJson) {
      return { stdout: JSON.stringify(notes, null, 2) + '\n', stdoutKind: 'text' as const, stderr: '', exitCode: 0 }
    }
    const lines = notes.map(n =>
      `[${n.id}] page ${n.page} (${n.author}${n.color ? `, ${n.color}` : ''}): "${n.quote.length > 60 ? n.quote.slice(0, 57) + '…' : n.quote}"${n.note ? ` — ${n.note}` : ''}`
    )
    return { stdout: lines.join('\n') + '\n', stdoutKind: 'text' as const, stderr: `${notes.length} note(s)\n`, exitCode: 0 }
  }

  if (action === 'add') {
    const pageSpec = parseFlag(args, 'page')
    if (!pageSpec) return { stdout: '', stderr: 'pdf note add: --page=N is required\n', exitCode: 1 }
    const page = parseInt(pageSpec, 10)
    if (!Number.isInteger(page) || page < 1) return { stdout: '', stderr: 'pdf note add: --page must be a positive integer\n', exitCode: 1 }
    const quote = parseFlag(args, 'quote') ?? decodeStdin(ctx.stdin as unknown as string || '').trim()
    if (!quote) {
      return { stdout: '', stderr: 'pdf note add: --quote is required (or pipe the quote via stdin)\n', exitCode: 1 }
    }
    const note = parseFlag(args, 'note') ?? undefined
    const prefix = parseFlag(args, 'prefix') ?? undefined
    const suffix = parseFlag(args, 'suffix') ?? undefined
    const color = (parseFlag(args, 'color') ?? 'yellow') as PdfNote['color']
    if (!['yellow', 'green', 'blue', 'pink'].includes(color)) {
      return { stdout: '', stderr: 'pdf note add: --color must be one of yellow|green|blue|pink\n', exitCode: 1 }
    }
    const invalid = await validateQuoteOnPage(ctx, path, page, quote, { prefix, suffix })
    if (invalid) return invalid
    const documentVersion = await pdfDocumentVersion(await ctx.fs.readFileBuffer(path))
    const saved = await appendNote(ctx.fs, path, { author: 'ai', page, quote, prefix, suffix, note, color, documentVersion })
    notifyReader(sessionId)
    return {
      stdout: '',
      stderr: `pdf: note ${saved.id} added on page ${page} of ${path}\n`,
      exitCode: 0,
    }
  }

  if (action === 'rm') {
    const ids = pos.slice(3)
    if (ids.length === 0) return { stdout: '', stderr: 'pdf note rm: at least one noteId is required\n', exitCode: 1 }
    const { removed, missing } = await removeNotes(ctx.fs, path, ids)
    if (removed.length === 0) {
      return { stdout: '', stderr: `pdf: no notes match ${ids.join(' ')} on ${path}\n`, exitCode: 1 }
    }
    notifyReader(sessionId)
    const tail = missing.length > 0 ? ` (not found: ${missing.join(' ')})\n` : '\n'
    return { stdout: '', stderr: `pdf: removed ${removed.length} note(s): ${removed.map(n => n.id).join(' ')}${tail}`, exitCode: 0 }
  }

  return { stdout: '', stderr: 'Usage: pdf note list|add|rm <file.pdf> …\n', exitCode: 1 }
}

// Reason: pages are 1-indexed and the engine throws on page 0, so reject it here
// with a usable message instead of surfacing a raw panic. The per-call ceiling
// applies to explicit ranges too — otherwise --pages would be a way around the
// cap that keeps a synchronous parse from stalling the service worker.
export function parsePageSpec(spec: string): { pages: number[] } | { error: string } {
  const pages = new Set<number>()
  for (const part of spec.split(',')) {
    const range = part.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!range) return { error: `pdf: invalid --pages segment "${part.trim()}" — use 1-20, 3, or 1-5,10` }
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    if (from < 1) return { error: 'pdf: pages are 1-indexed — page 0 is invalid' }
    if (to < from) return { error: `pdf: invalid --pages range "${part.trim()}" — end is before start` }
    for (let p = from; p <= to; p++) {
      pages.add(p)
      if (pages.size > MAX_PAGES_PER_CALL) return { error: `pdf: at most ${MAX_PAGES_PER_CALL} pages per call — narrow the range` }
    }
  }
  if (pages.size === 0) return { error: 'pdf: --pages is empty' }
  return { pages: [...pages].sort((a, b) => a - b) }
}

export function createPageCommands(tabId: number, currentMode?: 'chat' | 'pro', onMemoryUpdate?: (path: string, content: string) => void, sessionId?: string, getAuthorization?: () => ExecutionApproval | undefined): Command[] {
  const requireConsent = (...args: Parameters<typeof requestConsent>) => {
    const authorization = getAuthorization?.()
    return authorization ? requestConsent(args[0], args[1], args[2], args[3], authorization) : requestConsent(...args)
  }
  return [
    defineCommand('dom', async (args) => {
      const root = parseFlag(args, 'root') ?? undefined
      const includeAll = hasFlag(args, 'all')
      const flat = hasFlag(args, 'flat')
      const result = await handleDomSnapshot(tabId, { root, includeAll, flat, maxNodes: Infinity }) as { success: boolean; error?: string; snapshot?: string }
      if (!result.success) return { stdout: '', stderr: (result.error ?? 'Unknown error') + '\n', exitCode: 1 }
      return { stdout: (result.snapshot ?? '') + '\n', stderr: '', exitCode: 0 }
    }),

    defineCommand('page-content', async (args) => {
      const frame = parseFlag(args, 'frame') ?? undefined
      const html = hasFlag(args, 'html')
      const result = await handleGetPageContent(tabId, { frame }) as { success: boolean; error?: string; html?: string; title?: string; url?: string; frameCount?: number; frameNote?: string }
      if (!result.success) return { stdout: '', stderr: (result.error ?? 'Unknown error') + '\n', exitCode: 1 }
      // Reason: --html is a raw dump consumed by pipes; keep the frame note out of it.
      if (html) return { stdout: (result.html ?? '') + '\n', stderr: '', exitCode: 0 }
      // Reason: extract plain text in page context (service worker has no DOMParser).
      // This matches what getPageContent tool returns.
      // Reason: this only transforms the HTML string we already hold, so page
      // load state is irrelevant — inject immediately rather than await idle.
      try {
        const [res] = await execScript<string>({
          target: { tabId },
          injectImmediately: true,
          func: (rawHtml: string) => {
            const doc = new DOMParser().parseFromString(rawHtml, 'text/html')
            for (const el of doc.querySelectorAll('script,style,noscript,svg,link,meta')) el.remove()
            return doc.body?.innerText?.replace(/\n{3,}/g, '\n\n').trim() ?? ''
          },
          args: [result.html ?? ''],
        })
        const text = res?.result ?? result.html ?? ''
        const header = `Page: ${result.title ?? ''}\nURL: ${result.url ?? ''}\n\n`
        const note = result.frameNote ? `\n${result.frameNote}\n` : ''
        return { stdout: header + text + '\n' + note, stderr: '', exitCode: 0 }
      } catch {
        return { stdout: (result.html ?? '') + '\n', stderr: '', exitCode: 0 }
      }
    }),

    defineCommand('pdf', async (args, ctx) => {
      if (hasFlag(args, 'version')) {
        try {
          return { stdout: await getVersion() + '\n', stderr: '', exitCode: 0 }
        } catch (e) {
          return { stdout: '', stderr: `pdf engine unavailable: ${e instanceof Error ? e.message : String(e)}\n`, exitCode: 1 }
        }
      }

      // Reason: subcommand dispatch — VFS paths are absolute (/...), bare words
      // are verbs. Same layer as the --version flag branch above.
      const first = positional(args)[0]
      if (first === 'open' || first === 'note') {
        return runPdfSubcommand(first, args, ctx, sessionId)
      }

      const path = first || stdinTarget(ctx)
      if (!path) return { stdout: '', stderr: 'Usage: pdf <file.pdf> [--pages=1-20] | pdf open <file.pdf> [--page=N] | pdf note list|add|rm <file.pdf> … | pdf --version\n', exitCode: 1 }

      const spec = parseFlag(args, 'pages')
      let pages: number[]
      if (spec) {
        const parsed = parsePageSpec(spec)
        if ('error' in parsed) return { stdout: '', stderr: parsed.error + '\n', exitCode: 1 }
        pages = parsed.pages
      } else {
        pages = Array.from({ length: MAX_PAGES_PER_CALL }, (_, i) => i + 1)
      }

      let bytes: Uint8Array
      try {
        bytes = await ctx.fs.readFileBuffer(path)
      } catch {
        return { stdout: '', stderr: `pdf: ${path}: cannot read file\n`, exitCode: 1 }
      }

      let result
      try {
        result = await parsePdf(bytes, pages, { includePageMarkers: true })
      } catch (e) {
        return { stdout: '', stderr: `pdf: ${path}: ${e instanceof Error ? e.message : String(e)}\n`, exitCode: 1 }
      }

      const md = result.markdown ?? ''
      const notes = [`pdfType=${result.pdfType} pages=${result.pageCount} chars=${md.length} ms=${Math.round(result.processingTimeMs)}`]

      if (!md.trim()) {
        // Reason: the WASM build carries no OCR, so an image-only document is a
        // dead end here — say so instead of returning silent emptiness.
        notes.push(result.pdfType === 'TextBased'
          ? 'no text extracted from the requested pages'
          : `no text layer (${result.pdfType}); OCR is not supported`)
        return { stdout: '', stderr: notes.join('\n') + '\n', exitCode: 1 }
      }

      // Reason: out-of-range pages are dropped silently by the engine, so an
      // uncapped read of a long document would look complete. Name what was left out.
      if (!spec && result.pageCount > MAX_PAGES_PER_CALL) {
        notes.push(`showing pages 1-${MAX_PAGES_PER_CALL} of ${result.pageCount} — pass --pages=${MAX_PAGES_PER_CALL + 1}-${result.pageCount} for the rest`)
      }
      if (result.hasEncodingIssues) notes.push('warning: broken font encoding detected — text may be unreliable')
      if (result.pagesNeedingOcr.length > 0) notes.push(`pages without a text layer: ${result.pagesNeedingOcr.join(',')}`)
      // Reason: shell.ts truncates the returned stdout but not redirections —
      // steer large output to a file instead of letting it get cut off.
      notes.push(`redirect to keep it whole: pdf ${path} > /tmp/doc.md`)

      // Reason: stdoutKind marks this as Unicode text so pipes and redirects
      // UTF-8 encode it exactly once — without it CJK markdown can round-trip
      // through the latin1 byte view and come out mojibake. Set inline because
      // just-bash's browser bundle does not export the textOutput helper.
      return { stdout: md.endsWith('\n') ? md : md + '\n', stdoutKind: 'text' as const, stderr: notes.join('\n') + '\n', exitCode: 0 }
    }),

    defineCommand('element-info', async (args, ctx) => {
      const target = positional(args)[0] || stdinTarget(ctx)
      if (!target) return { stdout: '', stderr: 'Usage: element-info "target"\n', exitCode: 1 }
      const result = await handleGetElementInfo(tabId, { target }) as Record<string, unknown>
      if (!result.success) return { stdout: '', stderr: ((result.error as string) ?? 'Unknown error') + '\n', exitCode: 1 }
      const lines = [
        `Tag: ${result.tagName}`,
        `Text: ${String(result.text ?? '').slice(0, 200)}`,
        `Visible: ${result.visible}`,
      ]
      if (result.value !== undefined) lines.push(`Value: ${result.value}`)
      const rect = result.boundingRect as Record<string, number> | undefined
      if (rect) lines.push(`Position: (${Math.round(rect.x)}, ${Math.round(rect.y)}) ${Math.round(rect.width)}x${Math.round(rect.height)}`)
      const attrs = result.attributes as Record<string, string> | undefined
      if (attrs && Object.keys(attrs).length > 0) lines.push(`Attributes: ${JSON.stringify(attrs)}`)
      return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
    }),

    defineCommand('find-element', async (args, ctx) => {
      const selector = parseFlag(args, 'selector') ?? undefined
      const attr = parseFlag(args, 'attr') ?? undefined
      const pos = positional(args)
      const text = !selector && !attr ? (pos[0] || stdinTarget(ctx)) : (pos[0] ?? undefined)
      const attrValue = attr ? pos[0] : undefined
      if (!text && !selector && !attr) {
        return { stdout: '', stderr: 'Usage: find-element "text" | find-element --selector="css" | find-element --attr="name" "value"\n', exitCode: 1 }
      }
      await ensureSelectorLib(tabId)
      const result = await handleFindElement(tabId, { text, selector, attr, attrValue }) as { success: boolean; error?: string; output?: string; selectors?: string[]; count?: number }
      if (!result.success) return { stdout: '', stderr: (result.error ?? 'Not found') + '\n', exitCode: 1 }
      // Reason: stdout has clean selectors (one per line) for pipe composition;
      // stderr has verbose format for human readability in terminal
      const stdout = (result.selectors ?? []).join('\n') + '\n'
      const stderr = result.output + '\n'
      return { stdout, stderr, exitCode: 0 }
    }),

    defineCommand('js', async (args, ctx) => {
      const frame = parseFlag(args, 'frame') ?? undefined
      const base64 = hasFlag(args, 'b')
      const timeoutStr = parseFlag(args, 'timeout')
      const timeoutMs = timeoutStr ? parseInt(timeoutStr, 10) : undefined
      // Reason: decode before trim — trim() on latin1-packed bytes strips 0xA0
      // continuation bytes (JS treats U+00A0 as whitespace), corrupting the last char
      const stdinFull = decodeStdin(ctx.stdin as unknown as string || '').trim() || undefined
      let code = positional(args)[0] || stdinFull
      if (!code) return { stdout: '', stderr: 'Usage: js "code" | cat file.js | js [--frame=sel] [--timeout=ms]\n', exitCode: 1 }
      if (base64) {
        // Reason: atob yields latin1 bytes — decode as UTF-8 so non-ASCII code survives
        try { code = decodeStdin(atob(code)) } catch { return { stdout: '', stderr: 'Invalid base64 input\n', exitCode: 1 } }
      }
      if (!await requireConsent('js', code, tabId)) return DENIED
      const result = await handleExecuteJS(tabId, { code, frameSelector: frame, timeoutMs }) as { success: boolean; error?: string; result?: string }
      if (!result.success) {
        const err = result.error ?? 'Unknown error'
        const parts = [err]
        if (result.result) parts.push('Console output:\n' + result.result)
        // Reason: escaping issues are the #1 cause of js command failures from AI agents.
        // Hint towards pipe which bypasses shell quoting entirely.
        if (/SyntaxError|Unexpected token|Unexpected end|Invalid or unexpected/.test(err) && !base64) {
          parts.push('Hint: quoting issue? Write code to a file and pipe it: cat /tmp/code.js | js')
        }
        return { stdout: '', stderr: parts.join('\n') + '\n', exitCode: 1 }
      }
      return { stdout: (result.result ?? 'undefined') + '\n', stderr: '', exitCode: 0 }
    }),

    defineCommand('click', async (args, ctx) => {
      const target = positional(args)[0] || stdinTarget(ctx)
      if (!target) return { stdout: '', stderr: 'Usage: click "target" [--double] [--real]\n', exitCode: 1 }
      if (!await requireConsent('click', target, tabId, { tabId, target })) return DENIED
      const doubleClick = hasFlag(args, 'double')
      const real = hasFlag(args, 'real')
      const result = await handleClick(tabId, { target, doubleClick, real }) as {
        success: boolean; error?: string; text?: string; observed?: string; occludedBy?: string
      }
      if (!result.success) return { stdout: '', stderr: ((result.error) ?? 'Unknown error') + '\n', exitCode: 1 }
      // Reason: the handler reports what the click actually did; without this the
      // pipe only ever says "Clicked" even when a banner took the event.
      const notes = [
        result.occludedBy && `covered by ${result.occludedBy}, which received the event instead`,
        result.observed,
      ].filter(Boolean)
      const suffix = notes.length ? ` [${notes.join('; ')}]` : ''
      return { stdout: `Clicked: ${result.text ?? target}${suffix}\n`, stderr: '', exitCode: 0 }
    }),

    defineCommand('type-text', async (args, ctx) => {
      const pos = positional(args)
      const fromStdin = stdinTarget(ctx)
      // Reason: if 2 positional args → target + text. If 1 arg + stdin → stdin is target, arg is text.
      const target = pos.length >= 2 ? pos[0] : (fromStdin || pos[0])
      const text = pos.length >= 2 ? pos[1] : (fromStdin ? pos[0] : undefined)
      if (!target || !text) return { stdout: '', stderr: 'Usage: type-text "target" "text" [--append]\n', exitCode: 1 }
      if (!await requireConsent('type', `${target}: "${text}"`, tabId, { tabId, target })) return DENIED
      const clear = !hasFlag(args, 'append')
      const result = await handleType(tabId, { target, text, clear }) as { success: boolean; error?: string }
      if (!result.success) return { stdout: '', stderr: ((result.error) ?? 'Unknown error') + '\n', exitCode: 1 }
      return { stdout: 'OK\n', stderr: '', exitCode: 0 }
    }),

    defineCommand('scroll', async (args) => {
      const pos = positional(args)
      const direction = pos[0] ?? 'down'
      const amount = pos[1] ? parseInt(pos[1], 10) : 500
      const target = parseFlag(args, 'target') ?? undefined
      if (!await requireConsent('scroll', `${direction} ${amount}px`, tabId)) return DENIED
      const result = await handleScroll(tabId, { direction, amount, target }) as { success: boolean; error?: string }
      if (!result.success) return { stdout: '', stderr: ((result.error) ?? 'Unknown error') + '\n', exitCode: 1 }
      return { stdout: `Scrolled ${direction} ${amount}px\n`, stderr: '', exitCode: 0 }
    }),

    defineCommand('navigate', async (args, ctx) => {
      const url = positional(args)[0] || stdinTarget(ctx)
      if (!url) return { stdout: '', stderr: 'Usage: navigate "url"\n', exitCode: 1 }
      if (!await requireConsent('navigate', url, tabId)) return DENIED
      const result = await handleNavigate(tabId, { url }) as { success: boolean; error?: string; message?: string }
      if (!result.success) return { stdout: '', stderr: ((result.error) ?? 'Unknown error') + '\n', exitCode: 1 }
      return { stdout: (result.message ?? `Navigated to ${url}`) + '\n', stderr: '', exitCode: 0 }
    }),

    defineCommand('page-wait', async (args, ctx) => {
      const target = positional(args)[0] || stdinTarget(ctx)
      const duration = parseFlag(args, 'duration')
      const timeout = parseFlag(args, 'timeout')
      const idle = hasFlag(args, 'idle')

      if (idle) {
        // wait --idle [--timeout=N] — wait for DOM to stabilize
        // Reason: waiting is read-only (DOM observation) — no consent needed
        const timeoutMs = timeout ? parseInt(timeout, 10) : 3000
        const result = await execInTab(tabId, (timeoutMs: number) => {
          return new Promise<{ success: boolean; waited: number }>(resolve => {
            const start = Date.now()
            let mutationTimer: ReturnType<typeof setTimeout> | null = null
            let settled = false

            const observer = new MutationObserver(() => {
              if (mutationTimer) clearTimeout(mutationTimer)
              mutationTimer = setTimeout(() => {
                settled = true
                observer.disconnect()
                resolve({ success: true, waited: Date.now() - start })
              }, 500)
            })

            observer.observe(document.body, { childList: true, subtree: true, attributes: true })

            // Start the settle timer immediately (page might already be idle)
            mutationTimer = setTimeout(() => {
              settled = true
              observer.disconnect()
              resolve({ success: true, waited: Date.now() - start })
            }, 500)

            // Timeout fallback
            setTimeout(() => {
              if (!settled) {
                observer.disconnect()
                resolve({ success: true, waited: Date.now() - start })
              }
            }, timeoutMs)
          })
        }, [timeoutMs], undefined, timeoutMs + INJECT_HEADROOM_MS) as { success: boolean; waited?: number } | { success: false; error: string }
        if (!result.success) return { stdout: '', stderr: ((result as { error: string }).error) + '\n', exitCode: 1 }
        return { stdout: `Idle after ${(result as { waited: number }).waited}ms\n`, stderr: '', exitCode: 0 }
      }

      if (duration) {
        // wait --duration=N — wait fixed time (read-only, no consent)
        const result = await handleWait(tabId, {
          timeout: 5000,
          duration: parseInt(duration, 10),
        }) as { success: boolean; error?: string }
        if (!result.success) return { stdout: '', stderr: ((result.error) ?? 'Unknown error') + '\n', exitCode: 1 }
        return { stdout: `Waited ${duration}ms\n`, stderr: '', exitCode: 0 }
      }

      if (target) {
        // wait "target" [--timeout=N] — wait for element to appear (read-only, no consent)
        // Reason: the default must leave room for the reply hop inside the bash
        // budget. 5000 exactly filled the Chat budget, so the wait could never
        // report its own timeout — bash aborted the command first. maxMs caps an
        // explicit --timeout for the same reason.
        const result = await handleWait(tabId, {
          target,
          timeout: timeout ? parseInt(timeout, 10) : 3000,
          maxMs: currentMode === 'pro' ? WAIT_CAP_PRO_MS : WAIT_CAP_CHAT_MS,
        }) as { success: boolean; error?: string }
        if (!result.success) return { stdout: '', stderr: ((result.error) ?? 'Unknown error') + '\n', exitCode: 1 }
        return { stdout: `Found: ${target}\n`, stderr: '', exitCode: 0 }
      }

      return { stdout: '', stderr: 'Usage: page-wait "target" [--timeout=N] | page-wait --duration=N | page-wait --idle [--timeout=N]\n', exitCode: 1 }
    }),

    defineCommand('screenshot', async (args, ctx) => {
      const target = parseFlag(args, 'target') ?? positional(args)[0] ?? stdinTarget(ctx)
      const result = await handleScreenshot(tabId, { target, sessionId }) as { success: boolean; error?: string; dataUrl?: string; message?: string }
      if (!result.success) return { stdout: '', stderr: ((result.error) ?? 'Unknown error') + '\n', exitCode: 1 }
      // Reason: message carries the VFS mirror path when labImageFs is on
      return { stdout: (result.message ?? 'Screenshot captured') + '\n', stderr: '', exitCode: 0 }
    }),

    // Reason: the byte-safe upload sink. just-bash curl UTF-8-decodes file
    // contents when building request bodies (bytes >= 0x80 become U+FFFD),
    // so binary uploads must bypass it. Body comes from stdin only — the
    // pipe is the one verified byte-safe channel (cat file | http-put URL).
    defineCommand('http-put', async (args, ctx) => {
      const url = positional(args)[0]
      const stdin = ctx.stdin as unknown as string
      const usage = 'Usage: cat /tmp/file.bin | http-put URL [--type=MIME] [--method=POST] [--header="K: V"]\n'
      if (!url || !stdin) return { stdout: '', stderr: usage, exitCode: 1 }
      if (!/^https?:\/\//.test(url)) return { stdout: '', stderr: 'Only http(s) URLs are allowed\n', exitCode: 1 }
      const method = (parseFlag(args, 'method') ?? 'PUT').toUpperCase()
      if (method !== 'PUT' && method !== 'POST') {
        return { stdout: '', stderr: 'Only PUT and POST are allowed\n', exitCode: 1 }
      }
      const cfg = await loadConfig()
      if (!cfg?.labFetch) {
        return { stdout: '', stderr: 'Network requests are disabled. Ask the user to enable "允许网络请求" in Settings → 权限.\n', exitCode: 1 }
      }
      if (!await requireConsent('http-put', `${method} ${url} (${stdin.length} bytes)`, tabId)) return DENIED
      // Reason: stdin ByteString → Uint8Array verbatim, zero text decoding —
      // Content-Length follows byteLength automatically.
      const bytes = new Uint8Array(stdin.length)
      for (let i = 0; i < stdin.length; i++) bytes[i] = stdin.charCodeAt(i) & 0xff
      const headers: Record<string, string> = { 'Content-Type': parseFlag(args, 'type') ?? 'application/octet-stream' }
      for (const h of args.filter(a => a.startsWith('--header='))) {
        const kv = h.slice('--header='.length)
        const sep = kv.indexOf(':')
        if (sep > 0) headers[kv.slice(0, sep).trim()] = kv.slice(sep + 1).trim()
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      try {
        const res = await fetch(url, { method, headers, body: bytes, signal: controller.signal })
        const text = await res.text()
        return {
          stdout: `HTTP ${res.status}\n` + (text ? text + (text.endsWith('\n') ? '' : '\n') : ''),
          stderr: '',
          exitCode: res.ok ? 0 : 1,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { stdout: '', stderr: `Request failed: ${msg}\n`, exitCode: 1 }
      } finally {
        clearTimeout(timer)
      }
    }),

    defineCommand('locate', async (args, ctx) => {
      const quiet = hasFlag(args, 'q') || args.includes('-q')
      const highlight = hasFlag(args, 'highlight')
      const selector = args.filter(a => !a.startsWith('-'))[0] || stdinTarget(ctx)

      if (!selector) {
        return { stdout: '', stderr: 'Usage: locate "selector" [-q] [--highlight]\n', exitCode: 1 }
      }

      await ensureSelectorLib(tabId)
      const result = await execInTab(tabId, (sel: string) => {
        let el: Element | null = null
        try { el = document.querySelector(sel) } catch { /* not a valid selector */ }

        // Reason: if not a valid CSS selector, search by text (same as click/type-text)
        if (!el) {
          const interactive = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], label, summary'
          const candidates = Array.from(document.querySelectorAll(interactive)) as HTMLElement[]
          const lower = sel.toLowerCase()
          el = candidates.find(c => {
            const text = (c.textContent ?? '').trim().toLowerCase()
            const aria = (c.getAttribute('aria-label') ?? '').toLowerCase()
            return text === lower || text.includes(lower) || aria.includes(lower)
          }) ?? null
        }

        if (!el) return { success: false, error: `Element not found: ${sel}` }

        el.scrollIntoView({ block: 'center', behavior: 'instant' })

        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const visible = rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && parseFloat(style.opacity) > 0

        // Reason: check if another element covers this one at its center
        const cx = rect.x + rect.width / 2
        const cy = rect.y + rect.height / 2
        const topEl = document.elementFromPoint(cx, cy)
        const obscured = topEl !== null && topEl !== el && !el.contains(topEl)

        // Reason: generate a unique selector for pipe output — prefer css-selector-generator.
        // Only reuse `sel` if it's a valid CSS selector that matched; text targets must be resolved.
        let isCssSelector = false
        try { isCssSelector = document.querySelector(sel) === el } catch { /* invalid selector */ }
        let outputSelector = isCssSelector ? sel : ''
        if (!outputSelector) {
          const lib = (self as unknown as Record<string, { getCssSelector: (el: Element) => string } | undefined>).CssSelectorGenerator
          if (lib) {
            try { outputSelector = lib.getCssSelector(el) } catch { /* generator failed, use fallback */ }
          }
          if (!outputSelector) {
            if (el.id) outputSelector = '#' + CSS.escape(el.id)
            else {
              const tag = el.tagName.toLowerCase()
              const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).map(c => CSS.escape(c)).join('.') : ''
              if (cls && document.querySelectorAll(tag + cls).length === 1) {
                outputSelector = tag + cls
              } else {
                const path: string[] = []
                let node: Element | null = el
                while (node && node !== document.body) {
                  const parent: Element | null = node.parentElement
                  if (!parent) break
                  const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === node!.tagName)
                  path.unshift(siblings.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})` : node.tagName.toLowerCase())
                  if (document.querySelectorAll(path.join(' > ')).length === 1) break
                  node = parent
                }
                outputSelector = path.join(' > ') || tag
              }
            }
          }
        }

        return {
          success: true,
          selector: outputSelector,
          visible,
          obscured,
          obscuredBy: obscured && topEl ? topEl.tagName.toLowerCase() + (topEl.className ? '.' + topEl.className.trim().split(/\s+/)[0] : '') : undefined,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      }, [selector]) as {
        success: boolean; error?: string; selector?: string; visible?: boolean;
        obscured?: boolean; obscuredBy?: string; x?: number; y?: number; width?: number; height?: number
      }

      if (!result.success) return { stdout: '', stderr: (result.error ?? 'Not found') + '\n', exitCode: 1 }

      // Pro mode highlight via CDP
      if (highlight) {
        try {
          if (debugSession.isAttached()) {
            const tabIdNum = tabId
            await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'DOM.enable')
            const doc = await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'DOM.getDocument', { depth: -1 }) as { root: { nodeId: number } }
            const q = await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: result.selector }) as { nodeId: number }
            if (q.nodeId) {
              await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'Overlay.enable')
              await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'Overlay.highlightNode', {
                nodeId: q.nodeId,
                highlightConfig: { contentColor: { r: 255, g: 165, b: 0, a: 0.3 }, borderColor: { r: 255, g: 140, b: 0, a: 0.8 } },
              })
              setTimeout(async () => {
                await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'Overlay.hideHighlight').catch(() => {})
                await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'Overlay.disable').catch(() => {})
                await chrome.debugger.sendCommand({ tabId: tabIdNum }, 'DOM.disable').catch(() => {})
              }, 2000)
            }
          }
        } catch { /* highlight is best-effort */ }
      }

      if (quiet) {
        return { stdout: result.selector + '\n', stderr: '', exitCode: 0 }
      }

      const lines = [
        result.selector,
        `Visible: ${result.visible}${result.obscured ? ` (obscured by ${result.obscuredBy})` : ''}`,
        `Position: (${result.x}, ${result.y}), Size: ${result.width}×${result.height}`,
      ]
      return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
    }),

    defineCommand('useSkill', async () => {
      return { stdout: '', stderr: 'useSkill is a native tool, not a bash command. Call the useSkill tool directly with {"name": "skill-name"}.\n', exitCode: 1 }
    }),

    defineCommand('skill', async (args, ctx) => {
      const sub = positional(args)[0]
      if (sub === 'list') {
        return { stdout: getSkillIndex([], currentMode) + '\n', stderr: '', exitCode: 0 }
      }
      if (sub === 'create') {
        const pos = positional(args)
        const name = pos[1]
        const description = pos[2]
        if (!name || !description) {
          return { stdout: '', stderr: 'Usage: skill create "name" "description" < content-file\n', exitCode: 1 }
        }
        const content = decodeStdin(ctx.stdin as unknown as string || '').trim()
        if (!content) {
          return { stdout: '', stderr: 'Error: skill content required via stdin. Example: cat /tmp/skill.md | skill create "name" "desc"\n', exitCode: 1 }
        }
        const result = await saveUserSkill(name, description, content)
        if (!result.ok) return { stdout: '', stderr: `Error: ${result.error}\n`, exitCode: 1 }
        // Reason: mount SKILL.md into current VFS so it's immediately visible
        const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`
        await ctx.fs.mkdir(`/skills/${name}`, { recursive: true })
        await ctx.fs.writeFile(`/skills/${name}/SKILL.md`, md)
        return { stdout: `Created skill: ${name}\n`, stderr: '', exitCode: 0 }
      }
      if (sub === 'remove') {
        const name = positional(args)[1]
        if (!name) {
          return { stdout: '', stderr: 'Usage: skill remove "name"\n', exitCode: 1 }
        }
        const ok = await removeUserSkill(name)
        if (!ok) return { stdout: '', stderr: `Error: "${name}" is a built-in skill or does not exist.\n`, exitCode: 1 }
        try { await ctx.fs.rm(`/skills/${name}`, { recursive: true }) } catch { /* best effort */ }
        return { stdout: `Removed skill: ${name}\n`, stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'Usage: skill list | skill create "name" "desc" | skill remove "name"\n', exitCode: 1 }
    }),

    defineCommand('memory', async (args, ctx) => {
      const sub = positional(args)[0]

      // Reason: entry-level verbs — add/replace/remove operate on single lines,
      // structurally preventing full-overwrite data loss.
      const ENTRY_VERBS = ['add', 'replace', 'remove']
      const refreshMemoryVfs = async (target: 'global' | 'site', hostname?: string) => {
        if (target === 'global') {
          onMemoryUpdate?.('/memory/global.md', await getGlobalMemory())
        } else if (hostname) {
          onMemoryUpdate?.('/memory/site.md', `[${hostname}]\n${await getSiteMemory(hostname)}`)
        }
      }
      const runEntryVerb = async (target: 'global' | 'site', hostname: string | undefined) => {
        const pos = positional(args)
        const verb = pos[1]
        const label = target === 'site' && hostname ? `site memory (${hostname})` : `${target} memory`
        if (verb === 'add') {
          const content = pos[2] ?? decodeStdin(ctx.stdin as unknown as string || '').trim()
          if (!content) return { stdout: '', stderr: `Usage: memory ${target} add "entry"\n`, exitCode: 1 }
          const r = await addMemoryEntry(target, hostname, content)
          if (!r.ok) return { stdout: '', stderr: `Error: ${r.error}\n`, exitCode: 1 }
          await refreshMemoryVfs(target, hostname)
          return { stdout: r.error ? `${r.error}\n` : `Entry added to ${label}.\n`, stderr: '', exitCode: 0 }
        }
        if (verb === 'replace') {
          const oldText = pos[2]
          const content = pos[3] ?? decodeStdin(ctx.stdin as unknown as string || '').trim()
          if (!oldText || !content) return { stdout: '', stderr: `Usage: memory ${target} replace "old substring" "new entry"\n`, exitCode: 1 }
          const r = await replaceMemoryEntry(target, hostname, oldText, content)
          if (!r.ok) return { stdout: '', stderr: `Error: ${r.error}\n`, exitCode: 1 }
          await refreshMemoryVfs(target, hostname)
          return { stdout: `Entry replaced in ${label}.\n`, stderr: '', exitCode: 0 }
        }
        // verb === 'remove'
        const oldText = pos[2] ?? decodeStdin(ctx.stdin as unknown as string || '').trim()
        if (!oldText) return { stdout: '', stderr: `Usage: memory ${target} remove "substring"\n`, exitCode: 1 }
        const r = await removeMemoryEntry(target, hostname, oldText)
        if (!r.ok) return { stdout: '', stderr: `Error: ${r.error}\n`, exitCode: 1 }
        await refreshMemoryVfs(target, hostname)
        return { stdout: `Removed entry: ${r.removed}\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'global') {
        const second = positional(args)[1]
        if (second && ENTRY_VERBS.includes(second)) return runEntryVerb('global', undefined)
        const content = second ?? decodeStdin(ctx.stdin as unknown as string || '').trim()
        if (!content) {
          const mem = await getGlobalMemory()
          return { stdout: mem ? mem + '\n' : '(empty)\n', stderr: '', exitCode: 0 }
        }
        const result = await setGlobalMemory(content)
        if (!result.ok) return { stdout: '', stderr: `Error: ${result.error}\n`, exitCode: 1 }
        onMemoryUpdate?.('/memory/global.md', content)
        return { stdout: 'Global memory updated.\n', stderr: '', exitCode: 0 }
      }

      if (sub === 'site') {
        let hostname = ''
        try { const tab = await chrome.tabs.get(tabId); hostname = tab.url ? new URL(tab.url).hostname : '' } catch { /* tab closed */ }
        if (!hostname || !hostname.includes('.')) return { stdout: '', stderr: 'Error: cannot determine current site hostname.\n', exitCode: 1 }
        const second = positional(args)[1]
        if (second && ENTRY_VERBS.includes(second)) return runEntryVerb('site', hostname)
        const content = second ?? decodeStdin(ctx.stdin as unknown as string || '').trim()
        if (!content) {
          const mem = await getSiteMemory(hostname)
          return { stdout: mem ? `[${hostname}]\n${mem}\n` : `(no memory for ${hostname})\n`, stderr: '', exitCode: 0 }
        }
        const result = await setSiteMemory(hostname, content)
        if (!result.ok) return { stdout: '', stderr: `Error: ${result.error}\n`, exitCode: 1 }
        onMemoryUpdate?.('/memory/site.md', `[${hostname}]\n${content}`)
        return { stdout: `Site memory updated for ${hostname}.\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'add') {
        const content = positional(args)[1] ?? decodeStdin(ctx.stdin as unknown as string || '').trim()
        if (!content) return { stdout: '', stderr: 'Usage: memory add "content"\n', exitCode: 1 }
        const entry = await addNote(content)
        if ('error' in entry) return { stdout: '', stderr: `Error: ${entry.error}\n`, exitCode: 1 }
        const allNotes = await getNotes()
        onMemoryUpdate?.('/memory/notes.jsonl', allNotes.map(n => JSON.stringify(n)).join('\n'))
        return { stdout: `Added note ${entry.id}: ${content.slice(0, 60)}\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'search') {
        const keyword = positional(args)[1]
        if (!keyword) return { stdout: '', stderr: 'Usage: memory search "keyword"\n', exitCode: 1 }
        const results = await searchNotes(keyword)
        if (!results.length) return { stdout: `No notes matching "${keyword}"\n`, stderr: '', exitCode: 0 }
        const lines = results.map(n => {
          const date = new Date(n.ts).toISOString().slice(0, 10)
          return `[${date}] ${n.id}: ${n.content}`
        })
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
      }

      if (sub === 'remove') {
        const id = positional(args)[1]
        if (!id) return { stdout: '', stderr: 'Usage: memory remove <id>\n', exitCode: 1 }
        const ok = await removeNote(id)
        if (!ok) return { stdout: '', stderr: `Note "${id}" not found.\n`, exitCode: 1 }
        const remaining = await getNotes()
        onMemoryUpdate?.('/memory/notes.jsonl', remaining.length ? remaining.map(n => JSON.stringify(n)).join('\n') : '')
        return { stdout: `Removed note ${id}.\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'list') {
        const notes = await getNotes()
        if (!notes.length) return { stdout: '(no notes)\n', stderr: '', exitCode: 0 }
        const lines = notes.sort((a, b) => b.ts - a.ts).map(n => {
          const date = new Date(n.ts).toISOString().slice(0, 10)
          return `[${date}] ${n.id}: ${n.content}`
        })
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
      }

      return { stdout: '', stderr: 'Usage: memory global|site|add|search|remove|list\n  memory global                         — show global entries (one per line)\n  memory global add "entry"             — append one compact entry\n  memory global replace "old" "new"     — update entry matching substring\n  memory global remove "old"            — delete entry matching substring\n  memory global "full text"             — overwrite all (prefer add/replace/remove)\n  memory site [add|replace|remove] ...  — same verbs for current site\n  memory add "content"                  — append a note\n  memory search "keyword"               — search notes\n  memory remove <id>                    — delete a note\n  memory list                           — list all notes\n', exitCode: 1 }
    }),

    defineCommand('todo', async (args, ctx) => {
      const sub = positional(args)[0]
      const TODO_PATH = '/todo.json'

      async function readTodos(): Promise<Array<{ id: number; text: string; status: string }>> {
        try { return JSON.parse(await ctx.fs.readFile(TODO_PATH)) } catch { return [] }
      }
      async function writeTodos(todos: Array<{ id: number; text: string; status: string }>) {
        await ctx.fs.writeFile(TODO_PATH, JSON.stringify(todos))
        // Reason: notify sidepanel for pill UI updates
        try { chrome.runtime.sendMessage({ type: 'todo:changed', items: todos }).catch(() => {}) } catch { /* ignore */ }
      }

      if (sub === 'add') {
        const text = positional(args).slice(1).join(' ') || decodeStdin(ctx.stdin as unknown as string || '').trim()
        if (!text) return { stdout: '', stderr: 'Usage: todo add "task description"\n', exitCode: 1 }
        const todos = await readTodos()
        const id = todos.length > 0 ? Math.max(...todos.map(t => t.id)) + 1 : 1
        todos.push({ id, text, status: 'pending' })
        await writeTodos(todos)
        return { stdout: `Added #${id}: ${text}\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'done') {
        const idStr = positional(args)[1]
        if (!idStr) return { stdout: '', stderr: 'Usage: todo done <id>\n', exitCode: 1 }
        const todos = await readTodos()
        const task = todos.find(t => t.id === parseInt(idStr, 10))
        if (!task) return { stdout: '', stderr: `Task #${idStr} not found.\n`, exitCode: 1 }
        task.status = 'completed'
        await writeTodos(todos)
        const done = todos.filter(t => t.status === 'completed').length
        return { stdout: `✓ #${task.id}: ${task.text} (${done}/${todos.length} done)\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'start') {
        const idStr = positional(args)[1]
        if (!idStr) return { stdout: '', stderr: 'Usage: todo start <id>\n', exitCode: 1 }
        const todos = await readTodos()
        const task = todos.find(t => t.id === parseInt(idStr, 10))
        if (!task) return { stdout: '', stderr: `Task #${idStr} not found.\n`, exitCode: 1 }
        task.status = 'in_progress'
        await writeTodos(todos)
        return { stdout: `▶ #${task.id}: ${task.text}\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'remove') {
        const idStr = positional(args)[1]
        if (!idStr) return { stdout: '', stderr: 'Usage: todo remove <id>\n', exitCode: 1 }
        const todos = await readTodos()
        const filtered = todos.filter(t => t.id !== parseInt(idStr, 10))
        if (filtered.length === todos.length) return { stdout: '', stderr: `Task #${idStr} not found.\n`, exitCode: 1 }
        await writeTodos(filtered)
        return { stdout: `Removed #${idStr}.\n`, stderr: '', exitCode: 0 }
      }

      if (sub === 'list' || !sub) {
        const todos = await readTodos()
        if (!todos.length) return { stdout: '(no tasks)\n', stderr: '', exitCode: 0 }
        const icons: Record<string, string> = { completed: '✓', in_progress: '▶', pending: '○' }
        const lines = todos.map(t => `${icons[t.status] || '○'} #${t.id} ${t.text}`)
        const done = todos.filter(t => t.status === 'completed').length
        lines.push(`\n${done}/${todos.length} completed`)
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
      }

      if (sub === 'clear') {
        await writeTodos([])
        return { stdout: 'All tasks cleared.\n', stderr: '', exitCode: 0 }
      }

      return { stdout: '', stderr: 'Usage: todo add|done|start|remove|list|clear\n  todo add "description"  — add a task\n  todo start <id>         — mark in progress\n  todo done <id>          — mark completed\n  todo remove <id>        — delete a task\n  todo list               — show all tasks\n  todo clear              — remove all tasks\n', exitCode: 1 }
    }),

  ]
}
