import { KernelSyncHost } from './kernel-host'
import type { PortLike } from './kernel-host'
import { KernelPool } from './kernel-pool'
import type { SessionRuntime } from './kernel-runtime'
import { COMMAND_DEDUP_CAP } from './chat-kernel'

export interface KernelMuxOptions {
  // Reason: host assembly (extras/command table) stays with the wiring code —
  // the mux only routes ports and owns binding lifecycle.
  createHost: (rt: SessionRuntime) => KernelSyncHost
}

// Reason: commands that change bindings or the global session list — they
// execute here; everything else forwards to the bound session's host.
const GLOBAL_COMMANDS = new Set(['init', 'select-session', 'new-session', 'delete-session', 'rename-session'])

interface GlobalArgs {
  mode?: 'chat' | 'pro'
  id?: string
  title?: string
  pageInfo?: { title: string; url: string } | null
  tabId?: number | null
}

// Reason: session multiplexing router — each port binds to exactly one
// session; binding pins the runtime (pool.retain) and rebinding re-runs the
// snapshot handshake over the existing resync path, so the mirror needs no
// new protocol. Command dedup covers global commands here; per-session
// commands dedup inside each kernel as before.
export class KernelMux {
  #pool: KernelPool
  #opts: KernelMuxOptions
  #hosts = new Map<string, KernelSyncHost>()
  #bindings = new Map<PortLike, { sessionId: string }>()
  // Reason: presence is a property of the panel, not of the binding — it must
  // survive a rebind (session switch) inside the same panel.
  #presence = new WeakMap<PortLike, boolean>()
  // Reason: a port can disconnect while #bind awaits session hydration —
  // binding a dead port would leak its retain forever.
  #dead = new WeakSet<PortLike>()
  #seen = new Set<string>()
  #ready: Promise<void> | null = null

  constructor(pool: KernelPool, opts: KernelMuxOptions) {
    this.#pool = pool
    this.#opts = opts
    // Reason: an evicted runtime's host must not be reused — it wraps a
    // disposed kernel. Eviction implies no bound ports (bindings retain).
    pool.onEvicted = (sessionId) => { this.#hosts.delete(sessionId) }
  }

  start(): Promise<void> {
    this.#ready ??= this.#pool.init()
    return this.#ready
  }

  attachPort(port: PortLike): void {
    port.onMessage.addListener((raw) => { this.handleMessage(port, raw).catch(e => console.error('[kernel-mux] message failed:', e)) })
    port.onDisconnect.addListener(() => this.handleDisconnect(port))
  }

  async handleMessage(port: PortLike, raw: unknown): Promise<void> {
    const m = raw as { type?: string; id?: string; name?: string; args?: unknown; visible?: unknown }
    if (m?.type === 'presence') {
      // Reason: answered synchronously and never awaited on start() — a panel
      // reports as soon as it has a snapshot, which can precede pool.sessions.
      this.#presence.set(port, m.visible === true)
      return
    }
    if (m?.type === 'sync') {
      await this.start()
      const bound = this.#bindings.get(port)
      if (bound) {
        this.#hosts.get(bound.sessionId)?.syncPort(port)
        return
      }
      // Reason: the mirror handshakes before it knows any session — bind to
      // the most recent session so the first snapshot is immediately useful;
      // the follow-up 'init' command corrects the mode if needed.
      const s = this.#pool.sessions[0] ?? this.#pool.ensureSessionFor('chat')
      await this.#bind(port, s.id)
      return
    }
    if (m?.type === 'cmd' && typeof m.id === 'string' && typeof m.name === 'string') {
      await this.start()
      if (GLOBAL_COMMANDS.has(m.name)) {
        if (!this.#dedup(m.id)) return
        await this.#global(port, m.name, (m.args ?? {}) as GlobalArgs)
        return
      }
      const bound = this.#bindings.get(port)
      if (!bound) return
      this.#hosts.get(bound.sessionId)?.command(m.id, m.name, m.args)
      return
    }
    if (m?.type === 'request' && typeof m.id === 'string' && typeof m.name === 'string') {
      await this.start()
      const bound = this.#bindings.get(port)
      if (!bound) {
        port.postMessage({ type: 'response', id: m.id, error: 'not bound' })
        return
      }
      try {
        const result = await this.#hosts.get(bound.sessionId)?.request(m.name, m.args ?? {})
        port.postMessage({ type: 'response', id: m.id, result })
      } catch (e) {
        port.postMessage({ type: 'response', id: m.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  handleDisconnect(port: PortLike): void {
    this.#dead.add(port)
    const bound = this.#bindings.get(port)
    if (!bound) return
    this.#hosts.get(bound.sessionId)?.removePort(port)
    this.#pool.release(bound.sessionId)
    this.#bindings.delete(port)
  }

  // Reason: the offscreen kernel owns both halves of "the user is looking at
  // this session" — which session each panel port is bound to, and whether
  // that panel reports itself on screen. A port that never reported counts as
  // visible: never announce a turn that might be watched.
  hasVisiblePanelFor(sessionId: string): boolean {
    for (const [port, b] of this.#bindings) {
      if (b.sessionId === sessionId && this.#presence.get(port) !== false) return true
    }
    return false
  }

  #dedup(id: string): boolean {
    if (this.#seen.has(id)) return false
    this.#seen.add(id)
    if (this.#seen.size > COMMAND_DEDUP_CAP) {
      const oldest = this.#seen.values().next().value
      if (oldest !== undefined) this.#seen.delete(oldest)
    }
    return true
  }

  #hostFor(rt: SessionRuntime): KernelSyncHost {
    let host = this.#hosts.get(rt.sessionId)
    if (!host) {
      host = this.#opts.createHost(rt)
      this.#hosts.set(rt.sessionId, host)
    }
    return host
  }

  async #bind(port: PortLike, sessionId: string): Promise<SessionRuntime | null> {
    const prev = this.#bindings.get(port)
    if (prev?.sessionId === sessionId) {
      const rt = await this.#pool.acquire(sessionId)
      if (rt) this.#hostFor(rt).syncPort(port)
      return rt
    }
    const rt = await this.#pool.retain(sessionId)
    if (!rt) return null
    // Reason: re-check after the async hydration gap — the port may have
    // rebound or disconnected while the session was loading.
    const now = this.#bindings.get(port)
    if (this.#dead.has(port) || (now && now !== prev)) {
      this.#pool.release(sessionId)
      return null
    }
    if (prev) {
      this.#hosts.get(prev.sessionId)?.removePort(port)
      this.#pool.release(prev.sessionId)
    }
    this.#bindings.set(port, { sessionId })
    this.#hostFor(rt).syncPort(port)
    return rt
  }

  // Reason: a refused rebind still has to answer the panel. The mirror only
  // clears bindingPending on a snapshot, so staying silent leaves every later
  // send waiting on a handshake that already failed.
  #resync(port: PortLike): void {
    const bound = this.#bindings.get(port)
    if (bound) this.#hosts.get(bound.sessionId)?.syncPort(port)
  }

  #applyPageCtx(sessionId: string, args: GlobalArgs): void {
    const patch: { pageInfo?: { title: string; url: string } | null; tabId?: number | null } = {}
    if (args.pageInfo !== undefined) patch.pageInfo = args.pageInfo
    if (args.tabId !== undefined) patch.tabId = args.tabId
    if (Object.keys(patch).length > 0) this.#pool.updatePageCtx(sessionId, patch)
  }

  async #global(port: PortLike, name: string, args: GlobalArgs): Promise<void> {
    switch (name) {
      case 'init': {
        const mode = args.mode ?? 'chat'
        // Reason: a panel opening is the natural sync point — pick up sessions
        // written to storage while this document sat idle (panel-mode
        // interludes, other profiles' writes).
        await this.#pool.refreshSessions()
        const bound = this.#bindings.get(port)
        const boundSession = bound ? this.#pool.sessions.find(s => s.id === bound.sessionId) : undefined
        // Reason: idempotent per mode — a reconnecting panel of the same mode
        // must not tear its session out from under itself.
        const target = boundSession && (boundSession.mode ?? 'chat') === mode
          ? boundSession
          : this.#pool.ensureSessionFor(mode)
        this.#applyPageCtx(target.id, args)
        // Reason: binding only — page extraction, the MCP tool list and the
        // craton are all built by the runtime on the first send, so entering a
        // session never waits on any of them.
        const rt = target.id === bound?.sessionId
          ? await this.#pool.acquire(target.id)
          : await this.#bind(port, target.id)
        if (!rt) this.#resync(port)
        return
      }
      case 'select-session': {
        if (!args.id) return
        const target = this.#pool.sessions.find(s => s.id === args.id)
        if (!target) {
          this.#resync(port)
          return
        }
        // Reason: UI entrance mode owns the selectable session set; a stale
        // tab-session mapping must never rebind a Chat panel to a Pro session.
        if (args.mode && (target.mode ?? 'chat') !== args.mode) {
          this.#resync(port)
          return
        }
        const rt = await this.#bind(port, args.id)
        if (!rt) this.#resync(port)
        return
      }
      case 'new-session': {
        const mode = args.mode ?? 'chat'
        const s = this.#pool.newSession(mode, args.pageInfo?.url)
        this.#applyPageCtx(s.id, args)
        await this.#bind(port, s.id)
        return
      }
      case 'delete-session': {
        if (!args.id) return
        const next = await this.#pool.deleteSession(args.id, args.mode ?? 'chat')
        this.#hosts.delete(args.id)
        for (const [p, b] of this.#bindings) {
          if (b.sessionId !== args.id) continue
          // Reason: the deleted binding's retain died with the runtime —
          // rebind bookkeeping must not release the tombstone.
          this.#bindings.delete(p)
          await this.#bind(p, next.id)
        }
        return
      }
      case 'rename-session': {
        if (args.id && args.title) this.#pool.renameSession(args.id, args.title)
        return
      }
    }
  }
}
