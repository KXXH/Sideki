import { execScript, handleExecuteJS, requireConsent, resolveFrameId } from './tool-handlers'
import { serializeMonitorValue } from '../shared/monitor'
import type { ScheduledTask } from '../shared/scheduled-task'
import type { ExecutionApproval } from '../shared/approval-types'

// Reason: executeScript serializes these functions; every dependency must live inside the function or travel as an argument.
export function installMonitorRelay(token: string, expiresAt: number) {
  const registry = window as unknown as { __sidekickMonitorRelays?: Record<string, () => void> }
  const relays = registry.__sidekickMonitorRelays ??= Object.create(null)
  relays[token]?.()
  let lastSent = 0
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (event.source !== window || !data || data.channel !== 'sidekick-monitor-v1' || data.token !== token) return
    if (Date.now() >= expiresAt || Date.now() - lastSent < 900) return
    if (typeof data.json !== 'string' && typeof data.error !== 'string') return
    if ((data.json?.length ?? 0) > 8192 || (data.error?.length ?? 0) > 500) return
    lastSent = Date.now()
    void chrome.runtime.sendMessage({ type: 'monitor:event', token, json: data.json, error: data.error }).catch(() => {})
  }
  const stop = () => {
    window.removeEventListener('message', receive)
    clearTimeout(timer)
    delete relays[token]
  }
  const timer = setTimeout(stop, Math.max(0, expiresAt - Date.now()))
  relays[token] = stop
  window.addEventListener('message', receive)
  return true
}

export function installMonitorRuntime(
  token: string,
  expiresAt: number,
  installer: (emit: (value: unknown) => void) => unknown,
  serialize: (value: unknown) => string,
) {
  if (typeof installer !== 'function' || installer.constructor.name !== 'Function') throw new Error('monitor 必须是同步普通函数，不能是 async 或 generator')
  const registry = window as unknown as { __sidekickMonitors?: Record<string, () => void> }
  const monitors = registry.__sidekickMonitors ??= Object.create(null)
  monitors[token]?.()
  let active = true
  let installing = true
  let cleanup: (() => void) | undefined
  let pending: { json?: string; error?: string } | undefined
  let delivery: ReturnType<typeof setTimeout> | undefined
  let lastSent = 0
  let errorReported = false
  const postMessage = window.postMessage.bind(window)
  const stop = () => {
    if (!active) return
    active = false
    pending = undefined
    clearTimeout(expiry)
    clearTimeout(delivery)
    delete monitors[token]
    cleanup?.()
  }
  const expiry = setTimeout(() => {
    try { stop() } catch {
      // Reason: cleanup errors must not reactivate an expired monitor.
    }
  }, Math.max(0, expiresAt - Date.now()))
  const flush = () => {
    delivery = undefined
    if (!active || installing || !pending) return
    if (Date.now() >= expiresAt) {
      try { stop() } catch {
        // Reason: emit stays disabled even if page cleanup fails.
      }
      return
    }
    const delay = 1000 - (Date.now() - lastSent)
    if (delay > 0) { delivery = setTimeout(flush, delay); return }
    const event = pending
    pending = undefined
    lastSent = Date.now()
    postMessage({ channel: 'sidekick-monitor-v1', token, ...event }, '*')
  }
  const emit = (value: unknown) => {
    if (!active || Date.now() >= expiresAt) return
    try {
      const json = serialize(value)
      if (!pending?.error) pending = { json }
    } catch (error) {
      if (errorReported) return
      errorReported = true
      pending = { error: String(error instanceof Error ? error.message : error).slice(0, 500) }
    }
    if (!installing && !delivery) flush()
  }
  monitors[token] = stop
  try {
    const result = installer(emit)
    if (result !== undefined && typeof result !== 'function') {
      if (result && typeof (result as Promise<unknown>).then === 'function') void Promise.resolve(result).catch(() => {})
      throw new Error('monitor 只能返回清理函数或 undefined，不能返回 Promise')
    }
    if (typeof result === 'function') {
      if (result.constructor.name !== 'Function') throw new Error('monitor 清理函数必须是同步普通函数')
      cleanup = result as () => void
    }
    installing = false
    if (pending) delivery = setTimeout(flush, 0)
    return { installed: true }
  } catch (error) {
    try { stop() } catch {
      // Reason: preserve the original installation error.
    }
    throw error
  }
}

export async function installPageMonitor(task: ScheduledTask, proMode: boolean, authorization?: ExecutionApproval): Promise<void> {
  const monitor = task.monitor!
  if (authorization && !authorization.isActive()) throw new Error('调用授权已失效')
  if (!proMode && !await (authorization
    ? requireConsent('executeJS', monitor.code, task.tabId, undefined, authorization)
    : requireConsent('executeJS', monitor.code, task.tabId))) throw new Error('用户未允许安装页面监听')
  if (monitor.expiresAt <= Date.now()) throw new Error('监听已到期，请重新创建')
  const frameId = monitor.frame ? await resolveFrameId(task.tabId, monitor.frame) : 0
  if (typeof frameId !== 'number') throw new Error(frameId.error)
  monitor.frameId = frameId
  const relay = await execScript<boolean>({
    target: { tabId: task.tabId, frameIds: [frameId] }, world: 'ISOLATED', injectImmediately: true,
    func: installMonitorRelay, args: [monitor.token, monitor.expiresAt],
  }) as Array<{ result: boolean; documentId?: string }>
  if (!relay[0]?.result || !relay[0].documentId) throw new Error('无法建立页面监听回传通道')
  monitor.documentId = relay[0].documentId
  try {
    // Reason: a CSP fallback may race navigation; mark the exact document before evaluating any generated code.
    await execScript({
      target: { tabId: task.tabId, documentIds: [monitor.documentId] }, world: 'MAIN', injectImmediately: true,
      func: (token: string) => {
        const registry = window as unknown as { __sidekickMonitorTargets?: Record<string, boolean> }
        const targets = registry.__sidekickMonitorTargets ??= Object.create(null)
        targets[token] = true
      }, args: [monitor.token],
    })
    const token = JSON.stringify(monitor.token)
    const code = `(() => { if (!window.__sidekickMonitorTargets?.[${token}]) throw new Error('监听目标页面已刷新'); delete window.__sidekickMonitorTargets[${token}]; return (${installMonitorRuntime.toString()})(${token},${monitor.expiresAt},(${monitor.code}),(${serializeMonitorValue.toString()})); })()`
    const result = await handleExecuteJS(task.tabId, { code, ...(frameId !== 0 ? { frameSelector: String(frameId) } : {}) })
    if (!result?.success) throw new Error(result?.error ?? '页面监听安装失败')
    const current = await execScript<boolean>({
      target: { tabId: task.tabId, documentIds: [monitor.documentId] }, world: 'ISOLATED', injectImmediately: true,
      func: () => true,
    })
    if (!current[0]?.result) throw new Error('安装过程中页面已刷新')
  } catch (error) {
    await stopPageMonitor(task)
    throw error
  }
}

export async function stopPageMonitor(task: ScheduledTask): Promise<void> {
  const monitor = task.monitor
  if (!monitor?.documentId) return
  const target = { tabId: task.tabId, documentIds: [monitor.documentId] }
  await Promise.allSettled([
    execScript({ target, world: 'MAIN', injectImmediately: true, func: (token: string) => {
      const registry = window as unknown as { __sidekickMonitors?: Record<string, () => void>; __sidekickMonitorTargets?: Record<string, boolean> }
      if (registry.__sidekickMonitorTargets) delete registry.__sidekickMonitorTargets[token]
      registry.__sidekickMonitors?.[token]?.()
    }, args: [monitor.token] }),
    execScript({ target, world: 'ISOLATED', injectImmediately: true, func: (token: string) => {
      const registry = window as unknown as { __sidekickMonitorRelays?: Record<string, () => void> }
      registry.__sidekickMonitorRelays?.[token]?.()
    }, args: [monitor.token] }),
  ])
}

export async function isMonitorDocumentCurrent(task: ScheduledTask): Promise<boolean> {
  if (!task.monitor?.documentId) return false
  try {
    const result = await execScript<boolean>({
      target: { tabId: task.tabId, documentIds: [task.monitor.documentId] }, world: 'ISOLATED', injectImmediately: true,
      func: () => true,
    })
    return result[0]?.result === true
  } catch { return false }
}
