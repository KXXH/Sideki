import { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore } from 'react'
import { DirectChatTransport, type ChatTransport, type UIMessage } from 'ai'
import { loadConfig, loadSessionIndex, loadSession, saveSession, updateSessionMeta, deleteSession } from '../../shared/storage'
import { mirrorAttachments, prepareFileAttachments } from '../../shared/attachment-mirror'
import { setActiveSessionId, peekOperatingTabId, acquireTurnTab } from '../../shared/tools/bridge'
import { dynamicTool, jsonSchema } from 'ai'
import { createAgent, buildOrogenLines, cratonRef } from '../../shared/agent'
import type { CratonSnapshot, DebugStatus } from '../../shared/agent'
import { prepareOutgoingMessages, visibleText, buildUserParts, savedFileParts, type SkillPartData, type SidekickMetadata } from '../../shared/message-protocol'
import type { McpToolMeta } from '../../shared/mcp-client'
import { agentFingerprint } from '../../shared/agent-fingerprint'
import { generateTitle } from '../../shared/ai-provider'
import type { ApiConfig, PageContent, ChatSession, ElementAttachment } from '../../shared/types'
import { SidekickKernel, KernelChat, COMPACT_MSG_ID, ARCHIVE_KEEP_TURNS, type SendItem } from '../../shared/kernel/chat-kernel'
import { useKernelMirror } from './useKernelMirror'
import { parseTurnNotificationId, extractTurnSnippet } from '../../shared/turn-notify'
import { planTabSessionSwitch } from '../utils/tab-session-plan'

// Reason: legacy import surface — ChatView/DevView/QueueStrip import these
// from the hook; the source of truth moved into the kernel module.
export { COMPACT_MSG_ID, ARCHIVE_KEEP_TURNS }
export type QueuedMessage = SendItem

// Reason: panel-hosted kernel (Phase 0 of the kernel extraction). performSend
// delegates to a swappable closure so the hook wires page-context prep and
// the live transport without a per-render subclass.
class PanelKernel extends SidekickKernel {
  sendFn: (item: SendItem) => Promise<void> = async () => { throw new Error('kernel send not wired') }
  protected override performSend(item: SendItem): Promise<void> {
    return this.sendFn(item)
  }
  markPreparing(v: boolean): void {
    this.setPreparing(v)
  }
}

// Reason: replaces useChat's experimental_throttle — without it, each
// streaming token notification triggers a synchronous re-render, which can
// exceed React's max update depth (#185). Leading + trailing so the final
// state always lands.
function throttleNotify(fn: () => void, ms: number): () => void {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    const remaining = ms - (Date.now() - last)
    if (remaining <= 0) {
      last = Date.now()
      fn()
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn() }, remaining)
    }
  }
}

function createSession(pageUrl?: string, mode?: 'chat' | 'pro'): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: 'New Chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pageUrl,
    mode: mode ?? 'chat',
    messages: [],
    messageCount: 0,
  }
}

// Reason: storage may contain old ChatMessage format (no id, different part types)
// or new UIMessage format — detect and migrate on read
function migrateMessage(msg: Record<string, unknown>): UIMessage {
  if (typeof msg.id === 'string' && msg.id) return msg as unknown as UIMessage

  const id = crypto.randomUUID()
  const role = (msg.role as string) || 'user'
  const oldParts = (msg.parts as Array<Record<string, unknown>>) || []
  const parts: UIMessage['parts'] = []

  for (const p of oldParts) {
    switch (p.type) {
      case 'text':
        parts.push({ type: 'text', text: (p.text as string) || '' })
        break
      case 'image':
        parts.push({ type: 'file', mediaType: 'image/jpeg', url: (p.image as string) || '' })
        break
      case 'reasoning':
        parts.push({ type: 'reasoning', text: (p.text as string) || '' })
        break
      case 'tool-call':
        parts.push({
          type: 'dynamic-tool',
          toolName: (p.toolName as string) || 'unknown',
          toolCallId: (p.toolCallId as string) || crypto.randomUUID(),
          state: p.status === 'error' ? 'output-error' : p.status === 'done' ? 'output-available' : 'input-available',
          input: p.input,
          ...(p.status === 'done' ? { output: p.output } : {}),
          ...(p.status === 'error' ? { errorText: (p.error as string) || 'Unknown error' } : {}),
        } as UIMessage['parts'][number])
        break
      default:
        if (typeof p.text === 'string') parts.push({ type: 'text', text: p.text })
    }
  }

  return { id, role: role as 'user' | 'assistant', parts } as UIMessage
}

function sessionMessages(s: ChatSession): UIMessage[] {
  if (!s.messages?.length) return []
  return (s.messages as Array<Record<string, unknown>>).map(migrateMessage)
}

const CHARS_PER_TOKEN = 3
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

const TOOL_SCHEMA_OVERHEAD = 1200

// Reason: module-level getter for the Dev panel session inspector — DevView is
// a sibling of ChatView (no prop path), and ChatView stays mounted (App keeps
// it hidden, not unmounted), so the closure stays live. Returns exactly what
// the next turn will send besides the new user message.
export interface SessionSnapshot {
  sessionId: string
  proMode: boolean
  outgoing: UIMessage[]
  orogenLines: string[]
  getCraton(): Promise<CratonSnapshot | null>
}
export const sessionSnapshotRef: { current: (() => SessionSnapshot) | null } = { current: null }

export function useSidekickChat(
  pageInfo: { title: string; url: string } | null,
  pageContent: PageContent | null,
  activeTabId: number | null,
  extractContent: () => Promise<PageContent>,
  proMode: boolean,
  contextLocked = false,
  kernelHost: 'panel' | 'offscreen' = 'panel',
) {
  // Reason: host switch — 'offscreen' turns this hook into a thin mirror of
  // the offscreen kernel; all panel-hosted side effects below are gated on
  // mirrorActive so the two runtimes never double-write storage.
  const mirrorActive = kernelHost === 'offscreen'
  const { mirror, extras: mirrorExtras, connected: mirrorConnected, cmd, request: mirrorRequest, captureSendTarget, whenReady } = useKernelMirror(mirrorActive)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState('')
  const [config, setConfig] = useState<ApiConfig | null>(null)
  const [contextLoaded, setContextLoaded] = useState(false)
  const [contextWindow, setContextWindow] = useState(0)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tabSessionMap = useRef<Map<number, string>>(new Map())
  const currentTabId = useRef<number | null>(null)
  const pageContextRef = useRef<PageContent | null>(pageContent)
  const pageImagesRef = useRef<string[]>([])
  const pageContextLocked = useRef(false)
  const debugStatusRef = useRef<DebugStatus | null>(null)

  const configRef = useRef(config)
  configRef.current = config
  const sessionIdRef = useRef(activeId)
  sessionIdRef.current = activeId
  const hostnameRef = useRef('')
  hostnameRef.current = pageInfo?.url ? (() => { try { return new URL(pageInfo.url).hostname } catch { return '' } })() : ''
  const pageInfoRef = useRef(pageInfo)
  pageInfoRef.current = pageInfo

  // Reason: track the LAST turn's input tokens (= actual context size sent to API),
  // not cumulative sum. inputTokens already includes system prompt + full conversation
  // history + current message, so it IS the current context window usage.
  const [lastTurnTokens, setLastTurnTokens] = useState({ input: 0, output: 0, reasoning: 0 })

  // Reason: handleTokenUsage removed — SDK's onEnd reports totalUsage (sum of
  // all agent steps), which inflates the context indicator in multi-tool-call
  // scenarios. lastTurnTokens is now updated in the finish event handler using
  // lastStepInputTokens (= actual context size of the final step).
  const handleTokenUsage = useCallback(() => {}, [])

  const transport = useMemo((): ChatTransport<UIMessage> => ({
    sendMessages: async (opts) => {
      if (!realTransportRef.current) throw new Error('Config not loaded yet')
      // Reason: shared pipeline (interrupted-call cleanup + v2 expansion) —
      // same function the session inspector uses, so previews never drift.
      const expanded = prepareOutgoingMessages(opts.messages)
      return realTransportRef.current.sendMessages({ ...opts, messages: expanded })
    },
    reconnectToStream: async () => null,
  }), [])

  // Reason: kernel owns chat state (Phase 0: panel-hosted). The hook mirrors
  // kernel state into React via useSyncExternalStore; useChat is replaced by
  // KernelChat (AbstractChat on kernel-owned state) — same SDK machinery,
  // no React binding, ready to move off-panel in Phase 2. useState
  // initializers guarantee exactly-once construction without render-time
  // ref access.
  const onFinishRef = useRef<(opts: { message: UIMessage }) => void>(() => {})
  const [kernel] = useState(() => new PanelKernel({
    getConfig: () => configRef.current,
    getSessionId: () => sessionIdRef.current,
    // Reason: seed the turn's tab stack up front — the turn keeps one stable
    // tab reference for its whole life, even for turns that call no tools.
    onTurnStart: () => acquireTurnTab({
      getSessionId: () => sessionIdRef.current,
      getTabId: () => currentTabId.current,
    }),
  }))
  const [chat] = useState(() => new KernelChat<UIMessage>({
    state: kernel.kstate,
    transport,
    onFinish: (opts) => onFinishRef.current(opts),
    onError: (err) => { console.error('[useSidekickChat] error:', err) },
  }))

  // Reason: panel-mode counterpart of the offscreen runtime's lazy craton —
  // entry actions (new session, switch) build nothing; the first send calls
  // ensureAgentReady below, which extracts content, lists MCP tools and creates
  // the agent once. Later sends rebuild only on a fingerprint drift.
  const cratonHasContent = useRef(false)
  const agentFp = useRef('')
  const mcpToolsRef = useRef<Record<string, unknown>>({})
  // Reason: useChat captures the transport reference at init time and doesn't
  // update it on re-render. Use a stable wrapper that delegates to a ref so the
  // real DirectChatTransport can be swapped in after config loads.
  const realTransportRef = useRef<ChatTransport<UIMessage> | null>(null)
  useEffect(() => {
    cratonHasContent.current = false
    pageContextLocked.current = false
    pageContextRef.current = null
    // Reason: the agent closes over the previous session's craton and session
    // id — reusing it would send the new session's turn with the old page
    // context and write into the old conversation.
    realTransportRef.current = null
  }, [activeId])

  function installTransport(a: Awaited<ReturnType<typeof createAgent>>) {
    // Reason: SDK 7 provides performance stats per step (finish-step), not per turn (finish).
    // We accumulate across steps: elapsed sums stepTimeMs, TTFT comes from the first step,
    // reasoning time is tracked manually since the SDK doesn't measure it.
    let reasoningStartMs = 0
    let reasoningElapsed = 0
    let totalElapsedMs = 0
    let firstTtftMs: number | null = null
    let lastStepSpeed: number | undefined
    let lastStepInputTokens = 0

    realTransportRef.current = new DirectChatTransport({
      agent: a,
      sendReasoning: true,
      // Reason: SDK default onError masks all errors as "An error occurred." to
      // avoid leaking server details — pointless for a fully local extension.
      // Pass through the real message so tool/stream failures are debuggable.
      onError: (err) => err instanceof Error ? err.message : String(err),
      messageMetadata: ({ part }) => {
        if (part.type === 'start') {
          reasoningStartMs = 0
          reasoningElapsed = 0
          totalElapsedMs = 0
          firstTtftMs = null
          lastStepSpeed = undefined
          lastStepInputTokens = 0
        }
        if (part.type === 'reasoning-start') {
          reasoningStartMs = performance.now()
        }
        if (part.type === 'reasoning-end' && reasoningStartMs) {
          reasoningElapsed += (performance.now() - reasoningStartMs) / 1000
          reasoningStartMs = 0
        }
        if (part.type === 'finish-step') {
          const step = part as unknown as {
            usage?: { inputTokens?: number }
            performance?: { stepTimeMs: number; timeToFirstOutputMs?: number; outputTokensPerSecond?: number }
          }
          if (step.usage) {
            lastStepInputTokens = step.usage.inputTokens ?? 0
            // Reason: commit per step, not only at 'finish' — abort/error mid-turn
            // would otherwise leave the context indicator stale. Each step's
            // inputTokens IS the current context size at that point.
            if (lastStepInputTokens > 0) {
              const v = lastStepInputTokens
              setLastTurnTokens(prev => prev.input === v ? prev : { ...prev, input: v })
            }
          }
          if (step.performance) {
            totalElapsedMs += step.performance.stepTimeMs
            lastStepSpeed = step.performance.outputTokensPerSecond
            if (firstTtftMs === null && step.performance.timeToFirstOutputMs != null) {
              firstTtftMs = step.performance.timeToFirstOutputMs
            }
          }
        }
        if (part.type === 'finish') {
          const tokens = part.totalUsage.outputTokens ?? 0
          const elapsed = totalElapsedMs / 1000
          const ttft = firstTtftMs != null ? firstTtftMs / 1000 : 0
          const speed = lastStepSpeed ?? (elapsed > 0 ? tokens / elapsed : 0)
          const reasoning = part.totalUsage.outputTokenDetails?.reasoningTokens ?? 0
          const prompt = lastStepInputTokens
          setLastTurnTokens({ input: prompt, output: tokens, reasoning })
          return {
            completionTokens: tokens,
            promptTokens: prompt,
            reasoningTokens: reasoning,
            elapsed, ttft, reasoningElapsed, speed,
          }
        }
        return undefined
      },
    }) as ChatTransport<UIMessage>
  }

  // Reason: panel-mode counterpart of the offscreen runtime's craton build. It
  // runs on the first send (or regenerate) — never on entering a session — and
  // covers everything that makes a send possible: page content, the MCP tool
  // list and the agent itself, all inside the kernel's preparing flag.
  const ensureAgentReady = useCallback(async () => {
    const cfg = configRef.current
    if (!cfg) return
    const fp = agentFingerprint(cfg)
    const drifted = fp !== agentFp.current
    if (drifted) {
      console.log('[agent rebuild] fingerprint changed')
      cratonHasContent.current = false
      // Reason: same contract as the offscreen runtime — a drifted transport
      // must not be reused, or a content-less page returns early forever and
      // the new profile/MCP table never lands.
      realTransportRef.current = null
    }
    if (realTransportRef.current && cratonHasContent.current) return
    if (realTransportRef.current && !pageContextRef.current) return
    if (pageContextRef.current) cratonHasContent.current = true

    let mcpRes: { errors?: Record<string, string>; tools?: McpToolMeta[]; diag?: string[] } | undefined
    let mcpThrew = false
    return kernel.prepareAgent(async signal => {
      const started = Date.now()
      const url = pageInfoRef.current?.url
      if (!pageContextRef.current && (!url || /^(https?|file):/.test(url))) {
        // Reason: extraction failure (chrome:// pages, PDF viewers, store
        // pages) degrades to a content-less craton — it must never skip the
        // agent build below.
        try {
          const content = await extractContent()
          signal.throwIfAborted()
          pageContextRef.current = content
          pageImagesRef.current = content.images ?? []
        } catch (e) { console.warn('[useSidekickChat] extract failed:', e) }
      }
      // Reason: the SW owns the MCP connections and decides in one place
      // whether anything needs re-listing — ask it for the current tools.
      signal.throwIfAborted()
      console.log(`[agent init] page ${Date.now() - started}ms`)
      const proxyTools: Record<string, unknown> = {}
      try {
        const tMcp = Date.now()
        mcpRes = await chrome.runtime.sendMessage({ type: 'mcp:ensure' }) as typeof mcpRes
        signal.throwIfAborted()
        const res = mcpRes
        const meta = Array.isArray(res?.tools) ? res.tools : []
        console.log(`[MCP] probe ${Date.now() - tMcp}ms: ${(res?.diag ?? []).join(' | ') || '(no diag)'}`)
        if (meta.length) {
          console.log(`[MCP] ${meta.length} tools:`, meta.map(m => m.qualifiedName).join(', '))
          for (const m of meta) {
            proxyTools[m.qualifiedName] = dynamicTool({
              description: m.description,
              inputSchema: jsonSchema(m.inputSchema),
              execute: async (args: unknown, { abortSignal }: { abortSignal?: AbortSignal }) => {
                const responsePromise = chrome.runtime.sendMessage({
                  type: 'mcp:call-tool',
                  qualifiedName: m.qualifiedName,
                  args,
                  // Reason: consent routing and site attribution should name
                  // the page the turn is operating on, not whichever tab the
                  // user switched to. Peek (never seed) — a pure-MCP turn must
                  // stay lock-free.
                  tabId: await peekOperatingTabId() ?? currentTabId.current,
                })
                const result = abortSignal
                  ? await Promise.race([
                      responsePromise,
                      new Promise<never>((_, reject) => {
                        if (abortSignal.aborted) { reject(abortSignal.reason); return }
                        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
                      }),
                    ])
                  : await responsePromise
                if (result?.error) throw new Error(result.error)
                return result
              },
            })
          }
        }
      } catch (e) {
        mcpThrew = true
        console.warn('[MCP] tool fetch failed:', e)
      }
      // Reason: a build that lost the whole tool table must not claim the new
      // fingerprint — the next send retries. A partial failure keeps the tools
      // that did load rather than rebuilding on every send.
      const mcpFailed = mcpThrew || (mcpRes !== undefined && (
        !Array.isArray(mcpRes.tools)
        || (mcpRes.tools.length === 0 && mcpRes.errors != null && Object.keys(mcpRes.errors).length > 0)
      ))
      signal.throwIfAborted()
      mcpToolsRef.current = proxyTools
      const tools = Object.keys(proxyTools).length > 0 ? proxyTools : undefined
      console.log('[agent rebuild] creating agent, model:', cfg.model)
      const agentStarted = Date.now()
      const a = await createAgent(cfg, pageContextRef, pageImagesRef, debugStatusRef, sessionIdRef, hostnameRef, tools, handleTokenUsage, undefined, proMode ? 'pro' : 'chat')
      signal.throwIfAborted()
      console.log(`[agent init] createAgent ${Date.now() - agentStarted}ms; total ${Date.now() - started}ms`)
      installTransport(a)
      agentFp.current = mcpFailed ? '' : fp
      setContextLoaded(true)
    })
  }, [kernel, proMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const subscribe = useCallback(
    (cb: () => void) => kernel.kstate.subscribe(throttleNotify(cb, 50)),
    [kernel],
  )
  const messages = useSyncExternalStore(subscribe, () => kernel.kstate.messages)
  const status = useSyncExternalStore(subscribe, () => kernel.kstate.status)
  const error = useSyncExternalStore(subscribe, () => kernel.kstate.error)
  const queue = useSyncExternalStore(subscribe, () => kernel.queue as QueuedMessage[])
  const compacting = useSyncExternalStore(subscribe, () => kernel.compacting)
  const preparing = useSyncExternalStore(subscribe, () => kernel.preparing)
  const dispatching = useSyncExternalStore(subscribe, () => kernel.dispatching)
  const chatSendMessage = chat.sendMessage
  const stop = useCallback(async () => {
    if (!kernel.cancelPreparation()) await chat.stop()
  }, [kernel, chat])
  const clearError = chat.clearError

  // Reason: drop-in replacement for useChat's setMessages — existing call
  // sites (session switch, regenerate, relay metadata) stay untouched.
  const setMessages = useCallback((next: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => {
    const s = kernel.kstate
    s.messages = typeof next === 'function' ? next(s.messages) : next
  }, [kernel])

  // Reason: refs for accessing latest state in callbacks without stale closures.
  // In mirror mode they track the mirrored state so ref consumers (session
  // inspector, onFinish) see the kernel's truth, not the idle local kernel.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const messagesRef = useRef(messages)
  messagesRef.current = mirrorActive ? (mirror?.messages ?? []) : messages
  const activeIdRef = useRef(activeId)
  activeIdRef.current = mirrorActive ? mirrorExtras.activeId : activeId
  const relayedIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => { setActiveSessionId(activeId) }, [activeId])

  const sessionLoadRef = useRef(0)
  const sessionScopeRef = useRef(0)
  const loadedSessionIds = useRef(new Set<string>())
  const deletingSessionIds = useRef(new Set<string>())
  // Reason: copy-on-write message arrays make reference identity a complete
  // change detector — length alone misses same-count edits (regenerate, a
  // checkpoint replacing its tail), leaving updatedAt stale for delta sync.
  const lastSavedMessagesRef = useRef<{ id: string; messages: UIMessage[] } | null>(null)
  // Reason: the turn's owner at start — a late abort/finish after a session
  // switch must not title or relay in the name of the session now on screen.
  const turnSessionRef = useRef('')
  // Reason: consecutive switches can read this cache before React renders again.
  const updateSessions = useCallback((next: ChatSession[]) => {
    sessionsRef.current = next
    setSessions(next)
  }, [])
  const patchSessionMeta = useCallback((id: string, patch: Partial<Pick<ChatSession, 'title' | 'updatedAt'>>) => {
    if (!sessionsRef.current.some(s => s.id === id) || deletingSessionIds.current.has(id)) return
    // Reason: storage bumps updatedAt on every metadata write — the local list
    // must carry the same timestamp or the next flushSave writes the old one
    // back and delta sync skips the rename.
    const next = { ...patch, updatedAt: patch.updatedAt ?? Date.now() }
    updateSessions(sessionsRef.current.map(s => s.id === id ? { ...s, ...next } : s))
    void updateSessionMeta(id, next)
  }, [updateSessions])

  // Reason: latest-closure ref — KernelChat captures onFinish once at
  // construction; the effect refreshes the body every render so config/
  // session state is never stale.
  useEffect(() => {
    onFinishRef.current = async ({ message }) => {
      const cfgNow = configRef.current
      const idNow = activeIdRef.current
      if (!cfgNow || !idNow) return
      if (deletingSessionIds.current.has(idNow)) return
      // Reason: an aborted turn can settle after the panel moved to another
      // session — it must not title or relay in the name of the session now
      // on screen.
      if (turnSessionRef.current && turnSessionRef.current !== idNow) return

      // Reason: relay AI response to CC via bridge (if connected)
      if (proMode) {
        const text = message.parts
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('')
          .trim()
        if (text.length > 10) {
          chrome.runtime.sendMessage({ type: 'bridge:send', text })
            .then((resp) => {
              if (!resp?.sent) return
              if (relayedIdsRef.current.has(message.id)) return
              relayedIdsRef.current.add(message.id)
              // Reason: mark relay via metadata so AI sees it next turn (expandForModel
              // appends the tag) while UI reads the flag without text parsing
              setMessages(prev => prev.map(m => {
                if (m.id !== message.id) return m
                const meta = (m.metadata ?? {}) as SidekickMetadata
                if (meta.relayed) return m
                return { ...m, metadata: { ...meta, v: 2 as const, relayed: true } } as typeof m
              }))
            })
            .catch(() => {})
        }
      }

      // Reason: auto-generate title on first assistant response
      const currentSessions = sessionsRef.current
      const session = currentSessions.find(s => s.id === idNow)
      if (!session || session.title !== 'New Chat') return

      const allMessages = messagesRef.current
      const firstUserMsg = allMessages.find(m => m.role === 'user')
      // Reason: visibleText strips attachment/skill metadata for both protocols
      const firstUserText = firstUserMsg ? visibleText(firstUserMsg) : ''
      const assistantText = message.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('')

      if (!firstUserText || !assistantText) return

      try {
        const title = await generateTitle(cfgNow, idNow, firstUserText, assistantText, pageInfo)
        patchSessionMeta(idNow, { title, updatedAt: Date.now() })
      } catch (err) {
        console.error('[generateTitle] failed:', err)
        const fallback = firstUserText.length > 30 ? firstUserText.slice(0, 30) + '...' : firstUserText
        patchSessionMeta(idNow, { title: fallback, updatedAt: Date.now() })
      }
    }
  })

  // Reason: register the session inspector getter — computed lazily on call
  // so the Dev panel always sees the current state without subscriptions.
  useEffect(() => {
    sessionSnapshotRef.current = () => ({
      sessionId: activeIdRef.current,
      proMode,
      outgoing: prepareOutgoingMessages(messagesRef.current),
      orogenLines: buildOrogenLines(mirrorActive ? null : pageContextRef.current, debugStatusRef.current, proMode),
      getCraton: async () => {
        if (mirrorActive) {
          const payload = await mirrorRequest<{
            craton: CratonSnapshot | null
            orogenLines: string[]
          }>('session-inspector')
          return payload.craton
        }
        return cratonRef.current
      },
    })
    return () => { sessionSnapshotRef.current = null }
  }, [proMode, mirrorActive, mirrorRequest])

  // --- Compression / archiving / queue: kernel-owned, hook keeps triggers ---
  const compactNow = useCallback(() => kernel.compactNow(), [kernel])
  const archiveNow = useCallback(() => kernel.archiveNow(), [kernel])

  // Reason: queued messages belong to the session they were typed in —
  // never carry them across a session switch.
  const clearQueue = useCallback(() => kernel.clearQueue(), [kernel])

  const flushSave = useCallback(() => {
    // Reason: a host switch changes the displayed identity before the local kernel is flushed.
    const id = sessionIdRef.current
    const msgs = kernel.kstate.messages
    if (!id || !msgs.length || deletingSessionIds.current.has(id)) return
    const session = sessionsRef.current.find(s => s.id === id)
    if (!session) return
    const last = lastSavedMessagesRef.current
    const changed = last?.id === id
      ? last.messages !== msgs
      : (session.messageCount ?? session.messages.length) !== msgs.length
    const updated = { ...session, messages: msgs, messageCount: msgs.length, ...(changed ? { updatedAt: Date.now() } : {}) }
    lastSavedMessagesRef.current = { id, messages: msgs }
    loadedSessionIds.current.add(id)
    updateSessions(sessionsRef.current.map(s => s.id === id ? updated : s))
    void saveSession(updated)
  }, [kernel, updateSessions])

  const endSessionScope = useCallback(() => {
    // Reason: pending reads must not outlive their mode, host or mounted panel.
    ++sessionLoadRef.current
    ++sessionScopeRef.current
    flushSave()
  }, [flushSave])

  const activateSession = useCallback((session: ChatSession) => {
    // Reason: one panel kernel serves one session at a time — a turn still
    // running here would stream into the newly loaded conversation. Stop it
    // before the state swap; its late onFinish is ignored by the ownership
    // check.
    if (kernel.kstate.status !== 'ready' || kernel.dispatching || kernel.preparing) {
      clearQueue()
      void stop().catch(() => {})
    }
    const next = sessionMessages(session)
    loadedSessionIds.current.add(session.id)
    // Reason: a flush before the next render must see matching identity and body.
    activeIdRef.current = session.id
    sessionIdRef.current = session.id
    messagesRef.current = next
    setActiveId(session.id)
    setMessages(next)
    lastSavedMessagesRef.current = { id: session.id, messages: kernel.kstate.messages }
    setContextLoaded(false)
    setLastTurnTokens({ input: 0, output: 0, reasoning: 0 })
  }, [kernel, clearQueue, stop, setMessages])

  const handleSelectSession = useCallback(async (id: string) => {
    const target = sessionsRef.current.find(s => s.id === id)
    if (!target || (target.mode ?? 'chat') !== (proMode ? 'pro' : 'chat') || deletingSessionIds.current.has(id)) return
    const request = ++sessionLoadRef.current
    clearQueue()
    if (id === activeIdRef.current && loadedSessionIds.current.has(id)) return
    try {
      const loaded = loadedSessionIds.current.has(id) ? target : await loadSession(id)
      if (request !== sessionLoadRef.current || !loaded || deletingSessionIds.current.has(id)) return
      const latest = sessionsRef.current.find(s => s.id === id)
      if (!latest) return
      // Reason: the outgoing session can still receive edits while this body is loading.
      flushSave()
      const hydrated = { ...loaded, ...latest, messages: loaded.messages, messageCount: loaded.messages.length }
      updateSessions(sessionsRef.current.map(s => s.id === id ? hydrated : s))
      activateSession(hydrated)
    } catch (err) {
      if (request === sessionLoadRef.current) console.error('[useSidekickChat] loadSession failed:', err)
    }
  }, [proMode, clearQueue, flushSave, updateSessions, activateSession])

  const handleNewSession = useCallback(() => {
    ++sessionLoadRef.current
    flushSave()
    const s = createSession(pageInfoRef.current?.url, proMode ? 'pro' : 'chat')
    clearQueue()
    updateSessions([s, ...sessionsRef.current.filter(existing => (existing.mode ?? 'chat') === s.mode)])
    activateSession(s)
    void saveSession(s)
  }, [proMode, flushSave, clearQueue, updateSessions, activateSession])

  // Reason: archive at the turn boundary (status → ready) — never mid-turn,
  // so the model's hot working set is never pulled out from under it.
  useEffect(() => {
    if (mirrorActive) return
    if (config?.labAutoCompress === false) return
    if (status !== 'ready' || compacting) return
    archiveNow()
  }, [status, messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reason: panel host owns the turn's tab lock — release it on the same
  // ready boundary the kernel host uses (turn-automation). In mirror mode the
  // offscreen runtime owns the turn and releases there.
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (mirrorActive) return
    if (status !== 'ready') turnSessionRef.current = activeIdRef.current
    const turnId = turnSessionRef.current
    // Reason: 'error' is terminal — it never reaches 'ready', so the release
    // below never fires and the tab lock (with the page indicator) survives
    // until the staleness backstop. Mirrors turn-automation.ts.
    if (status === 'error' && prev !== 'error') {
      turnSessionRef.current = ''
      chrome.runtime.sendMessage({ type: 'tab-lock:release', sessionId: turnId || activeIdRef.current }).catch(() => {})
      return
    }
    if (status !== 'ready' || prev === 'ready') return
    turnSessionRef.current = ''
    // Reason: queued sends are one continuous page-operation context; keep the
    // stack alive until the queue drains so user tab switches cannot redirect it.
    const type = kernel.hasQueuedContinuation ? 'tab-lock:touch' : 'tab-lock:release'
    chrome.runtime.sendMessage({ type, sessionId: turnId || activeIdRef.current }).catch(() => {})
    // Reason: an aborted turn settles after its session was deleted or the
    // panel moved on — neither a lock release nor a completion notice may be
    // attributed to the session now on screen.
    if (turnId !== activeIdRef.current) return
    if (deletingSessionIds.current.has(turnId)) return
    if (!sessionsRef.current.some(s => s.id === turnId)) return
    // Reason: a panel-hosted turn never reaches turn-automation — this is the
    // same ready edge, and the only way it can be off-screen is the browser
    // itself being out of the way, so presence is just our own visibility.
    chrome.runtime.sendMessage({
      type: 'turn:done',
      sessionId: turnId,
      title: sessionsRef.current.find(s => s.id === turnId)?.title ?? '',
      snippet: extractTurnSnippet(messagesRef.current),
      foreground: document.visibilityState === 'visible',
      mode: proMode ? 'pro' : 'chat',
    }).catch(() => {})
  }, [status, mirrorActive, kernel, proMode])

  // Reason: turn-alive heartbeat for the tab lock — a turn spending minutes in
  // reasoning or MCP calls touches no tab, and must not lose its lock (or its
  // followed-tab stack) to the staleness backstop. It also paces the page
  // indicator's lease renewal. The binding budget is NOT the 120s staleness TTL
  // but Chrome's ~30s idle eviction of the service worker, which owns the lock
  // registry in memory: at 30s this raced eviction with no margin, and a killed
  // worker loses the stack, after which no release can name the tab to unlight.
  useEffect(() => {
    if (mirrorActive || status === 'ready') return
    const timer = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'tab-lock:touch', sessionId: turnSessionRef.current || activeIdRef.current }).catch(() => {})
    }, 20_000)
    return () => clearInterval(timer)
  }, [status, mirrorActive])

  // Reason: the page strip must name the page the CONTEXT points at, not the
  // tab the user happens to be looking at — mid-turn they diverge (tools stay
  // on the turn's tab stack while the user browses elsewhere). Tracks the
  // active session's operating tab: broadcast-driven, with a query on mount /
  // session switch to cover a panel that opened mid-turn. In mirror mode the
  // authoritative session id is the kernel's, not the idle local one.
  const lockSessionId = mirrorActive ? mirrorExtras.activeId : activeId
  const [operatingPage, setOperatingPage] = useState<{ title: string; url: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    const apply = async (tabId: number | null) => {
      if (tabId == null) { if (!cancelled) setOperatingPage(null); return }
      try {
        const tab = await chrome.tabs.get(tabId)
        const page = { title: tab.title ?? '', url: tab.url ?? '' }
        // Reason: a tab carrying neither title nor url (mid-navigation,
        // discarded) says nothing — keep showing the user's page instead of
        // blanking the strip.
        if (!cancelled) setOperatingPage(page.title || page.url ? page : null)
      } catch { if (!cancelled) setOperatingPage(null) }
    }
    const listener = (msg: { type?: string; sessionId?: string; tabId?: number | null }): undefined => {
      if (msg?.type !== 'tab-lock:changed') return undefined
      if (msg.sessionId !== activeIdRef.current) return undefined
      apply(msg.tabId ?? null)
      return undefined
    }
    chrome.runtime.onMessage.addListener(listener)
    setOperatingPage(null)
    if (lockSessionId) {
      chrome.runtime.sendMessage({ type: 'tab-lock:query', sessionId: lockSessionId })
        .then(resp => apply(resp?.tabId ?? null))
        .catch(() => {})
    }
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [lockSessionId])

  // Reason: strip shows the operating page while a turn holds a tab stack, and
  // falls back to the user's active tab when idle (that is what the next turn
  // will seed from). `contextRemote` marks the diverged case so the user can
  // tell "AI is working over there" from "this is my page".
  const contextPageInfo = operatingPage ?? pageInfo
  const contextRemote = !!operatingPage && !!pageInfo && operatingPage.url !== pageInfo.url
  // Reason: three states the user must be able to tell apart — pinned by hand
  // (survives turns), held for the duration of one turn (seeded at turn start),
  // or free to follow whatever tab is active.
  const contextState: 'locked' | 'held' | 'free' = contextLocked
    ? 'locked'
    : operatingPage ? 'held' : 'free'

  // Reason: auto-compress at 80% context usage with 30s cooldown
  useEffect(() => {
    if (mirrorActive) return
    if (config?.labAutoCompress === false || !contextWindow || kernel.compacting) return
    if (status !== 'ready') return
    const usage = messagesRef.current.length > 0 ? tokenUsage : { tokens: 0, exact: false }
    if (usage.tokens / contextWindow < 0.8) return
    if (Date.now() - kernel.lastCompactionAt < 30_000) return
    compactNow()
  }, [status, messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reason: lock page context after first message — system prompt prefix stays fixed for cache
  if (messages.length > 0) {
    pageContextLocked.current = true
  }
  if (!pageContextLocked.current) {
    pageContextRef.current = pageContent
    pageImagesRef.current = pageContent?.images ?? []
  }

  // Load config on mount + reload on storage change (e.g. after settings save)
  useEffect(() => {
    const applyConfig = (c: ApiConfig | null) => {
      if (!c) return
      setConfig(c)
      setContextWindow(c.contextWindow)
    }
    loadConfig().then(applyConfig).catch(err => console.error('[useSidekickChat] loadConfig failed:', err))

    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.sidekick_config?.newValue) {
        applyConfig(changes.sidekick_config.newValue as ApiConfig)
      }
    }
    chrome.storage.onChanged.addListener(onStorageChanged)

    return () => chrome.storage.onChanged.removeListener(onStorageChanged)
  }, [])

  useEffect(() => {
    // Reason: mirror mode — session loading belongs to the offscreen kernel;
    // the panel must not double-load or double-create sessions.
    if (mirrorActive) return
    const request = ++sessionLoadRef.current
    loadedSessionIds.current.clear()
    clearQueue()
    void loadSessionIndex().then(loaded => {
      if (request !== sessionLoadRef.current) return
      const currentMode = proMode ? 'pro' : 'chat'
      // Reason: sessions without a mode field are legacy — treat as 'chat'.
      const sorted = loaded.filter(s => (s.mode ?? 'chat') === currentMode)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      updateSessions(sorted)
      if (sorted.length > 0) return handleSelectSession(sorted[0].id)
      handleNewSession()
    }).catch(err => {
      if (request === sessionLoadRef.current) console.error('[useSidekickChat] loadSessionIndex failed:', err)
    })
    return endSessionScope
  }, [mirrorActive, proMode, clearQueue, updateSessions, handleSelectSession, handleNewSession, endSessionScope])

  // Tab-session mapping
  // Reason: tab identity tracking must not be gated by turn status. A user can
  // switch tabs while the agent is busy; the next non-queued turn still needs
  // to seed from the user's current tab. Session auto-switch remains idle-only.
  // The map itself is window-local UX state, so it stays panel-side in both
  // hosts; only the switch action differs (setState vs kernel command).
  const statusRef = useRef(status)
  statusRef.current = mirrorActive ? (mirror?.status ?? 'ready') : status
  const pendingTabSessionRef = useRef<{ id: string; request: number } | null>(null)
  const sessionMode = proMode ? 'pro' : 'chat'
  useEffect(() => {
    if (activeTabId == null) return
    const pending = pendingTabSessionRef.current
    const pendingCurrent = !mirrorActive && pending?.request === sessionLoadRef.current ? pending : null
    // Reason: during loading, tab memory must track the target rather than the outgoing body.
    const curActive = pendingCurrent?.id ?? activeIdRef.current
    const plan = planTabSessionSwitch({
      prevTabId: currentTabId.current,
      nextTabId: activeTabId,
      currentSessionId: curActive,
      rememberedSessionId: tabSessionMap.current.get(activeTabId),
      contextLocked,
      idle: statusRef.current === 'ready',
      // Reason: UI entrance mode owns the selectable session set; never let a
      // stale per-tab mapping rebind a Chat panel to a Pro session or vice versa.
      hasSession: (id) => mirrorActive
        ? mirrorExtras.sessions.some(s => s.id === id && s.mode === sessionMode)
        : sessions.some(s => s.id === id && (s.mode ?? 'chat') === sessionMode),
    })
    // Reason: null = no real tab change (e.g. session-list update after
    // new-session re-fires this effect). Switching here would re-activate the
    // remembered session for the tab the user is still on.
    if (!plan) return
    // Reason: even an unremembered tab supersedes an earlier automatic read.
    if (pendingCurrent) ++sessionLoadRef.current
    pendingTabSessionRef.current = null
    if (plan.remember) tabSessionMap.current.set(plan.remember.tabId, plan.remember.sessionId)
    currentTabId.current = activeTabId
    if (!plan.switchTo) return
    if (mirrorActive) {
      cmd('select-session', { id: plan.switchTo, mode: sessionMode })
      return
    }
    const selection = handleSelectSession(plan.switchTo)
    const request = sessionLoadRef.current
    pendingTabSessionRef.current = { id: plan.switchTo, request }
    void selection.finally(() => {
      if (pendingTabSessionRef.current?.request === request) pendingTabSessionRef.current = null
    })
  }, [activeTabId, contextLocked, mirrorActive, sessionMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reason: only save after streaming stops — saving during streaming can trigger
  // a React setState loop (#185) because flushSave → setSessions → re-render →
  // messages ref changes → effect re-fires within the same update cycle.
  useEffect(() => {
    if (mirrorActive) return
    if (!activeId || messages.length === 0 || status !== 'ready') return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushSave, 300)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [messages, status, flushSave]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mirrorActive) return
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      flushSave()
    }
  }, [flushSave]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reason: track the last known exact value to avoid jumping between
  // exact and estimated values during streaming
  const lastExactTokens = useRef(0)

  const tokenUsage = useMemo((): { tokens: number; exact: boolean } => {
    // Reason: lastTurnTokens.input IS the current context size — API's inputTokens
    // includes system prompt + full conversation history + current user message.
    // After compression, the next turn's inputTokens reflects the reduced context.
    if (lastTurnTokens.input > 0) {
      return { tokens: lastTurnTokens.input, exact: true }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const meta = (messages[i] as unknown as { metadata?: Record<string, number> }).metadata
      if (meta?.promptTokens) {
        lastExactTokens.current = meta.promptTokens
        return { tokens: meta.promptTokens, exact: true }
      }
    }
    // Reason: if we had an exact value before, use it as baseline and only
    // add estimated tokens for new messages since last exact measurement
    if (lastExactTokens.current > 0) {
      const lastExactIdx = messages.findLastIndex(m =>
        (m as unknown as { metadata?: Record<string, number> }).metadata?.promptTokens,
      )
      let newChars = 0
      for (let i = lastExactIdx + 1; i < messages.length; i++) {
        for (const part of messages[i].parts) {
          if (part.type === 'text') newChars += part.text.length
        }
      }
      return { tokens: lastExactTokens.current + Math.ceil(newChars / CHARS_PER_TOKEN), exact: false }
    }
    const msgTokens = messages.reduce((sum, m) => {
      let chars = 0
      for (const part of m.parts) {
        if (part.type === 'text') chars += part.text.length
      }
      return sum + Math.ceil(chars / CHARS_PER_TOKEN)
    }, 0)
    const contentTokens = pageContent ? estimateTokens(pageContent.content) : 0
    return { tokens: TOOL_SCHEMA_OVERHEAD + contentTokens + msgTokens, exact: false }
  }, [messages, pageContent, lastTurnTokens])

  const handleDeleteSession = useCallback(async (id: string) => {
    const scope = sessionScopeRef.current
    const wasActive = id === activeIdRef.current
    const request = wasActive ? ++sessionLoadRef.current : sessionLoadRef.current
    deletingSessionIds.current.add(id)
    if (wasActive) {
      clearQueue()
      // Reason: the panel kernel would otherwise keep streaming the deleted
      // session and checkpoint it back into storage.
      void stop().catch(() => {})
    }
    try {
      await deleteSession(id)
      await chrome.storage.local.remove(`history:${id}`)
      if (scope !== sessionScopeRef.current) return
      loadedSessionIds.current.delete(id)
      const remaining = sessionsRef.current.filter(s => s.id !== id)
      updateSessions(remaining)
      // Reason: a late deletion must not override a newer selection or new-session action.
      if (id === activeIdRef.current && request === sessionLoadRef.current) {
        if (remaining.length > 0) await handleSelectSession(remaining[0].id)
        else handleNewSession()
      }
    } finally {
      deletingSessionIds.current.delete(id)
    }
  }, [clearQueue, stop, updateSessions, handleSelectSession, handleNewSession])

  const handleRenameSession = useCallback((id: string, title: string) => {
    if (title) patchSessionMeta(id, { title })
  }, [patchSessionMeta])

  const handleLoadContext = useCallback(async () => {
    try {
      await extractContent()
      setContextLoaded(true)
    } catch (err) {
      console.error('[loadContext]', err)
    }
  }, [extractContent])

  const sendNow = useCallback(async (
    text: string,
    attachments?: ElementAttachment[],
    opts?: { skill?: SkillPartData; fromBridge?: boolean; page?: { title: string; url: string } },
  ) => {
    const dispatchToken = kernel.dispatchToken
    // Reason: a build can take seconds — a session switch during it must drop
    // this dispatch instead of committing the old conversation's message into
    // the newly loaded one.
    const sessionAtSend = activeIdRef.current
    // Reason: protocol v2 — visible text, skill/element data parts and UI flags
    // are kept structured; expandForModel composes model input at send time.
    const metadata: SidekickMetadata = { v: 2 }
    if (opts?.fromBridge) metadata.source = 'claude-code'
    // Reason: page provenance captured at enqueue time (handleSend), not flush
    // time — "where the user asked" survives queue delays and tab switches.
    if (opts?.page?.url && /^https?:/.test(opts.page.url)) {
      metadata.pageUrl = opts.page.url
      metadata.pageTitle = opts.page.title
    }

    // Reason: the bubble must be on screen from the moment the user sends — the
    // prepare below can take seconds (page extraction + agent build), while the
    // SDK only appends the message when sendMessage runs at the end of it. The
    // commit further down reuses this id, so the placeholder is replaced in
    // place instead of being followed by a second copy.
    const pendingId = crypto.randomUUID()
    const pendingParts = buildUserParts({ text, attachments, skill: opts?.skill, savedFiles: savedFileParts(attachments) })
    if (pendingParts.length === 0) {
      kernel.releaseHandoff()
      return
    }
    kernel.kstate.pushMessage({ id: pendingId, role: 'user', parts: pendingParts, metadata } as UIMessage)

    // Reason: #dispatch already owns the dispatch flag (it starts before tab
    // seeding); this side only lowers it at the handoff or on its own exit.
    try {
      // Reason: the craton (page content, MCP tools, agent) is built here — on
      // the send itself — so entering a session never waits on any of it.
      await ensureAgentReady()
      if (activeIdRef.current !== sessionAtSend || deletingSessionIds.current.has(sessionAtSend)) {
        kernel.releaseHandoff()
        return
      }
      if (!realTransportRef.current) {
        kernel.kstate.error = new Error('AI 未就绪：配置未加载或初始化失败，请检查设置')
        kernel.releaseHandoff()
        return
      }

      // Reason: file uploads finish before enqueue, while optional image mirroring stays in the send pipeline.
      const { notes: attachmentNotes, savedFiles } = await mirrorAttachments(
        attachments,
        activeIdRef.current,
        !!configRef.current?.labImageFs,
        msg => chrome.runtime.sendMessage(msg),
      ).catch(error => {
        kernel.kstate.error = error instanceof Error ? error : new Error(String(error))
        throw error
      })
      if (activeIdRef.current !== sessionAtSend || deletingSessionIds.current.has(sessionAtSend)) {
        kernel.releaseHandoff()
        return
      }
      // Reason: commit a fresh object — the metadata pushed above must never be
      // mutated in place, since the kernel state holds that very reference.
      const finalMetadata: SidekickMetadata = attachmentNotes ? { ...metadata, attachmentNotes } : metadata
      const parts = buildUserParts({ text, attachments, skill: opts?.skill, savedFiles })
      if (parts.length === 0) {
        // Reason: nothing survived to send after all — retract the placeholder
        // rather than leave a bubble with no request behind it.
        kernel.kstate.popMessage()
        kernel.releaseHandoff()
        return
      }
      // Reason: messageId commits into the placeholder pushed above — same id,
      // same position, so the bubble never duplicates or flickers.
      const handedOff = chatSendMessage({ parts, metadata: finalMetadata, messageId: pendingId } as Parameters<typeof chatSendMessage>[0])
      // Reason: the SDK flips status to 'submitted' synchronously — from now on
      // the status carries the turn, so this dispatch releases its flag.
      kernel.endDispatch(dispatchToken)
      await handedOff
    } finally {
      // Reason: token-scoped — a later queued dispatch may already own the
      // flag by the time the turn's promise settles.
      kernel.endDispatch(dispatchToken)
    }
  }, [chatSendMessage, ensureAgentReady, kernel])

  // Reason: wire the kernel's send boundary to the latest sendNow closure —
  // queued flushes and direct sends share exactly this path.
  useEffect(() => {
    kernel.sendFn = (item) => sendNow(item.text, item.attachments, item.opts)
  }, [kernel, sendNow])

  const sendContextRef = useRef({ sessionId: activeIdRef.current, kernelHost, proMode })
  if (sendContextRef.current.sessionId !== activeIdRef.current || sendContextRef.current.kernelHost !== kernelHost || sendContextRef.current.proMode !== proMode) {
    sendContextRef.current = { sessionId: activeIdRef.current, kernelHost, proMode }
  }

  // Reason: upload errors must reach the composer before the kernel accepts or queues the send.
  const handleSend = useCallback(async (
    text: string,
    attachments?: ElementAttachment[],
    opts?: { skill?: SkillPartData; fromBridge?: boolean },
  ) => {
    const target = sendContextRef.current
    const page = pageInfoRef.current ?? undefined
    const assertCurrent = () => {
      if (!target.sessionId || sendContextRef.current !== target) throw new Error('上传期间会话已切换，发送已取消；输入和附件已保留')
    }
    if (!target.sessionId) throw new Error('发送失败：会话未就绪，请稍后重试')
    const prepared = attachments?.some(a => a.file || a.savedFile)
      ? await prepareFileAttachments(attachments, target.sessionId, configRef.current?.largeFileUploads !== false, msg => chrome.runtime.sendMessage(msg), assertCurrent)
      : attachments
    assertCurrent()
    void kernel.handleSend(text, prepared, { ...opts, page })
  }, [kernel])

  const removeQueued = useCallback((id: string) => kernel.removeQueued(id), [kernel])

  // Reason: "move back to input" — remove from queue and hand the item to the
  // caller so the composer can restore text/attachments for editing.
  const takeQueued = useCallback((id: string): QueuedMessage | null => kernel.takeQueued(id), [kernel])

  const handleRegenerate = useCallback((messageId: string) => {
    const idx = messages.findIndex(m => m.id === messageId)
    if (idx < 0 || messages[idx].role !== 'assistant') return

    const before = messages.slice(0, idx)
    const lastUserIdx = before.map(m => m.role).lastIndexOf('user')
    if (lastUserIdx < 0) {
      setMessages(before)
      return
    }
    // Reason: resend the full structured message (data-skill/data-element/file
    // parts + metadata) — a plain-text resend would drop v2 attachment context.
    // The last user turn stays on screen through the lazy build so the reply
    // slot has an anchor; the resend commits into that same message id.
    const lastUser = before[lastUserIdx]
    // Reason: timer replays must not resolve the currently active page as a new user turn.
    if ((lastUser.metadata as SidekickMetadata | undefined)?.source === 'timer') return
    setMessages(before)
    // Reason: regenerate is a send — it needs the same lazy craton build the
    // send path runs, since a session nobody has sent in yet has no transport.
    // The dispatch flag keeps the reply slot anchored through the build and
    // queues any send that lands before the handoff.
    const sessionAtSend = activeIdRef.current
    const dispatchToken = kernel.beginDispatch()
    void ensureAgentReady().then(() => {
      if (activeIdRef.current !== sessionAtSend || deletingSessionIds.current.has(sessionAtSend)) return
      if (!realTransportRef.current) {
        kernel.kstate.error = new Error('AI 未就绪：配置未加载或初始化失败，请检查设置')
        return
      }
      const handedOff = chatSendMessage({ parts: lastUser.parts, metadata: lastUser.metadata, messageId: lastUser.id } as Parameters<typeof chatSendMessage>[0])
      kernel.endDispatch(dispatchToken)
      return handedOff
    }).catch(err => console.error('[useSidekickChat] regenerate failed:', err))
      .finally(() => kernel.endDispatch(dispatchToken))
  }, [messages, setMessages, chatSendMessage, ensureAgentReady, kernel])

  const injectMessage = useCallback((role: 'user' | 'assistant', text: string, metadata?: Record<string, unknown>) => {
    const msg = {
      id: crypto.randomUUID(),
      role,
      parts: [{ type: 'text', text }],
      ...(metadata ? { metadata } : {}),
    } as unknown as UIMessage
    setMessages(prev => [...prev, msg])
  }, [setMessages])

  // --- Mirror mode (labKernelHost === 'offscreen'): the offscreen kernel
  // drives everything; the panel issues idempotent commands and renders the
  // mirrored state. All hooks above still run (rules of hooks) but their
  // side effects are gated on mirrorActive. ---

  useEffect(() => {
    if (!mirrorActive || !mirrorConnected) return
    cmd('init', { mode: proMode ? 'pro' : 'chat', pageInfo: pageInfoRef.current })
  }, [mirrorActive, mirrorConnected, proMode, cmd])

  const mirrorSend = useCallback(async (
    text: string,
    attachments?: ElementAttachment[],
    opts?: { skill?: SkillPartData; fromBridge?: boolean },
  ) => {
    // Reason: the composer is live from the first paint — a send that beats the
    // panel↔kernel handshake waits for it instead of bouncing off "not ready".
    await whenReady()
    const target = captureSendTarget()
    const context = sendContextRef.current
    const page = pageInfoRef.current
    const assertCurrent = () => {
      target.assertCurrent()
      if (sendContextRef.current !== context) throw new Error('上传期间会话已切换，发送已取消；输入和附件已保留')
    }
    let tabId: number | null = null
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      tabId = tab?.id ?? null
    } catch { /* keep null — kernel falls back to env:active-tab */ }
    const prepared = attachments?.some(a => a.file || a.savedFile)
      ? await prepareFileAttachments(attachments, target.sessionId, mirrorExtras.config?.largeFileUploads !== false, msg => chrome.runtime.sendMessage(msg), assertCurrent)
      : attachments
    assertCurrent()
    cmd('send', { text, attachments: prepared, opts, pageInfo: page, tabId, debugStatus: debugStatusRef.current })
  }, [cmd, captureSendTarget, mirrorExtras.config?.largeFileUploads, whenReady])

  // Reason: queue contents are already mirrored — recall reads locally,
  // removal is a kernel command.
  const mirrorTakeQueued = useCallback((id: string): QueuedMessage | null => {
    const item = mirror?.queue.find(q => q.id === id) ?? null
    if (item) cmd('remove-queued', { id })
    return item
  }, [mirror, cmd])

  const mirrorLoadContext = useCallback(async () => {
    try {
      const content = await extractContent()
      cmd('page-context', { content, pageInfo: pageInfoRef.current })
      setContextLoaded(true)
    } catch (err) {
      console.error('[loadContext]', err)
    }
  }, [extractContent, cmd])

  const mirrorError = useMemo(
    () => mirror?.errorMessage ? new Error(mirror.errorMessage) : undefined,
    [mirror?.errorMessage],
  )
  // Reason: extras.lastTurnTokens is kernel-memory state — zero after every
  // cold load (session switch, eviction, document restart). Fall back to the
  // promptTokens persisted in message metadata, then to a char estimate,
  // mirroring the panel-mode indicator's degradation chain.
  const mirrorTokenUsage = useMemo((): { tokens: number; exact: boolean } => {
    if (mirrorExtras.lastTurnTokens.input > 0) {
      return { tokens: mirrorExtras.lastTurnTokens.input, exact: true }
    }
    const msgs = mirror?.messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const meta = (msgs[i] as unknown as { metadata?: Record<string, number> }).metadata
      if (meta?.promptTokens) return { tokens: meta.promptTokens, exact: true }
    }
    if (msgs.length === 0) return { tokens: 0, exact: false }
    const msgTokens = msgs.reduce((sum, m) => {
      let chars = 0
      for (const part of m.parts) {
        if (part.type === 'text') chars += part.text.length
      }
      return sum + Math.ceil(chars / CHARS_PER_TOKEN)
    }, 0)
    return { tokens: TOOL_SCHEMA_OVERHEAD + msgTokens, exact: false }
  }, [mirror?.messages, mirrorExtras])
  const emptyRelayedRef = useRef<Set<string>>(new Set())

  // Reason: stable command wrappers — memoized children (MessageBubble,
  // SessionBar) must not see fresh callback identities on every patch frame.
  const mirrorClearError = useCallback(() => cmd('clear-error'), [cmd])
  const mirrorStop = useCallback(async () => { cmd('stop') }, [cmd])
  const mirrorRemoveQueued = useCallback((id: string) => cmd('remove-queued', { id }), [cmd])
  const mirrorRegenerate = useCallback((messageId: string) => cmd('regenerate', { messageId }), [cmd])
  const mirrorInjectMessage = useCallback((role: 'user' | 'assistant', text: string, metadata?: Record<string, unknown>) =>
    cmd('inject-message', { role, text, metadata }), [cmd])
  const mirrorSelectSession = useCallback((id: string) => cmd('select-session', { id, mode: proMode ? 'pro' : 'chat' }), [cmd, proMode])
  const mirrorNewSession = useCallback(() => cmd('new-session', { mode: proMode ? 'pro' : 'chat', pageInfo: pageInfoRef.current }), [cmd, proMode])
  const mirrorDeleteSession = useCallback(async (id: string) => { cmd('delete-session', { id, mode: proMode ? 'pro' : 'chat' }) }, [cmd, proMode])
  const mirrorRenameSession = useCallback((id: string, title: string) => cmd('rename-session', { id, title }), [cmd])
  const mirrorCompactNow = useCallback(async () => { cmd('compact-now') }, [cmd])

  // Reason: a completion notice is the only route back to a session nobody is
  // watching, so landing on that exact conversation is the point of the click.
  // Declared after the init effect above: 'init' rebinds to the newest session
  // and must be superseded by this selection, not the other way round.
  useEffect(() => {
    if (!mirrorActive || !mirrorConnected) return
    let cancelled = false
    const activate = async (sessionId: unknown, windowId: unknown, mode: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId) return
      // Reason: UI entrance mode owns the selectable session set — a Chat
      // panel cannot host a Pro session, so this click is not for us and the
      // key must survive for the panel that can (flipping the mode re-runs
      // this effect).
      if (mode !== sessionMode) return
      // Reason: the notice belongs to the window it was clicked in; its id
      // rides in the notification id, and only a positive mismatch skips —
      // an unanswerable window query must not swallow the click.
      if (windowId != null) {
        const win = await chrome.windows.getCurrent().catch(() => null)
        if (win?.id != null && win.id !== windowId) return
      }
      if (cancelled) return
      await chrome.storage.session.remove('pendingPanelSession').catch(() => {})
      mirrorSelectSession(sessionId)
    }
    const onMessage = (msg: { type?: string; sessionId?: string; windowId?: number | null; mode?: string }): undefined => {
      if (msg?.type === 'panel:open-session') void activate(msg.sessionId, msg.windowId, msg.mode)
      return undefined
    }
    chrome.runtime.onMessage.addListener(onMessage)
    chrome.storage.session.get('pendingPanelSession')
      .then(r => {
        const p = r.pendingPanelSession as { sessionId?: string; windowId?: number | null; mode?: string } | undefined
        if (p?.sessionId) return activate(p.sessionId, p.windowId ?? null, p.mode)
      })
      .catch(() => {})
    return () => { cancelled = true; chrome.runtime.onMessage.removeListener(onMessage) }
  }, [mirrorActive, mirrorConnected, mirrorSelectSession, sessionMode])

  // Reason: a notice for a session already on screen is stale the moment the
  // panel comes back — cleared here rather than in the SW so it also covers
  // the user re-focusing the window without touching the notification.
  useEffect(() => {
    if (!mirrorActive || !mirrorConnected) return
    const sessionId = mirrorExtras.activeId
    if (!sessionId) return
    const clear = () => {
      if (document.visibilityState !== 'visible') return
      chrome.notifications.getAll().then(all => {
        for (const id of Object.keys(all ?? {})) {
          if (parseTurnNotificationId(id)?.sessionId === sessionId) chrome.notifications.clear(id).catch(() => {})
        }
      }).catch(() => {})
    }
    clear()
    document.addEventListener('visibilitychange', clear)
    return () => document.removeEventListener('visibilitychange', clear)
  }, [mirrorActive, mirrorConnected, mirrorExtras.activeId])

  // Reason: extras arrive as fresh objects on every patch frame (80ms during
  // streaming) — key the memo on a content signature so the array reference
  // only changes when a session actually changed, letting the memoized
  // SessionBar skip re-filtering/sorting hundreds of entries per frame.
  const sessionsSig = mirrorExtras.sessions
    .map(s => `${s.id}\x1f${s.updatedAt}\x1f${s.messageCount ?? 0}\x1f${s.title}`).join('\n')
  const mirrorSessions = useMemo(
    () => mirrorExtras.sessions.map(s => ({ ...s, messages: [] })) as unknown as ChatSession[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsSig],
  )

  if (mirrorActive) {
    const ex = mirrorExtras
    return {
      messages: mirror?.messages ?? [],
      status: mirror?.status ?? 'ready',
      preparing: mirror?.preparing ?? false,
      dispatching: mirror?.dispatching ?? false,
      // Reason: the only remaining boot-time wait is the panel↔kernel port
      // itself — building is the runtime's job and happens on the first send.
      connecting: !mirrorConnected,
      error: mirrorError,
      clearError: mirrorClearError,
      stop: mirrorStop,
      sendMessage: mirrorSend,
      queue: (mirror?.queue ?? []) as QueuedMessage[],
      removeQueued: mirrorRemoveQueued,
      takeQueued: mirrorTakeQueued,
      handleRegenerate: mirrorRegenerate,
      injectMessage: mirrorInjectMessage,
      sessions: mirrorSessions,
      activeId: ex.activeId,
      handleSelectSession: mirrorSelectSession,
      handleNewSession: mirrorNewSession,
      handleDeleteSession: mirrorDeleteSession,
      handleRenameSession: mirrorRenameSession,
      tokenUsage: mirrorTokenUsage,
      contextWindow: ex.contextWindow,
      // Reason: kernel-side extraction (send path) flips ex.contextLoaded;
      // the local flag only covers the manual "load ctx" action.
      contextLoaded: contextLoaded || ex.contextLoaded,
      handleLoadContext: mirrorLoadContext,
      pageContent,
      // Reason: the strip is rendered from these regardless of host — omitting
      // them here left them undefined in mirror mode, blanking the strip.
      contextPageInfo,
      contextRemote,
      contextState,
      compacting: mirror?.compacting ?? false,
      compactNow: mirrorCompactNow,
      modelName: ex.modelName,
      config: ex.config ?? config,
      relayedIds: emptyRelayedRef,
      debugStatusRef,
    }
  }

  return {
    messages,
    status,
    preparing,
    dispatching,
    // Reason: panel mode hosts the kernel in this document — there is no port
    // to connect, so nothing waits at boot.
    connecting: false,
    error,
    clearError,
    stop,
    sendMessage: handleSend,
    queue,
    removeQueued,
    takeQueued,
    handleRegenerate,
    injectMessage,
    sessions,
    activeId,
    handleSelectSession,
    handleNewSession,
    handleDeleteSession,
    handleRenameSession,
    tokenUsage,
    contextWindow,
    contextLoaded,
    handleLoadContext,
    pageContent,
    contextPageInfo,
    contextRemote,
    contextState,
    compacting,
    compactNow,
    modelName: config?.model ?? '',
    config,
    relayedIds: relayedIdsRef,
    debugStatusRef,
  }
}
