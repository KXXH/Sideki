import { useState, useEffect, useRef, useCallback } from 'react'
import { applySnapshot, applyPatch } from '../../shared/kernel/sync-protocol'
import type { PanelMirror, SyncSnapshot, SyncPatch } from '../../shared/kernel/sync-protocol'
import type { ApiConfig, PermissionMode } from '../../shared/types'

// Reason: session metadata mirrored from the kernel — message bodies travel
// through the patch stream, the session bar only needs these fields.
export interface MirrorSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pageUrl?: string
  mode: 'chat' | 'pro'
  permissionMode?: PermissionMode
  messageCount: number
}

export interface MirrorExtras {
  sessions: MirrorSessionMeta[]
  activeId: string
  lastTurnTokens: { input: number; output: number; reasoning: number }
  contextLoaded: boolean
  contextWindow: number
  modelName: string
  config: ApiConfig | null
}

const EMPTY_EXTRAS: MirrorExtras = {
  sessions: [], activeId: '', lastTurnTokens: { input: 0, output: 0, reasoning: 0 },
  contextLoaded: false,
  contextWindow: 0, modelName: '', config: null,
}

// Reason: offscreen documents may not exist yet when the panel opens —
// retry pattern for async extension contexts (300ms × 5 covers cold starts).
async function ensureOffscreenWithRetry(): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'kernel:ensure-offscreen' })
      if (resp?.success) return true
    } catch { /* SW may still be starting */ }
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

function sendPresence(port: chrome.runtime.Port): void {
  try {
    port.postMessage({ type: 'presence', visible: document.visibilityState === 'visible' })
  } catch { /* dead port — reconnect will resend */ }
}

// Reason: panel-side mirror of the offscreen kernel — snapshot handshake on
// connect, rev-checked patches while online, automatic resync on gaps and
// automatic reconnect (with a fresh handshake) when the port drops. All
// mutations go out as idempotent commands; the mirror itself is read-only.
export function useKernelMirror(active: boolean) {
  const [mirror, setMirror] = useState<PanelMirror | null>(null)
  const [connected, setConnected] = useState(false)
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const mirrorRef = useRef<PanelMirror | null>(null)
  const bindingEpochRef = useRef(0)
  const bindingPendingRef = useRef(false)
  // Reason: sends issued during the handshake wait for it instead of failing —
  // the panel opening (or a session switch) is our plumbing, not the user's
  // problem.
  const readyWaitersRef = useRef<Array<() => void>>([])
  const flushReady = useCallback(() => {
    const waiters = readyWaitersRef.current
    readyWaitersRef.current = []
    for (const resolve of waiters) resolve()
  }, [])
  mirrorRef.current = mirror

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null

    const connect = async () => {
      if (cancelled) return
      const ok = await ensureOffscreenWithRetry()
      if (cancelled) return
      if (!ok) {
        console.error('[kernel-mirror] offscreen document unavailable')
        reconnectTimer = setTimeout(connect, 2000)
        return
      }
      // Reason: chrome-types resolves the single-arg overload to extensionId —
      // pass our own id explicitly to hit the (id, connectInfo) overload.
      const port = chrome.runtime.connect(chrome.runtime.id, { name: 'kernel-sync' })
      portRef.current = port
      bindingPendingRef.current = true
      let gotFirstMessage = false
      port.onMessage.addListener((raw: SyncSnapshot | SyncPatch) => {
        gotFirstMessage = true
        if (raw.type === 'snapshot') {
          bindingPendingRef.current = false
          const next = applySnapshot(raw)
          mirrorRef.current = next
          setMirror(next)
          setConnected(true)
          flushReady()
          // Reason: presence is panel-owned — the kernel cannot see a
          // minimized window or a panel showing someone else's session, and
          // the completion notice depends on knowing which one this is.
          sendPresence(port)
          return
        }
        if (raw.type === 'patch') {
          const cur = mirrorRef.current
          const next = cur ? applyPatch(cur, raw) : null
          if (!next) {
            // Reason: rev gap or missing base — request a fresh snapshot
            try { port.postMessage({ type: 'sync' }) } catch { /* dead port */ }
            return
          }
          mirrorRef.current = next
          setMirror(next)
        }
      })
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null
        setConnected(false)
        if (!cancelled) reconnectTimer = setTimeout(connect, 500)
      })
      try { port.postMessage({ type: 'sync' }) } catch { /* triggers onDisconnect */ }
      // Reason: a wedged offscreen document keeps the port open but never
      // answers — onDisconnect never fires, so the handshake needs its own
      // deadline. Reconnecting re-runs ensureOffscreen, whose liveness ping
      // tears down and rebuilds zombie documents.
      handshakeTimer = setTimeout(() => {
        if (gotFirstMessage || cancelled) return
        console.warn('[kernel-mirror] handshake timeout — rebuilding connection')
        try { port.disconnect() } catch { /* already gone */ }
        if (portRef.current === port) portRef.current = null
        reconnectTimer = setTimeout(connect, 300)
      }, 4000)
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (handshakeTimer) clearTimeout(handshakeTimer)
      try { portRef.current?.disconnect() } catch { /* already gone */ }
      portRef.current = null
    }
  }, [active, flushReady])

  // Reason: the panel knows when its own window is minimized or hidden; the
  // kernel only learns it if we say so. Re-sent on every transition so the
  // far side never has to guess from a stale value.
  useEffect(() => {
    if (!active) return
    const onVisibility = () => { if (portRef.current) sendPresence(portRef.current) }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [active])

  // Reason: readiness = the port answered a handshake for the session it is
  // showing. Everything a send needs is exactly that, so one probe serves both
  // the wait and the assertion below.
  const sendReady = useCallback((): boolean => Boolean(
    portRef.current && mirrorRef.current?.sessionId && !bindingPendingRef.current,
  ), [])

  // Reason: a send that arrives before the handshake (panel just opened, or a
  // rebind is in flight) waits for it rather than failing — the user asked for
  // the message to go out, not for a report on our plumbing. The deadline keeps
  // a dead backend from holding the composer forever.
  const whenReady = useCallback((timeoutMs = 5000): Promise<void> => {
    if (sendReady()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter = () => { clearTimeout(timer); resolve() }
      readyWaitersRef.current.push(waiter)
      const timer = setTimeout(() => {
        readyWaitersRef.current = readyWaitersRef.current.filter(w => w !== waiter)
        reject(new Error('发送失败：后台未连接，请重试'))
      }, timeoutMs)
    })
  }, [sendReady])

  const captureSendTarget = useCallback(() => {
    const port = portRef.current
    const sessionId = mirrorRef.current?.sessionId
    const epoch = bindingEpochRef.current
    const assertCurrent = () => {
      if (!port || portRef.current !== port) throw new Error('发送失败：后台连接已断开，请重试')
      if (bindingEpochRef.current !== epoch || mirrorRef.current?.sessionId !== sessionId) {
        throw new Error('上传期间会话已切换，发送已取消；输入和附件已保留')
      }
      if (!sessionId || bindingPendingRef.current) throw new Error('会话正在切换或初始化，请稍后重试')
    }
    assertCurrent()
    return { sessionId: sessionId!, assertCurrent }
  }, [])
  // Reason: a failed send must retain the draft instead of pretending the command was accepted.
  const cmd = useCallback((name: string, args?: Record<string, unknown>) => {
    const post = (): boolean => {
      const port = portRef.current
      if (!port) return false
      try {
        if (name === 'send') captureSendTarget()
        const rebind = name === 'select-session' || name === 'new-session'
          || (name === 'delete-session' && args?.id === mirrorRef.current?.sessionId)
        if (rebind || name === 'init') bindingEpochRef.current++
        port.postMessage({ type: 'cmd', id: crypto.randomUUID(), name, args })
        if (rebind) bindingPendingRef.current = true
      } catch (e) {
        if (name === 'send') throw e
        console.warn(`[kernel-mirror] cmd "${name}" failed:`, e)
      }
      return true
    }
    if (post()) return
    if (name === 'send') throw new Error('发送失败：后台未连接，请重试')
    // Reason: the port can still be coming up (panel just opened, or a
    // reconnect backoff) — a click stands and lands with the handshake instead
    // of vanishing with only a console warning. Rebind bookkeeping happens at
    // post time, so a late command is judged against the state it lands on.
    whenReady().then(() => { post() }).catch(() => {
      console.warn(`[kernel-mirror] cmd "${name}" dropped — backend never came back`)
    })
  }, [captureSendTarget, whenReady])

  const extras = (mirror?.extras as unknown as MirrorExtras | undefined) ?? EMPTY_EXTRAS

  // Reason: Dev inspector payloads can be huge (page prompt/craton) — request
  // them on demand instead of adding them to the 80ms mirror patch stream.
  const request = useCallback(async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    const port = portRef.current
    if (!port) throw new Error('kernel mirror not connected')
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`request "${name}" timed out`))
      }, 3000)
      const listener = (raw: unknown) => {
        const m = raw as { type?: string; id?: string; result?: unknown; error?: string }
        if (m?.type !== 'response' || m.id !== id) return
        cleanup()
        if (m.error) reject(new Error(m.error))
        else resolve(m.result as T)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        port.onMessage.removeListener(listener)
      }
      port.onMessage.addListener(listener)
      port.postMessage({ type: 'request', id, name, args: args ?? {} })
    })
  }, [])

  return { mirror, extras, connected, cmd, request, captureSendTarget, whenReady }
}
