import { useState, useEffect, useCallback, useRef } from 'react'
import { Icon } from '@iconify/react'
import { convertToModelMessages } from 'ai'
import {
  iconProTerminal, iconRefresh, iconChevronRight, iconChevronDown, iconImport, iconAlertCircleOutline,
} from '../../shared/icons'
import { loadSessionIndex } from '../../shared/storage'
import { formatSize, findArchiveCutoff } from '../../shared/format'
import { agentTools } from '../../shared/tools'
import { sessionSnapshotRef, ARCHIVE_KEEP_TURNS } from '../hooks/useSidekickChat'
import type { ChatSession } from '../../shared/types'

interface FileEntry {
  path: string
  size: number
  readonly?: boolean
  ephemeral?: boolean
}

interface TermLine {
  type: 'input' | 'stdout' | 'stderr' | 'meta'
  text: string
}

interface Props {
  tabId: number | null
}

// Reason: markers injected by the context management layers — highlighted so
// mechanism health is visible at a glance.
const CONTEXT_MARKERS = ['[archived:', '[Context Compacted]', '[step-budget]', '[todo-reminder]', '[page:', '[debug-status:']

interface InspectorEntry {
  role: string
  content: string
  markers: string[]
}

interface InspectorData {
  craton: { text: string; builtAt: number } | null
  messages: InspectorEntry[]
  orogenLines: string[]
  error?: string
}

function findMarkers(content: string): string[] {
  return CONTEXT_MARKERS.filter(m => content.includes(m))
}

// Reason: mirror of the real pipeline — prepareOutgoingMessages (shared fn via
// sessionSnapshotRef) + convertToModelMessages (same SDK call as
// DirectChatTransport) + frozen craton + orogen preview from the same builder
// prepareCall uses. What you see is what the next turn sends.
async function buildInspectorData(): Promise<InspectorData | null> {
  const getter = sessionSnapshotRef.current
  if (!getter) return null
  const snap = getter()
  let craton: { instructions: string; builtAt: number } | null
  try {
    craton = await snap.getCraton()
  } catch (e) {
    return {
      craton: null,
      messages: [],
      orogenLines: snap.orogenLines,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  const cratonData = craton ? { text: craton.instructions, builtAt: craton.builtAt } : null
  try {
    const modelMessages = await convertToModelMessages(snap.outgoing, { tools: agentTools })
    const messages: InspectorEntry[] = (modelMessages as Array<{ role: string; content: unknown }>).map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)
      return { role: m.role, content, markers: findMarkers(content) }
    })
    return {
      craton: cratonData,
      messages,
      orogenLines: snap.orogenLines,
    }
  } catch (e) {
    return {
      craton: cratonData,
      messages: [],
      orogenLines: snap.orogenLines,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

const estTokens = (chars: number) => Math.ceil(chars / 3)

// Reason: tool messages serialize to JSON noise ("[{\"type\":\"tool-call\"...") —
// surface tool names first so rows are scannable; full content stays in expand.
function previewOf(content: string): string {
  const tools = [...content.matchAll(/"toolName":\s*"([^"]+)"/g)].map(m => m[1])
  const head = content.slice(0, 80).replace(/\s+/g, ' ')
  return tools.length ? `${[...new Set(tools)].join(', ')} · ${head}` : head
}

export default function DevView({ tabId }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [termHistory, setTermHistory] = useState<TermLine[]>([])
  const [cmdInput, setCmdInput] = useState('')
  const [executing, setExecuting] = useState(false)
  // Reason: shell-style ↑/↓ command recall — index counts back from the end
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['/']))
  const [showInspector, setShowInspector] = useState(false)
  const [inspector, setInspector] = useState<InspectorData | null>(null)
  const [expandedMsgIdx, setExpandedMsgIdx] = useState<number | null>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadSessionIndex().then(s => {
      const sorted = s.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      setSessions(sorted)
      if (sorted.length > 0 && !sessionId) setSessionId(sorted[0].id)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshFiles = useCallback(async () => {
    if (!sessionId) return
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'dev:ls', sessionId })
      if (resp?.success && resp.files) {
        const entries: FileEntry[] = Object.entries(resp.files)
          .map(([path, val]) => {
            if (typeof val === 'object' && val !== null) {
              const v = val as { size: number; readonly?: boolean; ephemeral?: boolean }
              return { path, size: v.size, readonly: v.readonly, ephemeral: v.ephemeral }
            }
            return { path, size: val as number }
          })
          .sort((a, b) => a.path.localeCompare(b.path))
        setFiles(entries)
      }
    } catch { /* ignore */ }
  }, [sessionId])

  useEffect(() => { refreshFiles() }, [refreshFiles])

  const handleCatFile = useCallback(async (path: string) => {
    if (!sessionId) return
    setSelectedFile(path)
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'dev:cat', sessionId, path })
      setFileContent(resp?.success ? resp.content : `Error: ${resp?.error ?? 'unknown'}`)
    } catch (e) {
      setFileContent(`Error: ${e}`)
    }
  }, [sessionId])

  const handleExec = useCallback(async () => {
    const cmd = cmdInput.trim()
    if (!cmd || !sessionId || !tabId) return
    setCmdInput('')
    setCmdHistory(prev => prev[prev.length - 1] === cmd ? prev : [...prev, cmd])
    setHistIdx(-1)
    if (cmd === 'clear') { setTermHistory([]); return }
    setExecuting(true)
    setTermHistory(prev => [...prev, { type: 'input', text: cmd }])

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'dev:exec', sessionId, tabId, command: cmd })
      if (resp?.stdout) setTermHistory(prev => [...prev, { type: 'stdout', text: resp.stdout }])
      if (resp?.stderr) setTermHistory(prev => [...prev, { type: 'stderr', text: resp.stderr }])
      if (resp?.exitCode) setTermHistory(prev => [...prev, { type: 'meta', text: `exit ${resp.exitCode}` }])
    } catch (e) {
      setTermHistory(prev => [...prev, { type: 'stderr', text: String(e) }])
    }
    setExecuting(false)
    refreshFiles()
    setTimeout(() => {
      termRef.current?.scrollTo({ top: termRef.current.scrollHeight })
      inputRef.current?.focus()
    }, 50)
  }, [cmdInput, sessionId, tabId, refreshFiles])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleExec()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (cmdHistory.length === 0) return
      const next = histIdx < 0 ? cmdHistory.length - 1 : Math.max(histIdx - 1, 0)
      setHistIdx(next)
      setCmdInput(cmdHistory[next])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx < 0) return
      const next = histIdx + 1
      if (next >= cmdHistory.length) { setHistIdx(-1); setCmdInput('') }
      else { setHistIdx(next); setCmdInput(cmdHistory[next]) }
    }
  }, [handleExec, cmdHistory, histIdx])

  const toggleDir = (dir: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

  // Group files by directory
  const dirTree = buildDirTree(files)

  // Reason: layer-level token attribution mirroring the geological model —
  // craton (frozen prompt) / terrane (history past the archive cutoff, stable)
  // / wedge (last K user turns, hot) / orogen (per-turn tail injection).
  const wedgeStart = inspector ? findArchiveCutoff(inspector.messages.map(m => m.role), ARCHIVE_KEEP_TURNS) : -1
  const cratonTok = estTokens(inspector?.craton?.text.length ?? 0)
  const terraneTok = inspector?.messages.slice(0, Math.max(wedgeStart, 0)).reduce((s, m) => s + estTokens(m.content.length), 0) ?? 0
  const historyTok = inspector?.messages.reduce((s, m) => s + estTokens(m.content.length), 0) ?? 0
  const wedgeTok = historyTok - terraneTok
  const orogenTok = estTokens(inspector ? inspector.orogenLines.join('\n').length : 0)
  const totalTok = cratonTok + historyTok + orogenTok
  const layers = [
    { name: 'craton', tok: cratonTok, cls: 'bg-accent/60', dot: 'bg-accent/70' },
    { name: 'terrane', tok: terraneTok, cls: 'bg-text-muted/30', dot: 'bg-text-muted/50' },
    { name: 'wedge', tok: wedgeTok, cls: 'bg-amber-400/40', dot: 'bg-amber-400/60' },
    { name: 'orogen', tok: orogenTok, cls: 'bg-teal-400/50', dot: 'bg-teal-400/60' },
  ]

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        No active session
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      {/* Status bar */}
      <div className="flex items-center gap-3 border-b border-border-muted px-3 py-1.5">
        <select
          value={sessionId ?? ''}
          onChange={e => { setSessionId(e.target.value); setFiles([]); setSelectedFile(null); setFileContent(null) }}
          className="max-w-[140px] rounded-md border border-border-muted bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-secondary outline-none transition-colors hover:border-border"
        >
          {sessions.map(s => (
            <option key={s.id} value={s.id}>{s.title || s.id.slice(0, 8)}</option>
          ))}
        </select>
        <span className="text-[10px] text-text-muted">
          {files.length} files{files.some(f => f.readonly) ? ` (${files.filter(f => f.readonly).length} mounted)` : ''}{files.some(f => f.ephemeral) ? ` (${files.filter(f => f.ephemeral).length} ephemeral)` : ''} · {formatSize(files.reduce((s, f) => s + f.size, 0))}
        </span>
        <button
          onClick={() => {
            const next = !showInspector
            setShowInspector(next)
            if (next) buildInspectorData().then(setInspector)
          }}
          className={`ml-auto rounded-md px-1.5 py-0.5 text-[10px] transition-colors ${showInspector ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface-raised hover:text-text-secondary'}`}
        >
          Session
        </button>
        <button
          onClick={() => { if (showInspector) { buildInspectorData().then(setInspector) } else { refreshFiles() } }}
          className="rounded-md p-0.5 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-secondary"
          title="Refresh"
        >
          <Icon icon={iconRefresh} className="text-xs" />
        </button>
      </div>

      {/* Session Inspector — what the next turn will send (craton + history + orogen) */}
      {showInspector && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-b border-border-muted p-3">
          {inspector ? (
            <>
              <div className="mb-1 flex items-baseline gap-2 text-[10px] text-text-muted">
                <span className="font-medium text-text-secondary">Next-turn payload</span>
                <span>{inspector.messages.length} msgs</span>
                <span className="ml-auto">≈{totalTok} tok</span>
              </div>
              <div className="mb-1.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-surface-overlay">
                {layers.map(l => l.tok > 0 && (
                  <div key={l.name} className={l.cls} style={{ width: `${totalTok ? (l.tok / totalTok) * 100 : 0}%` }} title={`${l.name} ~${l.tok} tok`} />
                ))}
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[9px] tabular-nums text-text-muted">
                {layers.map(l => (
                  <span key={l.name} className="flex items-center gap-1">
                    <span className={`h-1.5 w-1.5 rounded-full ${l.dot}`} />
                    {l.name} ~{l.tok}
                  </span>
                ))}
              </div>
              {inspector.error && (
                <div className="mb-2 rounded-sm bg-error/10 p-2 text-[10px] text-error">convert failed: {inspector.error}</div>
              )}
              <div className="mb-1 border-l-2 border-accent/40 pl-1.5">
                <button onClick={() => setExpandedMsgIdx(expandedMsgIdx === -1 ? null : -1)} className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[10px] transition-colors hover:bg-surface-raised">
                  <Icon icon={expandedMsgIdx === -1 ? iconChevronDown : iconChevronRight} className="shrink-0 text-[9px] text-text-muted" />
                  <span className="shrink-0 rounded-sm bg-accent/15 px-1 py-px text-[9px] font-medium text-accent">craton</span>
                  <span className="truncate text-text-muted">
                    {inspector.craton ? `frozen ${new Date(inspector.craton.builtAt).toLocaleTimeString()}` : 'not built yet — send a message first'}
                  </span>
                  {inspector.craton && <span className="ml-auto shrink-0 text-[9px] text-text-muted">~{estTokens(inspector.craton.text.length)} tok</span>}
                </button>
                {expandedMsgIdx === -1 && inspector.craton && (
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border-muted/50 bg-surface-overlay p-2 font-mono text-[10px] leading-relaxed text-text-secondary">{inspector.craton.text}</pre>
                )}
              </div>
              <div className="flex flex-col">
                {inspector.messages.map((msg, i) => {
                  const preview = previewOf(msg.content)
                  const tok = estTokens(msg.content.length)
                  const pct = totalTok ? Math.max(1, Math.round(tok / totalTok * 100)) : 0
                  // Reason: stratigraphic column — continuous left rails color-code
                  // each message by layer (terrane settled / wedge hot).
                  const rail = wedgeStart > 0 && i < wedgeStart ? 'border-text-muted/20' : 'border-amber-400/30'
                  return (
                    <div key={i} className={`border-l-2 pl-1.5 ${rail}`}>
                      {i === wedgeStart && (
                        <div className="-ml-1.5 my-1 flex items-center gap-1.5 text-[9px] text-amber-400/70">
                          <span className="h-px flex-1 bg-amber-400/25" />
                          wedge boundary · last {ARCHIVE_KEEP_TURNS} user turns kept intact
                          <span className="h-px flex-1 bg-amber-400/25" />
                        </div>
                      )}
                      <button onClick={() => setExpandedMsgIdx(expandedMsgIdx === i ? null : i)} className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[10px] transition-colors hover:bg-surface-raised">
                        <Icon icon={expandedMsgIdx === i ? iconChevronDown : iconChevronRight} className="shrink-0 text-[9px] text-text-muted" />
                        <span className="w-4 shrink-0 text-right font-mono text-[9px] text-text-muted/50">{i}</span>
                        <span className={`shrink-0 rounded-sm px-1 py-px text-[9px] font-medium ${msg.role === 'user' ? 'bg-blue-500/15 text-blue-400' : msg.role === 'assistant' ? 'bg-green-500/15 text-green-400' : 'bg-orange-500/15 text-orange-400'}`}>{msg.role}</span>
                        {msg.markers.map(m => (
                          <span key={m} className="shrink-0 rounded-sm bg-amber-500/15 px-1 py-px text-[9px] text-amber-400">{m.replace(/[[\]:]/g, '')}</span>
                        ))}
                        <span className="truncate text-text-muted">{preview}</span>
                        <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-text-muted">~{tok}t·{pct}%</span>
                      </button>
                      {expandedMsgIdx === i && (
                        <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border-muted/50 bg-surface-overlay p-2 font-mono text-[10px] leading-relaxed text-text-secondary">{msg.content}</pre>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-2 border-l-2 border-teal-400/30 pl-1.5">
                <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px]">
                  <span className="rounded-sm bg-teal-500/15 px-1 py-px text-[9px] font-medium text-teal-400">orogen</span>
                  <span className="text-text-muted">appended to the next user message</span>
                </div>
                <pre className="whitespace-pre-wrap rounded-md border border-border-muted/50 bg-surface-overlay p-2 font-mono text-[10px] leading-relaxed text-text-secondary">{inspector.orogenLines.join('\n')}</pre>
              </div>
            </>
          ) : (
            <p className="text-[10px] text-text-muted">Chat session not initialized yet.</p>
          )}
        </div>
      )}

      {/* File tree + preview */}
      {!showInspector && <><div className="flex min-h-0 flex-1 flex-col border-b border-border-muted">
        <div className="flex min-h-0 flex-1">
          {/* Tree */}
          <div className="w-1/2 overflow-y-auto border-r border-border-muted p-2">
            {dirTree.map(node => (
              <DirNode
                key={node.path}
                node={node}
                expanded={expandedDirs}
                onToggle={toggleDir}
                onSelect={handleCatFile}
                selectedFile={selectedFile}
              />
            ))}
          </div>
          {/* Preview */}
          <div className="flex w-1/2 flex-col overflow-hidden">
            {selectedFile ? (
              <>
                <p className="shrink-0 truncate border-b border-border-muted/60 px-2 py-1 font-mono text-[10px] text-text-muted">{selectedFile}</p>
                {/* Reason: App root sets select-none for the chat surface; file
                    contents in the inspector are data the user needs to copy. */}
                <pre className="flex-1 overflow-y-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-relaxed text-text-secondary select-text">
                  {fileContent ?? 'Loading...'}
                </pre>
              </>
            ) : (
              <p className="flex h-full items-center justify-center text-[11px] text-text-muted/70">Select a file</p>
            )}
          </div>
        </div>
      </div>

      {/* Terminal — inline prompt, shell-style history recall */}
      <div className="flex min-h-[140px] flex-1 flex-col">
        <div className="flex items-center gap-1.5 border-b border-border-muted px-3 py-1.5">
          <Icon icon={iconProTerminal} className="text-xs text-text-muted" />
          <span className="font-mono text-[10px] text-text-muted">just-bash — {sessions.find(s => s.id === sessionId)?.title?.slice(0, 24) || sessionId.slice(0, 8)}</span>
          <button onClick={() => setTermHistory([])} className="ml-auto rounded-md px-1 py-px font-mono text-[9px] text-text-muted/60 transition-colors hover:bg-surface-raised hover:text-text-secondary" title="clear">clear</button>
        </div>
        <div
          ref={termRef}
          className="flex-1 cursor-text overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
          onClick={() => inputRef.current?.focus()}
        >
          {termHistory.map((line, i) => (
            line.type === 'input' ? (
              <div key={i} className="flex gap-1.5 text-text-primary">
                <span className="shrink-0 text-accent">❯</span>
                <pre className="whitespace-pre-wrap">{line.text}</pre>
              </div>
            ) : (
              <pre key={i} className={`whitespace-pre-wrap ${
                line.type === 'stderr' ? 'text-error/80' :
                line.type === 'meta' ? 'text-text-muted/70' :
                'text-text-secondary'
              }`}>{line.text}</pre>
            )
          ))}
          {/* Inline prompt — lives in the output flow like a real shell */}
          <div className="flex items-center gap-1.5">
            <span className={`shrink-0 ${executing ? 'text-text-muted/50' : 'text-accent'}`}>❯</span>
            <input
              ref={inputRef}
              value={cmdInput}
              onChange={e => { setCmdInput(e.target.value); setHistIdx(-1) }}
              onKeyDown={handleKeyDown}
              disabled={executing || !sessionId}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-transparent font-mono text-[11px] text-text-primary caret-accent outline-none placeholder:text-text-muted/50 disabled:opacity-50"
              placeholder={executing ? 'running…' : ''}
            />
          </div>
        </div>
      </div></>}
    </div>
  )
}

// --- Directory tree helpers ---

interface TreeNode {
  path: string
  name: string
  isDir: boolean
  size?: number
  readonly?: boolean
  ephemeral?: boolean
  children?: TreeNode[]
}

function buildDirTree(files: FileEntry[]): TreeNode[] {
  const dirs = new Map<string, TreeNode>()

  // Ensure root dirs exist
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean)
    let current = ''
    for (let i = 0; i < parts.length - 1; i++) {
      current += '/' + parts[i]
      if (!dirs.has(current)) {
        dirs.set(current, { path: current, name: parts[i], isDir: true, children: [] })
      }
    }
  }

  const roots: TreeNode[] = []
  const allNodes = new Map<string, TreeNode>()

  // Create dir nodes
  for (const [path, node] of dirs) {
    allNodes.set(path, node)
  }

  // Add file nodes
  for (const f of files) {
    const name = f.path.split('/').pop() ?? f.path
    if (name === '.keep') continue
    allNodes.set(f.path, { path: f.path, name, isDir: false, size: f.size, readonly: f.readonly, ephemeral: f.ephemeral })
    // Propagate readonly/ephemeral to parent dirs
    if (f.readonly || f.ephemeral) {
      const parts = f.path.split('/').filter(Boolean)
      let cur = ''
      for (let i = 0; i < parts.length - 1; i++) {
        cur += '/' + parts[i]
        const dir = allNodes.get(cur)
        if (dir) {
          if (f.readonly) dir.readonly = true
          if (f.ephemeral) dir.ephemeral = true
        }
      }
    }
  }

  // Build hierarchy
  for (const [path, node] of allNodes) {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/'
    if (parentPath === '' || parentPath === path) {
      roots.push(node)
    } else {
      const parent = allNodes.get(parentPath) ?? dirs.get(parentPath)
      if (parent?.children) parent.children.push(node)
      else roots.push(node)
    }
  }

  return roots.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1
    if (!a.isDir && b.isDir) return 1
    return a.name.localeCompare(b.name)
  })
}

function DirNode({ node, expanded, onToggle, onSelect, selectedFile, depth = 0 }: {
  node: TreeNode
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  selectedFile: string | null
  depth?: number
}) {
  const isOpen = expanded.has(node.path)

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => onToggle(node.path)}
          className={`flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-surface-raised ${node.ephemeral ? 'text-amber-400/70' : node.readonly ? 'text-text-muted/60' : 'text-text-secondary'}`}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <Icon icon={isOpen ? iconChevronDown : iconChevronRight} className="text-[10px] text-text-muted" />
          <span className="font-medium">{node.name}/</span>
          {node.ephemeral && <span title="Not persisted — use skill create to register"><Icon icon={iconAlertCircleOutline} className="text-[9px] text-amber-400/60" /></span>}
          {node.readonly && !node.ephemeral && <Icon icon={iconImport} className="text-[9px] text-text-muted/40" />}
        </button>
        {isOpen && node.children?.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1
          if (!a.isDir && b.isDir) return 1
          return a.name.localeCompare(b.name)
        }).map(child => (
          <DirNode
            key={child.path}
            node={child}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedFile={selectedFile}
            depth={depth + 1}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex w-full items-center justify-between rounded-md px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-surface-raised ${
        selectedFile === node.path ? 'bg-accent-wash text-accent' : node.ephemeral ? 'text-amber-400/70' : node.readonly ? 'text-text-muted/60' : 'text-text-secondary'
      }`}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      <span className="flex items-center gap-1 truncate">
        {node.name}
        {node.ephemeral && <span title="Not persisted"><Icon icon={iconAlertCircleOutline} className="text-[9px] text-amber-400/60" /></span>}
        {node.readonly && !node.ephemeral && <Icon icon={iconImport} className="text-[9px] text-text-muted/40" />}
      </span>
      {node.size != null && node.size > 0 && (
        <span className="ml-2 shrink-0 text-[9px] text-text-muted">{formatSize(node.size)}</span>
      )}
    </button>
  )
}
