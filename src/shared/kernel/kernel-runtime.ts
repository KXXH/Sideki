import type { TimerWake } from '../scheduled-task'
import { parsePageContent } from '../parser'
import { DirectChatTransport, dynamicTool, jsonSchema } from 'ai'
import type { ChatTransport, UIMessage } from 'ai'
import { createAgent } from '../agent'
import type { CratonSnapshot, DebugStatus } from '../agent'
import { prepareOutgoingMessages, visibleText, savedFileParts, buildUserParts } from '../message-protocol'
import type { SidekickMetadata, SkillPartData } from '../message-protocol'
import { generateTitle } from '../ai-provider'
import { mirrorAttachments } from '../attachment-mirror'
import { peekOperatingTabId, acquireTurnTab } from '../tools/bridge'
import type { McpToolMeta } from '../mcp-client'
import { agentFingerprint } from '../agent-fingerprint'
import type { ApiConfig, PageContent, ChatSession } from '../types'
import { SidekickKernel, KernelChat } from './chat-kernel'
import type { SendItem } from './chat-kernel'

// Reason: environment seam — the runtime itself never touches chrome.storage
// or chrome.tabs directly. The panel host implements this with direct chrome
// calls; the offscreen host proxies through the service worker (offscreen
// documents only get chrome.runtime).
export interface KernelEnv {
  loadConfig(): Promise<ApiConfig | null>
  onConfigChanged(cb: (config: ApiConfig) => void): () => void
  // Reason: the session list travels as metadata only — full message bodies
  // (screenshots!) would blow past the runtime message size cap when proxied
  // in one frame. loadSession hydrates a single conversation on demand.
  loadSessions(): Promise<ChatSession[]>
  loadSession(id: string): Promise<ChatSession | null>
  saveSession(session: ChatSession): Promise<void>
  updateSessionMeta(id: string, patch: Partial<Pick<ChatSession, 'title' | 'updatedAt'>>): Promise<void>
  deleteSession(id: string): Promise<void>
  removeHistory(sessionId: string): Promise<void>
  sendMessage(msg: Record<string, unknown>): Promise<unknown>
  // Reason: host-specific "can the user see this session right now" probe —
  // the offscreen host answers from its panel port bindings, a panel-hosted
  // runtime from its own document visibility. Absent = treated as visible, so
  // a host that cannot answer never announces a turn someone may be watching.
  isSessionForeground?(sessionId: string): boolean
}

// Reason: UI-adjacent inputs the runtime cannot own — page identity belongs
// to the panel's window; injected as getters so the runtime always reads
// fresh values without holding React state. Per-session in the multiplexed
// pool: each runtime sees only its own binding's page context.
export interface RuntimeHooks {
  getPageInfo(): { title: string; url: string } | null
  extractContent(): Promise<PageContent>
  getCurrentTabId(): number | null
}

class RuntimeKernel extends SidekickKernel {
  sendFn: (item: SendItem) => Promise<void> = async () => { throw new Error('kernel send not wired') }
  protected override performSend(item: SendItem): Promise<void> {
    return this.sendFn(item)
  }
  markPreparing(v: boolean): void {
    this.setPreparing(v)
  }
}

export interface SessionRuntimeInit {
  session: ChatSession
  getConfig: () => ApiConfig | null
  env: KernelEnv
  hooks: RuntimeHooks
  // Reason: session metadata (title/messages/updatedAt) is owned by the
  // pool's list — the runtime reports every persisted change upward so the
  // list and the runtime's local copy never diverge.
  onSessionUpdated?: (session: ChatSession) => void
}

// Reason: one conversation's complete headless unit — kernel state, queue,
// agent assembly (craton/MCP/transport), send pipeline, title generation and
// debounced persistence. The session-multiplexing pool instantiates one per
// bound session; nothing in here is shared between sessions.
export class SessionRuntime {
  readonly kernel: RuntimeKernel
  readonly chat: KernelChat<UIMessage>
  readonly env: KernelEnv
  readonly hooks: RuntimeHooks
  readonly sessionId: string

  session: ChatSession
  currentTurnPage: { title: string; url: string } | null = null
  lastTurnAborted = false
  lastTurnTokens = { input: 0, output: 0, reasoning: 0 }
  craton: CratonSnapshot | null = null

  // Reason: ref-shaped containers — createAgent's signature takes { current }
  // boxes (shared with the hook era); plain objects satisfy it headlessly.
  readonly pageContextRef: { current: PageContent | null } = { current: null }
  readonly pageImagesRef: { current: string[] } = { current: [] }
  readonly debugStatusRef: { current: DebugStatus | null } = { current: null }
  private sessionIdRef = { current: '' }
  private hostnameRef = { current: '' }

  private getConfig: () => ApiConfig | null
  private onSessionUpdated?: (session: ChatSession) => void
  private pageLocked = false
  private cratonHasContent = false
  private agentFp = ''
  private mcpTools: Record<string, unknown> = {}
  private buildGeneration = 0
  private realTransport: ChatTransport<UIMessage> | null = null
  private relayedIds = new Set<string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private timerTabId: number | null = null
  private timerWake: TimerWake | null = null
  private disposed = false
  private lastSavedMessages: UIMessage[] | null = null

  constructor(init: SessionRuntimeInit) {
    this.env = init.env
    this.hooks = init.hooks
    this.session = init.session
    this.sessionId = init.session.id
    this.sessionIdRef.current = init.session.id
    this.getConfig = init.getConfig
    this.onSessionUpdated = init.onSessionUpdated

    this.kernel = new RuntimeKernel({
      getConfig: () => this.getConfig(),
      getSessionId: () => this.sessionId,
      // Reason: seed the turn's tab stack up front — the turn keeps one stable
      // tab reference for its whole life, even for turns that call no tools.
      onTurnStart: async (item) => {
        const previousWasTimer = this.timerTabId != null
        this.timerTabId = null
        this.timerWake = null
        this.currentTurnPage = null
        const timer = item.opts?.timer
        if (timer) {
          const result = await this.env.sendMessage({ type: 'schedule:acquire', sessionId: this.sessionId, ...timer }) as { success?: boolean; error?: string; title: string; url: string }
          if (!result?.success) throw new Error(result?.error ?? '无法恢复任务页面')
          this.timerWake = timer
          this.timerTabId = timer.tabId
          this.currentTurnPage = { title: result.title, url: result.url }
        } else {
          if (previousWasTimer) await this.env.sendMessage({ type: 'tab-lock:release', sessionId: this.sessionId })
          await acquireTurnTab({ getSessionId: () => this.sessionId, getTabId: () => this.hooks.getCurrentTabId() })
        }
      },
    })
    this.kernel.sendFn = (item) => this.sendNow(item)

    // Reason: stable wrapper — KernelChat captures the transport once; the
    // real DirectChatTransport is swapped in after each agent (re)build.
    // prepareOutgoingMessages here is the same pipeline the session
    // inspector calls, so previews never drift.
    const transport: ChatTransport<UIMessage> = {
      sendMessages: async (opts) => {
        if (!this.realTransport) throw new Error('Config not loaded yet')
        const expanded = prepareOutgoingMessages(opts.messages)
        return this.realTransport.sendMessages({ ...opts, messages: expanded })
      },
      reconnectToStream: async () => null,
    }
    this.chat = new KernelChat<UIMessage>({
      state: this.kernel.kstate,
      transport,
      onFinish: (opts) => { this.lastTurnAborted = opts.isAbort; this.onTurnFinish(opts.message).catch(() => {}) },
      onError: (err) => { console.error('[session-runtime] error:', err) },
    })

    const msgs = sessionMessages(init.session)
    // Reason: a checkpointed session died mid-turn — mark the trailing
    // assistant message so the model/UI can see the cut. Status is ready
    // (fresh kernel), matching today's panel-close semantics.
    if (init.session.interrupted && msgs.length > 0) {
      const last = msgs[msgs.length - 1]
      if (last.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          metadata: { ...(last.metadata ?? {}), interrupted: true },
        } as UIMessage
      }
    }
    this.kstate.messages = msgs
    this.lastSavedMessages = this.kstate.messages
  }

  get kstate() {
    return this.kernel.kstate
  }

  get relayedIdSet(): Set<string> {
    return this.relayedIds
  }

  private bump(): void {
    this.kstate.bump()
  }

  async stop(): Promise<void> {
    if (!this.kernel.cancelPreparation()) await this.chat.stop()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.kernel.cancelPreparation()
    this.buildGeneration++
    this.realTransport = null
    // Reason: dispose can land mid-turn (deleted session, pool shutdown) — an
    // abort settling afterwards must not checkpoint, title-generate or drain
    // the queue into a session that no longer exists.
    this.kernel.clearQueue()
    void this.chat.stop().catch(() => {})
    // Reason: safety net for the paths that discard a runtime without a turn
    // boundary (session deleted mid-turn, pool shutdown) — a leaked tab lock
    // would block every other session on that tab until it goes stale.
    this.env.sendMessage({ type: 'tab-lock:release', sessionId: this.sessionId }).catch(() => {})
  }

  // Reason: pool-side rename must reach the runtime's local copy — flushSave
  // would otherwise resurrect the stale title on the next save.
  applySessionMeta(session: ChatSession): void {
    this.session = { ...this.session, title: session.title, pageUrl: session.pageUrl, updatedAt: session.updatedAt }
  }

  // --- page context (craton input) ---

  // Reason: lock page context after first message — the system prompt prefix
  // must stay fixed for prompt cache. Cold loads (session switch) unlock.
  offerPageContext(content: PageContent | null): void {
    if (this.kstate.messages.length > 0) this.pageLocked = true
    if (this.pageLocked) return
    this.pageContextRef.current = content
    this.pageImagesRef.current = content?.images ?? []
  }

  private refreshHostname(): void {
    const url = this.hooks.getPageInfo()?.url
    this.hostnameRef.current = url ? (() => { try { return new URL(url).hostname } catch { return '' } })() : ''
  }

  // Reason: chrome://, edge://, about: and web-store pages refuse script
  // injection — skip the doomed extraction round-trip. Unknown page identity
  // still attempts extraction (the SW resolves the active tab itself).
  private isInjectablePage(): boolean {
    const url = this.hooks.getPageInfo()?.url
    if (!url) return true
    return /^(https?|file):/.test(url)
  }

  // --- agent assembly (craton + MCP + transport) ---

  // Reason: craton construction is lazy — entry actions (new session, switch,
  // reopen) must not pay for it. The first send (or regenerate) calls
  // ensureAgentReady, which extracts content and lands here once. Later sends
  // rebuild only on a fingerprint drift (profile/MCP edits) or new content.
  // MCP tool fetching is part of the build so the agent always waits for MCP
  // tools — no race between agent creation and MCP connection.
  private async rebuildAgentIfNeeded(signal?: AbortSignal): Promise<void> {
    const config = this.getConfig()
    if (!config) return
    const fp = agentFingerprint(config)
    const drifted = fp !== this.agentFp
    if (drifted) {
      console.log('[agent rebuild] fingerprint changed')
      this.cratonHasContent = false
      this.realTransport = null
    }
    if (this.realTransport && this.cratonHasContent) return
    if (this.realTransport && !this.pageContextRef.current) return
    if (this.pageContextRef.current) this.cratonHasContent = true

    const generation = ++this.buildGeneration

    // Reason: temporary probe — splits the visible warm-up into its MCP part
    // and the rest, so "the new session still waits" can be attributed.
    const buildT0 = Date.now()
    let mcpMs = 0
    let mcpRes: { errors?: Record<string, string>; tools?: McpToolMeta[]; diag?: string[] } | undefined
    let mcpThrew = false

    try {
      // Reason: the SW owns the MCP connections and their tool cache, and it is
      // the only context that can tell "nothing has changed" from "connections
      // were rebuilt underneath us" — it makes the refresh decision, this side
      // just asks once for the current list instead of driving connect + list.
      try {
        const tMcp = Date.now()
        mcpRes = await this.env.sendMessage({ type: 'mcp:ensure' }) as typeof mcpRes
        mcpMs = Date.now() - tMcp
        signal?.throwIfAborted()
        if (generation !== this.buildGeneration) return
        const res = mcpRes
        const meta = Array.isArray(res?.tools) ? res.tools : []
        console.log(`[MCP] probe ${mcpMs}ms: ${(res?.diag ?? []).join(' | ') || '(no diag)'}`)
        const proxyTools: Record<string, unknown> = {}
        if (meta.length) {
          console.log(`[MCP] ${meta.length} tools:`, meta.map(m => m.qualifiedName).join(', '))
          for (const m of meta) {
            proxyTools[m.qualifiedName] = dynamicTool({
              description: m.description,
              inputSchema: jsonSchema(m.inputSchema),
              execute: async (args: unknown, { abortSignal }: { abortSignal?: AbortSignal }) => {
                const responsePromise = this.env.sendMessage({
                  type: 'mcp:call-tool',
                  qualifiedName: m.qualifiedName,
                  args,
                  // Reason: consent routing and site attribution should name
                  // the page the turn is operating on, not whichever tab the
                  // user switched to. Peek (never seed) — a pure-MCP turn must
                  // stay lock-free.
                  tabId: await peekOperatingTabId({
                    getSessionId: () => this.sessionId,
                    getTabId: () => this.hooks.getCurrentTabId(),
                  }),
                }) as Promise<{ error?: string } | undefined>
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
        this.mcpTools = proxyTools
      } catch (e) {
        signal?.throwIfAborted()
        mcpThrew = true
        // Reason: after a config drift the old qualified names may no longer
        // exist — serving them for a turn is worse than serving none.
        if (drifted) this.mcpTools = {}
        console.warn('[MCP] tool fetch failed:', e)
      }

      signal?.throwIfAborted()
      if (generation !== this.buildGeneration) return
      // Reason: a build that lost the whole tool table must not become the
      // fingerprint's new home — otherwise a transient failure permanently
      // freezes this session on an empty/stale tool table. A partial failure
      // keeps the tools that did load and does not force a rebuild per send.
      const mcpFailed = mcpThrew || (mcpRes !== undefined && (
        !Array.isArray(mcpRes.tools)
        || (mcpRes.tools.length === 0 && mcpRes.errors != null && Object.keys(mcpRes.errors).length > 0)
      ))
      console.log('[agent rebuild] creating agent, model:', config.model)
      this.refreshHostname()
      const tools = Object.keys(this.mcpTools).length > 0 ? this.mcpTools : undefined
      // Reason: per-session tool context — concurrent kernels must route
      // tool calls to their own tab and virtual filesystem.
      const agentStarted = Date.now()
      const agent = await createAgent(
        config, this.pageContextRef, this.pageImagesRef, this.debugStatusRef,
        this.sessionIdRef, this.hostnameRef, tools, () => {},
        { getSessionId: () => this.sessionId, getTabId: () => this.timerTabId ?? this.hooks.getCurrentTabId(), isPinned: () => this.timerTabId != null, getTurnPage: () => this.currentTurnPage, getStepLimit: () => this.timerWake?.kind === 'monitor' ? 20 : undefined },
        this.session.mode ?? 'chat',
        // Reason: multiplexed runtimes cannot share the module-level craton
        // singleton — this runtime owns its inspector-visible frozen prompt.
        (craton) => { if (!signal?.aborted && generation === this.buildGeneration) this.craton = craton },
      )
      signal?.throwIfAborted()
      if (generation !== this.buildGeneration) return
      console.log(`[agent init] createAgent ${Date.now() - agentStarted}ms`)
      this.installTransport(agent)
      // Reason: only a build that saw the current MCP table may claim the new
      // fingerprint; on failure the previous one (often '') keeps agentStale()
      // true so the next send retries instead of freezing the tool table.
      this.agentFp = mcpFailed ? '' : fp
    } finally {
      if (generation === this.buildGeneration) {
        console.log(`[agent rebuild] ready in ${Date.now() - buildT0}ms (mcp ${mcpMs}ms)`)
      }
    }
  }

  // Reason: the one place a session's craton comes into existence. Entry
  // actions stay free (no extraction, no MCP listing, no agent) — the cost is
  // paid by the first thing that actually needs the agent, wrapped in the
  // kernel's preparing flag so the UI can say what is being waited on.
  private async extractTimerContent(tabId: number): Promise<PageContent> {
    const response = await this.env.sendMessage({ type: 'extract-content', tabId }) as { success: boolean; data: Parameters<typeof parsePageContent>[0]; error?: string }
    if (!response.success) throw new Error(response.error ?? '无法读取目标页面')
    return parsePageContent(response.data)
  }

  private async ensureAgentReady(): Promise<void> {
    const needsContent = !this.pageContextRef.current && this.isInjectablePage()
    if (!needsContent && this.cratonHasContent && !this.agentStale()) return
    return this.kernel.prepareAgent(async signal => {
      const started = Date.now()
      if (needsContent) {
        // Reason: extraction failure (chrome:// pages, PDF viewers, store
        // pages refuse injection) degrades to a content-less craton — it must
        // never abort the send or skip the agent build below.
        try {
          const content = this.timerTabId != null
            ? await this.extractTimerContent(this.timerTabId)
            : await this.hooks.extractContent()
          signal.throwIfAborted()
          this.pageContextRef.current = content
          this.pageImagesRef.current = content.images ?? []
        } catch (e) {
          console.warn('[session-runtime] extract failed, sending without page content:', e)
        }
      }
      signal.throwIfAborted()
      console.log(`[agent init] page ${Date.now() - started}ms`)
      this.cratonHasContent = false
      await this.rebuildAgentIfNeeded(signal)
      console.log(`[agent init] total ${Date.now() - started}ms`)
    })
  }

  private installTransport(agent: Awaited<ReturnType<typeof createAgent>>): void {
    // Reason: SDK 7 provides performance stats per step (finish-step), not per
    // turn (finish). Accumulate across steps: elapsed sums stepTimeMs, TTFT
    // comes from the first step, reasoning time is tracked manually.
    let reasoningStartMs = 0
    let reasoningElapsed = 0
    let totalElapsedMs = 0
    let firstTtftMs: number | null = null
    let lastStepSpeed: number | undefined
    let lastStepInputTokens = 0

    this.realTransport = new DirectChatTransport({
      agent,
      sendReasoning: true,
      // Reason: SDK default onError masks all errors as "An error occurred."
      // — pointless for a fully local extension. Pass through the real
      // message so tool/stream failures are debuggable.
      onError: (err) => err instanceof Error ? err.message : String(err),
      messageMetadata: ({ part }) => {
        if (part.type === 'start') {
          reasoningStartMs = 0
          reasoningElapsed = 0
          totalElapsedMs = 0
          firstTtftMs = null
          lastStepSpeed = undefined
          lastStepInputTokens = 0
          if (this.timerWake) return { v: 2, source: 'timer', timer: this.timerWake }
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
            // Reason: commit per step, not only at 'finish' — abort/error
            // mid-turn would otherwise leave the context indicator stale.
            if (lastStepInputTokens > 0 && this.lastTurnTokens.input !== lastStepInputTokens) {
              this.lastTurnTokens = { ...this.lastTurnTokens, input: lastStepInputTokens }
              this.bump()
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
          this.lastTurnTokens = { input: prompt, output: tokens, reasoning }
          this.bump()
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

  // --- send pipeline ---

  // Reason: staleness probe for the hot send path — transport missing (never
  // built / failed build / rebuild in flight) or the agent fingerprint
  // drifted (profile switch or MCP edit nobody has acted on yet).
  private agentStale(): boolean {
    const config = this.getConfig()
    if (!config) return false
    return this.realTransport == null || agentFingerprint(config) !== this.agentFp
  }

  private async sendNow(item: SendItem): Promise<void> {
    if (this.disposed) return
    this.lastTurnAborted = false
    const { text, attachments, opts } = item
    const dispatchToken = this.kernel.dispatchToken
    if (!this.realTransport && !this.getConfig()) {
      // Reason: same silent-drop class as the transport check below — a
      // dropped message must always leave a visible trace.
      this.kstate.error = new Error('AI 未就绪：配置未加载，请检查设置')
      this.kernel.releaseHandoff()
      return
    }

    // Reason: protocol v2 — visible text, skill/element data parts and UI
    // flags stay structured; expandForModel composes model input at send time.
    const metadata: SidekickMetadata = { v: 2 }
    if (opts?.fromBridge) metadata.source = 'claude-code'
    if (opts?.timer) { metadata.source = 'timer'; metadata.timer = opts.timer }
    // Reason: same provenance contract as the panel send path — the reply's
    // page link is derived from this metadata, and mirror mode only reaches
    // this branch.
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
      this.kernel.releaseHandoff()
      return
    }
    this.kstate.pushMessage({ id: pendingId, role: 'user', parts: pendingParts, metadata } as UIMessage)

    // Reason: #dispatch already owns the dispatch flag (it starts before tab
    // seeding); this side only lowers it at the handoff or on its own exit.
    try {
      try {
        await this.ensureAgentReady()
      } catch (error) {
        // Reason: preparation never leaves ready, so turn automation cannot release its tab lock.
        // Await cleanup before lowering dispatching; queued continuations retain the existing stack.
        if (!this.disposed && this.kernel.queue.length === 0 && dispatchToken === this.kernel.dispatchToken) {
          await this.env.sendMessage({ type: 'tab-lock:release', sessionId: this.sessionId }).catch(() => {})
        }
        throw error
      }
      if (this.disposed) {
        this.kernel.releaseHandoff()
        return
      }
      if (!this.realTransport) {
        // Reason: a silent drop looks like a dead extension — surface the real
        // blocker (config missing / agent build failed) in the chat error slot.
        this.kstate.error = new Error('AI 未就绪：配置未加载或初始化失败，请检查设置')
        this.kernel.releaseHandoff()
        return
      }
      this.pageLocked = true

      // Reason: file bytes were uploaded before enqueue; only session-bound references become model notes and UI parts.
      const { notes: attachmentNotes, savedFiles } = await mirrorAttachments(
        attachments,
        this.sessionId,
        !!this.getConfig()?.labImageFs,
        msg => this.env.sendMessage(msg),
      ).catch(error => {
        this.kstate.error = error instanceof Error ? error : new Error(String(error))
        throw error
      })
      if (this.disposed) {
        this.kernel.releaseHandoff()
        return
      }
      // Reason: commit a fresh object — the metadata pushed above must never be
      // mutated in place, since the kernel state holds that very reference.
      const finalMetadata: SidekickMetadata = attachmentNotes ? { ...metadata, attachmentNotes } : metadata
      const parts = buildUserParts({ text, attachments, skill: opts?.skill, savedFiles })
      if (parts.length === 0) {
        // Reason: nothing survived to send after all — retract the placeholder
        // rather than leave a bubble with no request behind it.
        this.kstate.popMessage()
        this.kernel.releaseHandoff()
        return
      }
      // Reason: messageId commits into the placeholder pushed above — same id,
      // same position, so the bubble never duplicates or flickers.
      const handedOff = this.chat.sendMessage({ parts, metadata: finalMetadata, messageId: pendingId })
      // Reason: sendMessage flips status to 'submitted' synchronously — from now
      // on the status carries the turn, so this dispatch releases its flag.
      this.kernel.endDispatch(dispatchToken)
      await handedOff
    } finally {
      // Reason: token-scoped — a later queued dispatch may already own the
      // flag by the time the turn's promise settles.
      this.kernel.endDispatch(dispatchToken)
    }
  }

  // --- turn finish: bridge relay + title generation ---

  private async onTurnFinish(message: UIMessage): Promise<void> {
    if (this.disposed) return
    const config = this.getConfig()
    if (!config) return

    // Reason: relay AI response to CC via bridge (if connected)
    if ((this.session.mode ?? 'chat') === 'pro') {
      const text = message.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('')
        .trim()
      if (text.length > 10) {
        this.env.sendMessage({ type: 'bridge:send', text })
          .then((resp) => {
            if (!(resp as { sent?: boolean } | undefined)?.sent) return
            if (this.relayedIds.has(message.id)) return
            this.relayedIds.add(message.id)
            // Reason: mark relay via metadata so AI sees it next turn while
            // UI reads the flag without text parsing
            this.kstate.messages = this.kstate.messages.map(m => {
              if (m.id !== message.id) return m
              const meta = (m.metadata ?? {}) as SidekickMetadata
              if (meta.relayed) return m
              return { ...m, metadata: { ...meta, v: 2 as const, relayed: true } } as typeof m
            })
          })
          .catch(() => {})
      }
    }

    // Reason: auto-generate title on first assistant response
    if (this.session.title !== 'New Chat') return
    const firstUserMsg = this.kstate.messages.find(m => m.role === 'user')
    const firstUserText = firstUserMsg ? visibleText(firstUserMsg) : ''
    const assistantText = message.parts
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('')
    if (!firstUserText || !assistantText) return

    let title: string
    try {
      title = await generateTitle(config, this.sessionId, firstUserText, assistantText, this.hooks.getPageInfo())
    } catch (err) {
      console.error('[generateTitle] failed:', err)
      title = firstUserText.length > 30 ? firstUserText.slice(0, 30) + '...' : firstUserText
    }
    this.session = { ...this.session, title, updatedAt: Date.now() }
    this.env.saveSession(this.session).catch(() => {})
    this.onSessionUpdated?.(this.session)
    this.bump()
  }

  // --- persistence ---

  flushSave(): void {
    if (this.disposed) return
    const msgs = this.kstate.messages
    if (msgs.length === 0) return
    const interrupted = this.kstate.status !== 'ready'
    // Reason: copy-on-write gives a complete change signal — a same-length
    // streamed checkpoint still needs a newer updatedAt or delta sync treats
    // the offline body as unchanged. Interrupted marks mid-turn checkpoints
    // and is cleared by the next ready-state save.
    const changed = this.lastSavedMessages !== null
      && (this.lastSavedMessages !== msgs || this.session.interrupted !== interrupted)
    this.session = {
      ...this.session,
      messages: msgs,
      // Reason: keep the metadata count honest — hydrated sessions inherit a
      // stale messageCount from the stripped list entry otherwise.
      messageCount: msgs.length,
      interrupted,
      ...(changed ? { updatedAt: Date.now() } : {}),
    }
    this.lastSavedMessages = msgs
    this.env.saveSession(this.session).catch(() => {})
    this.onSessionUpdated?.(this.session)
    this.bump()
  }

  scheduleSave(): void {
    if (this.disposed) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flushSave(), 300)
  }

  // Reason: a new session's title comes from an LLM call that only starts
  // after the ready transition — the SDK flips status before calling onFinish,
  // where the title is generated — so anything reading the session at the turn
  // boundary still sees the placeholder. Waiting here keeps a completion
  // notice from announcing 'New Chat' a second before the real title lands.
  settleTitle(timeoutMs = 3000): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.session.title !== 'New Chat') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      const unsubscribe = this.kstate.subscribe(() => {
        if (this.session.title !== 'New Chat') finish()
      })
    })
  }

  // --- message-level operations ---

  regenerate(messageId: string): void {
    const messages = this.kstate.messages
    const idx = messages.findIndex(m => m.id === messageId)
    if (idx < 0 || messages[idx].role !== 'assistant') return
    const before = messages.slice(0, idx)
    const lastUserIdx = before.map(m => m.role).lastIndexOf('user')
    if (lastUserIdx < 0) {
      this.kstate.messages = before
      return
    }
    // Reason: resend the full structured message (data-skill/data-element/
    // file parts + metadata) — a plain-text resend would drop v2 context.
    // The last user turn stays on screen through the lazy build so the reply
    // slot has an anchor; the handoff commits into that same message id.
    const lastUser = before[lastUserIdx]
    // Reason: replaying a completed timer bypasses its page binding and occurrence claim.
    if ((lastUser.metadata as SidekickMetadata | undefined)?.source === 'timer') {
      this.kstate.error = new Error('请在会话中发送新的检查请求，或恢复暂停的定时任务')
      return
    }
    this.kstate.messages = before
    // Reason: regenerate is a send — a session nobody has sent in yet has no
    // transport, so the craton is built here too, under the same busy truth as
    // a normal send.
    const dispatchToken = this.kernel.beginDispatch()
    void this.ensureAgentReady().then(() => {
      if (this.disposed) return
      if (!this.realTransport) {
        this.kstate.error = new Error('AI 未就绪：配置未加载或初始化失败，请检查设置')
        return
      }
      const handedOff = this.chat.sendMessage({ parts: lastUser.parts, metadata: lastUser.metadata, messageId: lastUser.id } as Parameters<typeof this.chat.sendMessage>[0])
      this.kernel.endDispatch(dispatchToken)
      return handedOff
    }).catch(err => console.error('[session-runtime] regenerate failed:', err))
      .finally(() => this.kernel.endDispatch(dispatchToken))
  }

  injectMessage(role: 'user' | 'assistant', text: string, metadata?: Record<string, unknown>): void {
    const msg = {
      id: crypto.randomUUID(),
      role,
      parts: [{ type: 'text', text }],
      ...(metadata ? { metadata } : {}),
    } as unknown as UIMessage
    this.kstate.pushMessage(msg)
  }
}

// Reason: storage may contain old ChatMessage format (no id, different part
// types) or new UIMessage format — detect and migrate on read.
export function migrateMessage(msg: Record<string, unknown>): UIMessage {
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

export function sessionMessages(s: ChatSession): UIMessage[] {
  if (!s.messages?.length) return []
  return (s.messages as Array<Record<string, unknown>>).map(migrateMessage)
}

export type { SendItem, SkillPartData }
