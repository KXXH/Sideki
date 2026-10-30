import type { TimerWake } from '../scheduled-task'
import { AbstractChat } from 'ai'
import type { ChatInit, ChatState, ChatStatus, UIMessage } from 'ai'
import type { SkillPartData } from '../message-protocol'
import type { ApiConfig, ElementAttachment } from '../types'
import { findCompactionCutoff, findArchiveCutoff } from '../format'
import { compactContext } from '../ai-provider'

// Reason: framework-agnostic chat state — the kernel-side counterpart of
// @ai-sdk/react's ReactChatState. Adds a monotonic `rev` (every mutation
// bumps it exactly once) and a single coarse-grained subscription channel;
// both are the foundation of the panel sync protocol (snapshot + patch).
export class KernelChatState<UI_MESSAGE extends UIMessage> implements ChatState<UI_MESSAGE> {
  #messages: UI_MESSAGE[]
  #status: ChatStatus = 'ready'
  #error: Error | undefined = undefined
  #rev = 0
  #listeners = new Set<() => void>()

  constructor(initialMessages: UI_MESSAGE[] = []) {
    this.#messages = initialMessages
  }

  get rev(): number {
    return this.#rev
  }

  get status(): ChatStatus {
    return this.#status
  }

  set status(newStatus: ChatStatus) {
    this.#status = newStatus
    this.bump()
  }

  get error(): Error | undefined {
    return this.#error
  }

  set error(newError: Error | undefined) {
    this.#error = newError
    this.bump()
  }

  get messages(): UI_MESSAGE[] {
    return this.#messages
  }

  set messages(newMessages: UI_MESSAGE[]) {
    this.#messages = [...newMessages]
    this.bump()
  }

  pushMessage = (message: UI_MESSAGE) => {
    this.#messages = this.#messages.concat(message)
    this.bump()
  }

  popMessage = () => {
    this.#messages = this.#messages.slice(0, -1)
    this.bump()
  }

  replaceMessage = (index: number, message: UI_MESSAGE) => {
    this.#messages = [
      ...this.#messages.slice(0, index),
      // Reason: deep clone — streaming mutates the source object in place;
      // the stored copy must be immune to later external mutation.
      this.snapshot(message),
      ...this.#messages.slice(index + 1),
    ]
    this.bump()
  }

  snapshot = <T>(value: T): T => structuredClone(value)

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // Reason: single rev/notify path for ALL state mutations, including
  // kernel-level ones (queue changes) that live outside ChatState — the sync
  // protocol needs one monotonic counter covering everything a panel mirrors.
  bump = () => {
    this.#rev++
    this.#listeners.forEach(l => l())
  }
}

// Reason: AbstractChat wired to KernelChatState — the SDK's chat machinery
// (makeRequest/stop/tool callbacks) running on kernel-owned state. Public
// ChatInit surface only, so SDK upgrades stay contained. An external state
// lets SidekickKernel and the chat share one rev/notify channel.
export class KernelChat<UI_MESSAGE extends UIMessage> extends AbstractChat<UI_MESSAGE> {
  readonly kstate: KernelChatState<UI_MESSAGE>

  constructor({ messages, state, ...init }: ChatInit<UI_MESSAGE> & { state?: KernelChatState<UI_MESSAGE> }) {
    const s = state ?? new KernelChatState<UI_MESSAGE>(messages)
    super({ ...init, state: s })
    this.kstate = s
  }
}

export interface SendItem {
  id: string
  text: string
  attachments?: ElementAttachment[]
  // Reason: `page` is the enqueue-time page snapshot (protocol v2 provenance) —
  // it must ride with the queued item, not be re-read at flush time.
  opts?: { timer?: TimerWake; skill?: SkillPartData; fromBridge?: boolean; page?: { title: string; url: string } }
}

export const COMMAND_DEDUP_CAP = 200
export const AGENT_PREPARATION_TIMEOUT_MS = 30_000

export const COMPACT_MSG_ID = '__context_summary__'

// Reason: tool result archiving (turn-boundary write-back). Keep the last
// ARCHIVE_KEEP_TURNS user turns intact — the current turn's working set is hot
// and the previous turn is a likely follow-up target. Tune here if needed.
export const ARCHIVE_KEEP_TURNS = 2
const ARCHIVE_MIN_CHARS = 500
const ARCHIVE_HEAD_CHARS = 200

export interface KernelInit {
  getConfig?: () => ApiConfig | null
  getSessionId?: () => string
  // Reason: runs once per turn, immediately before dispatch — the host uses it
  // to seed the turn's tab stack. Kept as a dep so the kernel stays free of
  // chrome APIs.
  onTurnStart?: (item: SendItem) => Promise<void>
}

// Reason: headless agent kernel — owns chat state, the FIFO send queue and
// the turn-boundary scheduler. No React, no chrome API: side effects enter
// through performSend (overridden by the host wiring). The scheduler replaces
// the hook-era effect/ref choreography (flushingRef/preparingRef) with plain
// sequential logic driven by state notifications.
export class SidekickKernel {
  readonly kstate = new KernelChatState<UIMessage>()

  #queue: SendItem[] = []
  #compacting = false
  #preparing = false
  #preparation: AbortController | null = null
  #dispatching = false
  #scheduleHold = false
  #dispatchSeq = 0
  #flushing = false
  #archiving = false
  #lastCompactionAt = 0
  #seenCommands = new Set<string>()
  protected readonly deps: KernelInit

  constructor(init: KernelInit = {}) {
    this.deps = init
    // Reason: every state notification re-evaluates the scheduler — status
    // reaching 'ready', compaction ending and queue growth all funnel here.
    this.kstate.subscribe(() => this.#schedule())
  }

  get rev(): number {
    return this.kstate.rev
  }

  get queue(): readonly SendItem[] {
    return this.#queue
  }

  // Reason: queued turns form one continuous page-operation context. During a
  // ready-boundary handoff the scheduler may have already popped the next item,
  // so the in-flight flushing guard is part of the continuation signal.
  get hasQueuedContinuation(): boolean {
    return this.#queue.length > 0 || this.#flushing
  }

  get compacting(): boolean {
    return this.#compacting
  }

  get preparing(): boolean {
    return this.#preparing
  }

  cancelPreparation(): boolean {
    if (!this.#preparation) return false
    this.#preparation.abort(new DOMException('初始化已停止', 'AbortError'))
    return true
  }

  // Reason: Chrome messaging cannot abort its underlying work; race the wait and
  // require signal checkpoints before late results can mutate agent state.
  async prepareAgent(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController()
    this.#preparation = controller
    this.setPreparing(true)
    const timeout = setTimeout(() => controller.abort(new Error('初始化 Agent 超时（30 秒），请重试或检查 MCP 连接')), AGENT_PREPARATION_TIMEOUT_MS)
    let onAbort: () => void = () => {}
    try {
      await Promise.race([
        new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', onAbort, { once: true })
        }),
        work(controller.signal),
      ])
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.kstate.error = error instanceof Error ? error : new Error(String(error))
      }
      this.releaseHandoff()
      throw error
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      if (this.#preparation === controller) {
        this.#preparation = null
        this.setPreparing(false)
      }
    }
  }

  // Reason: a send is in flight and the turn has not reached the SDK yet —
  // the busy window the status alone cannot describe (it is still 'ready').
  get dispatching(): boolean {
    return this.#dispatching
  }

  get dispatchToken(): number {
    return this.#dispatchSeq
  }

  // Reason: dispatching is owned by one dispatch at a time. A turn can hand
  // off to the next queued send before the previous dispatch's promise
  // resolves, so every clear must name the dispatch it belongs to.
  beginDispatch(): number {
    const token = ++this.#dispatchSeq
    this.setDispatching(true)
    return token
  }

  endDispatch(token: number): void {
    if (token === this.#dispatchSeq) this.setDispatching(false)
  }

  // Reason: scheduled turns must commit their page binding and outcome before queued user turns can change either.
  holdScheduleBoundary(hold: boolean): void {
    this.#scheduleHold = hold
    this.kstate.bump()
  }

  get lastCompactionAt(): number {
    return this.#lastCompactionAt
  }

  // Reason: sync host needs the session identity for snapshots without
  // reaching into protected deps.
  get sessionId(): string {
    return this.deps.getSessionId?.() ?? ''
  }

  // Reason: single send entry — busy kernel (mid-turn, compacting, preparing)
  // queues the message; an idle kernel sends straight away. The direct path
  // also takes the flushing guard so a message queued during send preparation
  // cannot be double-dispatched by the scheduler.
  async handleSend(
    text: string,
    attachments?: SendItem['attachments'],
    opts?: SendItem['opts'],
  ): Promise<void> {
    // Reason: dispatching covers the handoff window where status is still
    // 'ready' — a second send there must queue, not race the first one into
    // the SDK (the loser's messageId is truncated away and lost).
    if (this.#scheduleHold || this.kstate.status !== 'ready' || this.#compacting || this.#preparing || this.#dispatching) {
      this.#queue = [...this.#queue, { id: crypto.randomUUID(), text, attachments, opts }]
      this.kstate.bump()
      return
    }
    this.#flushing = true
    return this.#dispatch({ id: crypto.randomUUID(), text, attachments, opts }).catch(err => {
      console.error('[kernel] send failed:', err)
      if (opts?.timer) this.kstate.error = err instanceof Error ? err : new Error(String(err))
      this.#flushing = false
    })
  }

  // Reason: a send can end without the SDK taking the turn (missing config,
  // failed build, nothing left to send). That is not a turn, so the handoff
  // guard must not outlive it — otherwise every later send queues forever.
  // Lowering `dispatching` in the caller's finally bumps the state, which is
  // what re-runs the scheduler; no separate microtask is needed.
  releaseHandoff(): void {
    this.#flushing = false
  }

  // Reason: single dispatch gate for both entry paths (direct send and queue
  // flush) — a turn must not start before its tab stack is seeded, otherwise it
  // has no stable tab reference and the UI cannot show the held state yet.
  async #dispatch(item: SendItem): Promise<void> {
    // Reason: the busy truth starts at acceptance, not inside performSend —
    // tab seeding runs before the transport exists and must not admit a second
    // direct send into the same handoff.
    const token = this.beginDispatch()
    try {
      const onTurnStart = this.deps.onTurnStart
      if (onTurnStart) {
        try {
          await onTurnStart(item)
        } catch (error) {
          if (item.opts?.timer) { this.releaseHandoff(); throw error }
          /* seeding must never block a turn */
        }
      }
      return await this.performSend(item)
    } finally {
      this.endDispatch(token)
    }
  }

  removeQueued(id: string): void {
    this.#queue = this.#queue.filter(q => q.id !== id)
    this.kstate.bump()
  }

  takeQueued(id: string): SendItem | null {
    const item = this.#queue.find(q => q.id === id) ?? null
    if (item) {
      this.#queue = this.#queue.filter(q => q.id !== id)
      this.kstate.bump()
    }
    return item
  }

  clearQueue(): void {
    if (this.#queue.length === 0) return
    this.#queue = []
    this.kstate.bump()
  }

  // Reason: panel→kernel commands carry a client id; reconnect retries must
  // not double-execute. Bounded FIFO eviction keeps memory flat.
  runCommand(id: string, fn: () => void): boolean {
    if (this.#seenCommands.has(id)) return false
    this.#seenCommands.add(id)
    if (this.#seenCommands.size > COMMAND_DEDUP_CAP) {
      const oldest = this.#seenCommands.values().next().value
      if (oldest !== undefined) this.#seenCommands.delete(oldest)
    }
    fn()
    return true
  }

  protected setCompacting(value: boolean): void {
    this.#compacting = value
    this.kstate.bump()
  }

  protected setPreparing(value: boolean): void {
    this.#preparing = value
    this.kstate.bump()
  }

  protected setDispatching(value: boolean): void {
    // Reason: callers clear it on the handoff and again on the exit path — a
    // redundant clear must not cost a rev bump.
    if (this.#dispatching === value) return
    this.#dispatching = value
    this.kstate.bump()
  }

  // Reason: LLM context compression — compress everything before the cutoff
  // into a structured summary, park the originals in storage for UI playback.
  // Ported verbatim from the hook; kstate replaces useChat's setMessages.
  async compactNow(): Promise<void> {
    if (this.#compacting || this.kstate.status !== 'ready') return
    const config = this.deps.getConfig?.() ?? null
    if (!config) return
    const msgs = this.kstate.messages
    const cutoff = findCompactionCutoff(msgs.map(m => m.role))
    if (cutoff < 0) return

    this.setCompacting(true)
    try {
      const toCompress = msgs.slice(0, cutoff)
      const toKeep = msgs.slice(cutoff)
      // Reason: convert UIMessage parts to plain text for the compaction LLM
      const plain = toCompress.map(m => ({
        role: m.role,
        content: m.parts.filter(p => p.type === 'text').map(p => p.text).join('') || '[non-text content]',
      }))

      console.log(`[compact] compressing ${toCompress.length} messages, keeping ${toKeep.length}`)
      const sessionId = this.deps.getSessionId?.() ?? ''
      const summary = await compactContext(config, sessionId, plain)

      // Reason: append compressed messages + marker to history for UI playback.
      // Offscreen documents have no chrome.storage — proxy through the SW.
      const historyEntry = {
        compressedMessages: toCompress,
        marker: { type: 'compact-marker' as const, summary, timestamp: Date.now() },
      }
      const historyKey = `history:${sessionId}`
      if (chrome.storage?.local) {
        const existing = await chrome.storage.local.get(historyKey)
        const prev: unknown[] = existing[historyKey] ?? []
        prev.push(historyEntry)
        await chrome.storage.local.set({ [historyKey]: prev })
      } else {
        await chrome.runtime.sendMessage({ type: 'env:history-append', key: historyKey, entry: historyEntry })
      }

      this.kstate.messages = [
        { id: COMPACT_MSG_ID, role: 'assistant' as const, parts: [{ type: 'text' as const, text: summary }], createdAt: new Date() } as unknown as UIMessage,
        ...toKeep,
      ]

      this.#lastCompactionAt = Date.now()
      console.log(`[compact] done, ${toCompress.length} messages archived`)
    } catch (e) {
      console.warn('[compact] failed:', e)
    } finally {
      this.setCompacting(false)
    }
  }

  // Reason: archive large tool results older than the protection window into
  // VFS /context/ files, writing the stub back into kernel state. Write-back
  // means each part is rewritten exactly once in its lifetime — the prompt
  // cache prefix stays stable afterwards (unlike per-call rewriting).
  async archiveNow(): Promise<void> {
    if (this.#archiving || this.#compacting) return
    const cfg = this.deps.getConfig?.() ?? null
    const sessionId = this.deps.getSessionId?.() ?? ''
    if (cfg?.labAutoCompress === false || !sessionId) return
    const msgs = this.kstate.messages
    const cutoff = findArchiveCutoff(msgs.map(m => m.role), ARCHIVE_KEEP_TURNS)
    if (cutoff < 0) return

    this.#archiving = true
    try {
      // Reason: write files first, stub only confirmed writes — a stub must
      // never point at a file that failed to persist.
      const stubs = new Map<string, string>()
      for (let i = 0; i < cutoff; i++) {
        const msg = msgs[i]
        if (msg.role !== 'assistant') continue
        for (const p of msg.parts) {
          const part = p as { type: string; toolCallId?: string; state?: string; output?: unknown }
          if (!part.toolCallId || part.state !== 'output-available') continue
          const raw = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '')
          if (raw.length < ARCHIVE_MIN_CHARS || raw.startsWith('[archived:')) continue
          const path = `/context/tool-${part.toolCallId.replace(/[^\w-]/g, '')}.txt`
          try {
            const resp = await chrome.runtime.sendMessage({ type: 'vfs:write', sessionId, path, content: raw })
            if (!resp?.success) continue
            const head = raw.slice(0, ARCHIVE_HEAD_CHARS).replace(/\s+/g, ' ')
            stubs.set(part.toolCallId, `[archived: ${path} | head: ${head}]`)
          } catch { /* keep original on write failure */ }
        }
      }
      if (stubs.size === 0) return
      // Reason: keyed by toolCallId and re-read from current state, so the
      // write-back is safe even if messages changed while files were written.
      this.kstate.messages = this.kstate.messages.map(m => {
        if (m.role !== 'assistant') return m
        const hit = m.parts.some(p => {
          const t = p as { toolCallId?: string }
          return !!t.toolCallId && stubs.has(t.toolCallId)
        })
        if (!hit) return m
        return {
          ...m,
          parts: m.parts.map(p => {
            const t = p as { toolCallId?: string }
            return t.toolCallId && stubs.has(t.toolCallId) ? { ...p, output: stubs.get(t.toolCallId) } : p
          }),
        } as typeof m
      })
      console.log(`[archive] ${stubs.size} tool results moved to /context/`)
    } finally {
      this.#archiving = false
    }
  }

  // Reason: the only side-effecting boundary — host wiring overrides this to
  // build parts and drive the real chat transport. Kept protected so tests
  // exercise queue/scheduler semantics without any transport.
  protected async performSend(item: SendItem): Promise<void> {
    throw new Error(`SidekickKernel.performSend not wired (item ${item.id})`)
  }

  // Reason: one dequeue per ready window. The flushing guard holds until
  // status leaves 'ready' (a real send moves it to submitted/streaming) so
  // redundant notifications in the same window never double-dequeue; a failed
  // send resets the guard explicitly since status will not move.
  #schedule(): void {
    if (this.kstate.status !== 'ready') {
      this.#flushing = false
      return
    }
    // Reason: dispatching also covers regenerate, which marks the flag
    // directly and never takes the flushing guard — a queued send must wait
    // for its handoff instead of racing the resend into the same state.
    if (this.#scheduleHold || this.#compacting || this.#preparing || this.#flushing || this.#dispatching) return
    const next = this.#queue[0]
    if (!next) return
    this.#queue = this.#queue.slice(1)
    this.#flushing = true
    this.kstate.bump()
    this.#dispatch(next).catch(err => {
      console.error('[kernel] queue flush failed:', err)
      this.#flushing = false
    })
  }
}
