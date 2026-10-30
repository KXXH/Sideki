import type { UIMessage } from 'ai'
import type { SidekickKernel } from './chat-kernel'
import { snapshotFrom, diffPatch, type KernelSnapshotSource } from './sync-protocol'

// Reason: structural subset of chrome.runtime.Port — tests inject a mock,
// production passes the real port. Keeps this module free of chrome types.
export interface PortLike {
  postMessage(msg: unknown): void
  onMessage: { addListener(fn: (msg: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
}

export interface KernelSyncHostOptions {
  // Reason: patch coalescing window; 0 = synchronous (tests). Default 80ms —
  // local IPC, so freshness beats bandwidth, but per-token posts are waste.
  throttleMs?: number
  // Reason: command table injected by the host wiring (send/stop/clearError…)
  // so the sync host stays agnostic of kernel capabilities.
  commands?: Record<string, (args: unknown) => void>
  // Reason: host-defined runtime metadata carried in every frame (small).
  extras?: () => Record<string, unknown>
  // Reason: inspector payloads can be huge (craton contains page content) —
  // keep them request/response instead of adding them to the 80ms patch stream.
  requests?: Record<string, (args: unknown) => unknown | Promise<unknown>>
}

interface PortBase {
  rev: number
  messages: UIMessage[]
}

// Reason: kernel-side sync endpoint — 1:N port fan-out. Each port becomes
// live only after its 'sync' handshake (snapshot), then receives rev-checked
// patches diffed against its own last-acked base. Commands are deduped by
// client id via the kernel, so reconnect retries never double-execute.
export class KernelSyncHost {
  #kernel: SidekickKernel
  #opts: KernelSyncHostOptions
  #bases = new Map<PortLike, PortBase>()
  #lastDispatch = 0
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(kernel: SidekickKernel, opts: KernelSyncHostOptions = {}) {
    this.#kernel = kernel
    this.#opts = opts
    kernel.kstate.subscribe(() => this.#scheduleBroadcast())
  }

  attachPort(port: PortLike): void {
    port.onMessage.addListener((raw) => this.#handleMessage(port, raw))
    port.onDisconnect.addListener(() => { this.#bases.delete(port) })
  }

  // Reason: multiplexed hosting — the router owns port listeners and rebinds
  // ports across hosts; these public entry points replace attachPort there.
  syncPort(port: PortLike): void {
    const snap = snapshotFrom(this.#source())
    this.#bases.set(port, { rev: snap.rev, messages: snap.messages })
    port.postMessage(snap)
  }

  removePort(port: PortLike): void {
    this.#bases.delete(port)
  }

  // Reason: deduped command entry — shared by the port listener path and the
  // multiplexing router.
  command(id: string, name: string, args: unknown): void {
    const fn = this.#opts.commands?.[name]
    if (!fn) return
    this.#kernel.runCommand(id, () => fn(args))
  }

  // Reason: Dev/inspector reads are off the hot command path — they are
  // one-shot request/response pairs and must not participate in send dedup.
  async request(name: string, args: unknown): Promise<unknown> {
    const fn = this.#opts.requests?.[name]
    if (!fn) throw new Error(`unknown request: ${name}`)
    return fn(args)
  }

  #source(): KernelSnapshotSource {
    const k = this.#kernel
    return {
      rev: k.rev,
      sessionId: k.sessionId,
      messages: k.kstate.messages,
      status: k.kstate.status,
      errorMessage: k.kstate.error?.message,
      queue: k.queue,
      compacting: k.compacting,
      preparing: k.preparing,
      dispatching: k.dispatching,
      extras: this.#opts.extras?.(),
    }
  }

  #handleMessage(port: PortLike, raw: unknown): void {
    const m = raw as { type?: string; id?: string; name?: string; args?: unknown }
    if (m?.type === 'sync') {
      this.syncPort(port)
      return
    }
    if (m?.type === 'cmd' && typeof m.id === 'string' && typeof m.name === 'string') {
      this.command(m.id, m.name, m.args)
      return
    }
    if (m?.type === 'request' && typeof m.id === 'string' && typeof m.name === 'string') {
      this.request(m.name, m.args ?? {})
        .then(result => port.postMessage({ type: 'response', id: m.id, result }))
        .catch(e => port.postMessage({ type: 'response', id: m.id, error: e instanceof Error ? e.message : String(e) }))
    }
  }

  // Reason: leading + trailing throttle — the first mutation of a burst lands
  // immediately (perceived latency), the rest coalesce into one trailing patch.
  // "Immediately" means the next macrotask, never the current synchronous
  // block: a transition written as several mutations in one tick (a send
  // pushes the bubble, raises the busy flag, then the SDK flips status) must
  // publish its settled state — the intermediate ones it passes through are
  // not real states and would flash in the panel.
  #scheduleBroadcast(): void {
    const ms = this.#opts.throttleMs ?? 80
    if (ms <= 0) {
      this.#broadcast()
      return
    }
    if (this.#timer) return
    const elapsed = Date.now() - this.#lastDispatch
    // Reason: a timer rather than a microtask — the tick's own await
    // continuations finish the mutation sequence and run before any timer.
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#lastDispatch = Date.now()
      this.#broadcast()
    }, elapsed >= ms ? 0 : ms - elapsed)
  }

  #broadcast(): void {
    if (this.#bases.size === 0) return
    const src = this.#source()
    for (const [port, base] of this.#bases) {
      if (base.rev === src.rev) continue
      const patch = diffPatch(base, src)
      try {
        port.postMessage(patch)
      } catch {
        // Reason: posting to a dead chrome port throws — drop it silently,
        // onDisconnect cleanup may race behind the actual disconnect.
        this.#bases.delete(port)
        continue
      }
      this.#bases.set(port, { rev: src.rev, messages: snapshotMessages(src) })
    }
  }
}

// Reason: base keeps element references (not clones) — KernelChatState is
// copy-on-write, so reference diffing against these stays correct and cheap.
function snapshotMessages(src: KernelSnapshotSource): UIMessage[] {
  return [...src.messages]
}
