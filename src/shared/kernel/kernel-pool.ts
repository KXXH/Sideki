import type { ApiConfig, ChatSession, PageContent } from '../types'
import { SessionRuntime } from './kernel-runtime'
import { resolveDefaultPermissionMode } from '../permission-mode'
import type { KernelEnv, RuntimeHooks } from './kernel-runtime'

export interface PageCtx {
  pageInfo: { title: string; url: string } | null
  tabId: number | null
}

export interface KernelPoolOptions {
  // Reason: keep-warm budget for unbound runtimes — pinned runtimes (port
  // bound or mid-turn) never count against it. Purely a performance knob.
  maxIdle?: number
  // Reason: a dropped port is not a closed panel — mirrors auto-reconnect
  // within ~500ms and SW restarts churn ports. Eviction candidacy starts
  // one order of magnitude later.
  graceMs?: number
  // Reason: tests drive evictNow() deterministically; production lets the
  // pool self-schedule checks after release/turn-end.
  autoEvict?: boolean
  extractContent: (sessionId: string, tabId: number | null) => Promise<PageContent>
  onRuntimeCreated?: (rt: SessionRuntime) => void
  // Reason: hosts/routers cache per-runtime objects — they must drop them
  // when the pool discards the runtime.
  onRuntimeEvicted?: (sessionId: string) => void
}

interface Entry {
  rt: SessionRuntime
  retain: number
  lastReleaseAt: number
  unsub: () => void
}

function createSession(pageUrl: string | undefined, mode: 'chat' | 'pro'): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: 'New Chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pageUrl,
    mode,
    messages: [],
  }
}

// Reason: session multiplexing — one SessionRuntime per bound conversation,
// created on demand and evicted by LRU when idle. Global concerns (config,
// the session metadata list, CRUD) live here exactly once; everything
// conversation-scoped lives in the runtime. Eviction is pure resource
// management: an evicted session reloads from storage indistinguishably
// from a panel close/reopen in panel mode.
export class KernelPool {
  readonly env: KernelEnv
  config: ApiConfig | null = null
  sessions: ChatSession[] = []
  // Reason: router hook — the mux drops its cached host when the pool
  // discards a runtime (set after construction, so not an option).
  onEvicted: ((sessionId: string) => void) | null = null

  #entries = new Map<string, Entry>()
  #pageCtx = new Map<string, PageCtx>()
  #opts: Required<Pick<KernelPoolOptions, 'maxIdle' | 'graceMs' | 'autoEvict'>> & KernelPoolOptions
  #offConfig: (() => void) | null = null
  #evictTimer: ReturnType<typeof setTimeout> | null = null

  constructor(env: KernelEnv, opts: KernelPoolOptions) {
    this.env = env
    this.#opts = { maxIdle: 3, graceMs: 30_000, autoEvict: true, ...opts }
  }

  get liveCount(): number {
    return this.#entries.size
  }

  async init(): Promise<void> {
    try {
      const c = await this.env.loadConfig()
      if (c) this.config = c
    } catch (err) {
      console.error('[kernel-pool] loadConfig failed:', err)
    }
    this.#offConfig?.()
    this.#offConfig = this.env.onConfigChanged((c) => {
      this.config = c
      this.#notify()
      // Reason: no eager rebuild — live runtimes compare the agent fingerprint
      // on their next send (ensureAgentReady) and rebuild there, which keeps a
      // profile/MCP edit from spending a build on runtimes nobody will use.
    })
    try {
      const loaded = await this.env.loadSessions()
      this.sessions = [...loaded].sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (err) {
      console.error('[kernel-pool] loadSessions failed:', err)
    }
  }

  dispose(): void {
    this.#offConfig?.()
    this.#offConfig = null
    if (this.#evictTimer) clearTimeout(this.#evictTimer)
    for (const [id] of this.#entries) this.#evictEntry(id)
  }

  // Reason: the offscreen document outlives panel-mode interludes — sessions
  // created while this pool was idle exist only in storage. Refresh on every
  // panel init; live runtime copies stay authoritative (in-flight saves),
  // and local sessions missing from a stale read are kept, not dropped.
  async refreshSessions(): Promise<void> {
    try {
      const loaded = await this.env.loadSessions()
      const merged = loaded.map(s => this.#entries.get(s.id)?.rt.session ?? s)
      for (const s of this.sessions) {
        if (!merged.some(m => m.id === s.id)) merged.push(s)
      }
      this.sessions = merged.sort((a, b) => b.updatedAt - a.updatedAt)
      this.#notify()
    } catch (err) {
      console.warn('[kernel-pool] refreshSessions failed:', err)
    }
  }

  // Reason: pool-level changes (session list, config) must reach every
  // bound mirror — extras ride on kstate broadcasts, so poke each live
  // runtime's rev channel once.
  #notify(): void {
    for (const [, e] of this.#entries) e.rt.kstate.bump()
  }

  // --- page context (per session) ---

  updatePageCtx(sessionId: string, ctx: Partial<PageCtx>): void {
    const cur = this.#pageCtx.get(sessionId) ?? { pageInfo: null, tabId: null }
    this.#pageCtx.set(sessionId, {
      pageInfo: ctx.pageInfo !== undefined ? ctx.pageInfo : cur.pageInfo,
      tabId: ctx.tabId !== undefined ? ctx.tabId : cur.tabId,
    })
  }

  // --- acquisition & pinning ---

  // Reason: cold acquisition hydrates the full conversation via
  // env.loadSession — the pool's list may hold metadata-only entries (the
  // env proxy strips message bodies to stay under the message size cap).
  // Hydration is keyed on messageCount, not empty messages: just-created
  // sessions are genuinely empty, and loading them would drag a full
  // storage read into the new-session click path.
  async acquire(sessionId: string): Promise<SessionRuntime | null> {
    const existing = this.#entries.get(sessionId)
    if (existing) return existing.rt
    const meta = this.sessions.find(s => s.id === sessionId)
    if (!meta) return null
    const needsHydration = !meta.messages?.length && (meta.messageCount ?? 0) > 0
    const full = needsHydration ? await this.env.loadSession(sessionId) : meta
    if (!full) return null
    // Reason: an async gap — another caller may have created the runtime
    // (or deleted the session) while we were hydrating.
    const raced = this.#entries.get(sessionId)
    if (raced) return raced.rt
    const currentMeta = this.sessions.find(s => s.id === sessionId)
    if (!currentMeta) return null
    // Reason: a rename during hydration must not be overwritten by the earlier body read.
    const session = currentMeta.title === meta.title ? full : { ...full, title: currentMeta.title }

    const hooks: RuntimeHooks = {
      getPageInfo: () => this.#pageCtx.get(sessionId)?.pageInfo ?? null,
      getCurrentTabId: () => this.#pageCtx.get(sessionId)?.tabId ?? null,
      extractContent: () => this.#opts.extractContent(sessionId, this.#pageCtx.get(sessionId)?.tabId ?? null),
    }
    const rt = new SessionRuntime({
      session,
      env: this.env,
      hooks,
      getConfig: () => this.config,
      onSessionUpdated: (updated) => {
        this.sessions = this.sessions.map(s => s.id === updated.id ? updated : s)
        this.#notify()
      },
    })
    // Reason: a turn finishing while unbound (panel closed mid-stream) must
    // still trigger an eviction check — release alone would never fire again.
    const unsub = rt.kstate.subscribe(() => {
      const e = this.#entries.get(sessionId)
      if (e && e.retain <= 0 && rt.kstate.status === 'ready') this.#scheduleEvict()
    })
    this.#entries.set(sessionId, { rt, retain: 0, lastReleaseAt: Date.now(), unsub })
    this.#opts.onRuntimeCreated?.(rt)
    return rt
  }

  async retain(sessionId: string): Promise<SessionRuntime | null> {
    const rt = await this.acquire(sessionId)
    if (!rt) return null
    const e = this.#entries.get(sessionId)!
    e.retain++
    return rt
  }

  release(sessionId: string): void {
    const e = this.#entries.get(sessionId)
    if (!e) return
    e.retain = Math.max(0, e.retain - 1)
    if (e.retain === 0) {
      e.lastReleaseAt = Date.now()
      this.#scheduleEvict()
    }
  }

  // --- eviction (pinned / grace / idle) ---

  #scheduleEvict(): void {
    if (!this.#opts.autoEvict) return
    if (this.#evictTimer) return
    this.#evictTimer = setTimeout(() => {
      this.#evictTimer = null
      this.evictNow()
    }, this.#opts.graceMs + 1000)
  }

  evictNow(now = Date.now()): number {
    const evictable: { id: string; e: Entry }[] = []
    for (const [id, e] of this.#entries) {
      const k = e.rt.kernel
      const pinned = e.retain > 0
        || e.rt.kstate.status !== 'ready'
        || k.compacting || k.preparing || k.dispatching || k.queue.length > 0
      if (pinned) continue
      if (now - e.lastReleaseAt < this.#opts.graceMs) continue
      evictable.push({ id, e })
    }
    // Reason: soft cap — keep the most recently used maxIdle warm, evict the
    // rest oldest-first. Pinned/grace runtimes never count against the cap.
    evictable.sort((a, b) => a.e.lastReleaseAt - b.e.lastReleaseAt)
    const excess = evictable.length - this.#opts.maxIdle
    let evicted = 0
    for (let i = 0; i < excess; i++) {
      this.#evictEntry(evictable[i].id)
      evicted++
    }
    return evicted
  }

  #evictEntry(sessionId: string): void {
    const e = this.#entries.get(sessionId)
    if (!e) return
    e.rt.flushSave()
    e.unsub()
    // Reason: shutdown hooks (automation subscriptions) must be gone before
    // dispose() stops the chat — an abort settles into a ready edge that
    // would otherwise check-point or announce a discarded runtime.
    this.#opts.onRuntimeEvicted?.(sessionId)
    e.rt.dispose()
    this.#entries.delete(sessionId)
    this.onEvicted?.(sessionId)
  }

  // --- session CRUD (global) ---

  ensureSessionFor(mode: 'chat' | 'pro'): ChatSession {
    const found = this.sessions.find(s => (s.mode ?? 'chat') === mode)
    if (found) return found
    return this.newSession(mode)
  }

  newSession(mode: 'chat' | 'pro', pageUrl?: string): ChatSession {
    const s = createSession(pageUrl, mode)
    s.permissionMode = resolveDefaultPermissionMode(this.config)
    this.sessions = [s, ...this.sessions]
    this.env.saveSession(s).catch(() => {})
    this.#notify()
    return s
  }

  async deleteSession(id: string, mode: 'chat' | 'pro'): Promise<ChatSession> {
    // Reason: stop the runtime before storage is touched — a checkpoint or
    // title save queued behind the delete would resurrect the record.
    this.#evictDeleted(id)
    await this.env.deleteSession(id)
    await this.env.removeHistory(id).catch(() => {})
    this.sessions = this.sessions.filter(s => s.id !== id)
    this.#notify()
    return this.ensureSessionFor(mode)
  }

  // Reason: a deleted session's runtime must not flush a final save — that
  // would resurrect the session in storage.
  #evictDeleted(sessionId: string): void {
    const e = this.#entries.get(sessionId)
    if (!e) return
    e.unsub()
    this.#opts.onRuntimeEvicted?.(sessionId)
    e.rt.dispose()
    this.#entries.delete(sessionId)
    this.onEvicted?.(sessionId)
  }

  renameSession(id: string, title: string): void {
    if (!title) return
    // Reason: the timestamp must advance with the rename (same rule as
    // updateSessionMeta) and the runtime copy must carry it, or its next
    // flushSave writes the stale timestamp back and delta sync skips it.
    const updatedAt = Date.now()
    this.sessions = this.sessions.map(s => s.id === id ? { ...s, title, updatedAt } : s)
    const target = this.sessions.find(s => s.id === id)
    if (target) {
      this.env.updateSessionMeta(id, { title, updatedAt }).catch(() => {})
      this.#entries.get(id)?.rt.applySessionMeta(target)
    }
    this.#notify()
  }
}
