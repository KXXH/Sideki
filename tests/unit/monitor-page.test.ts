// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMonitorRelay, installMonitorRuntime, installPageMonitor, stopPageMonitor } from '../../src/background/monitor-page'
import { serializeMonitorValue } from '../../src/shared/monitor'
import { execScript, handleExecuteJS, requireConsent, resolveFrameId } from '../../src/background/tool-handlers'
import type { ScheduledTask } from '../../src/shared/scheduled-task'

vi.mock('../../src/background/tool-handlers', () => ({ execScript: vi.fn(), handleExecuteJS: vi.fn(), requireConsent: vi.fn(), resolveFrameId: vi.fn() }))
const registry = () => (window as any).__sidekickMonitors as Record<string, () => void>
const relays = () => (window as any).__sidekickMonitorRelays as Record<string, () => void>
let post: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
  post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
})
afterEach(() => {
  for (const stop of Object.values(registry() ?? {})) {
    try { stop() } catch {
      // Reason: throwing cleanup is an intentional test case.
    }
  }
  for (const stop of Object.values(relays() ?? {})) stop()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const install = (fn: (emit: (value: unknown) => void) => unknown, ttl = 60_000) => installMonitorRuntime('token', Date.now() + ttl, fn, serializeMonitorValue)

describe('MAIN-world monitor runtime', () => {
  it('installs synchronously, delivers an immediate emit after installation and cleans up once', () => {
    const cleanup = vi.fn()
    expect(install(emit => { emit({ ready: true }); return cleanup })).toEqual({ installed: true })
    expect(post).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ json: '{"ready":true}', token: 'token' }), '*')
    registry().token()
    expect(cleanup).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(100_000)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(post).toHaveBeenCalledOnce()
  })
  it('does not deliver emissions from failed installations or execute async/generator installers', () => {
    expect(() => install(emit => { emit('early'); throw new Error('failed') })).toThrow('failed')
    const body = vi.fn()
    expect(() => install(async () => { body() })).toThrow('同步')
    expect(() => install(function* () { yield body() })).toThrow('同步')
    expect(body).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
    expect(post).not.toHaveBeenCalled()
    expect(registry().token).toBeUndefined()
  })
  it('coalesces a burst to the newest trailing event and disables saved emit functions on deletion', () => {
    let emit!: (v: unknown) => void
    install(fn => { emit = fn })
    emit(1)
    for (let i = 2; i <= 100; i++) emit(i)
    expect(post).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ json: '100' }), '*')
    registry().token()
    emit('after deletion')
    vi.advanceTimersByTime(1000)
    expect(post).toHaveBeenCalledTimes(2)
  })
  it('reports invalid data once, without silently dropping functions or flooding error events', () => {
    let emit!: (v: unknown) => void
    install(fn => { emit = fn })
    emit({ callback: () => {} })
    emit(document.body)
    emit({ circular: window })
    vi.advanceTimersByTime(5000)
    expect(post).toHaveBeenCalledOnce()
    expect(post.mock.calls[0][0].error).toContain('JSON')
  })
  it('observes DOM changes and expires independently of extension worker lifetime', async () => {
    const cleanup = vi.fn()
    install(emit => {
      const observer = new MutationObserver(() => { if (document.querySelector('#done')) emit('ready') })
      observer.observe(document.body, { childList: true })
      return () => { observer.disconnect(); cleanup() }
    }, 3000)
    document.body.innerHTML = '<button id="done">完成</button>'
    await Promise.resolve()
    expect(post).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(3000)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(registry().token).toBeUndefined()
    document.body.innerHTML = '<span>later</span>'
    await Promise.resolve()
    expect(post).toHaveBeenCalledOnce()
  })
  it('invalidates emit even if user cleanup throws', () => {
    let emit!: (v: unknown) => void
    install(fn => { emit = fn; return () => { throw new Error('cleanup') } })
    expect(() => registry().token()).toThrow('cleanup')
    emit('late')
    vi.runOnlyPendingTimers()
    expect(post).not.toHaveBeenCalled()
    expect(registry().token).toBeUndefined()
  })
})

describe('isolated event relay', () => {
  it('only forwards bounded events from its own window and token, throttles them and stops on deletion', () => {
    installMonitorRelay('token', Date.now() + 60_000)
    const send = (data: any, source: Window | null = window) => window.dispatchEvent(new MessageEvent('message', { source, data }))
    send({ channel: 'sidekick-monitor-v1', token: 'wrong', json: '1' })
    send({ channel: 'sidekick-monitor-v1', token: 'token', json: '1' }, null)
    send({ channel: 'sidekick-monitor-v1', token: 'token', json: 'x'.repeat(9000) })
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    send({ channel: 'sidekick-monitor-v1', token: 'token', json: '1' })
    send({ channel: 'sidekick-monitor-v1', token: 'token', json: '2' })
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce()
    relays().token()
    vi.advanceTimersByTime(1000)
    send({ channel: 'sidekick-monitor-v1', token: 'token', json: '3' })
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce()
  })
})

const task = (): ScheduledTask => ({ id: 't', sessionId: 's', title: 'listen', instruction: 'check', tabId: 42, pageTitle: '', pageUrl: '', nextRunAt: 0, maxRuns: 1, runs: 0, status: 'scheduled', createdAt: Date.now(), kind: 'monitor', monitor: { token: 'token', code: '(emit) => { emit(1) }', documentId: '', expiresAt: Date.now() + 60_000, listening: true, received: 0, coalesced: 0 } })
describe('extension injection lifecycle', () => {
  it('establishes the relay before evaluating MAIN code, retains document identity and preserves Chat consent', async () => {
    vi.mocked(requireConsent).mockResolvedValue(true)
    vi.mocked(execScript).mockResolvedValue([{ result: true, documentId: 'doc' }] as any)
    vi.mocked(handleExecuteJS).mockResolvedValue({ success: true, result: '{"installed":true}' })
    const t = task()
    await installPageMonitor(t, false)
    expect(requireConsent).toHaveBeenCalledWith('executeJS', t.monitor!.code, 42)
    expect(execScript).toHaveBeenNthCalledWith(1, expect.objectContaining({ world: 'ISOLATED', func: installMonitorRelay }))
    expect(vi.mocked(execScript).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(handleExecuteJS).mock.invocationCallOrder[0])
    expect(t.monitor!.documentId).toBe('doc')
    expect(handleExecuteJS).toHaveBeenCalledWith(42, expect.objectContaining({ code: expect.stringContaining('installMonitorRuntime') }))
    await stopPageMonitor(t)
    expect(execScript).toHaveBeenLastCalledWith(expect.objectContaining({ target: { tabId: 42, documentIds: ['doc'] }, world: 'ISOLATED' }))
  })
  it('pins an iframe relay, runtime and cleanup to the resolved document', async () => {
    vi.mocked(resolveFrameId).mockResolvedValue(7)
    vi.mocked(execScript).mockResolvedValue([{ result: true, documentId: 'frame-doc' }] as any)
    vi.mocked(handleExecuteJS).mockResolvedValue({ success: true })
    const t = task()
    t.monitor!.frame = '#agent-frame'
    await installPageMonitor(t, true)
    expect(resolveFrameId).toHaveBeenCalledWith(42, '#agent-frame')
    expect(execScript).toHaveBeenNthCalledWith(1, expect.objectContaining({ target: { tabId: 42, frameIds: [7] } }))
    expect(handleExecuteJS).toHaveBeenCalledWith(42, expect.objectContaining({ frameSelector: '7' }))
    expect(t.monitor!.frameId).toBe(7)
    expect(t.monitor!.documentId).toBe('frame-doc')
    await stopPageMonitor(t)
    expect(execScript).toHaveBeenLastCalledWith(expect.objectContaining({ target: { tabId: 42, documentIds: ['frame-doc'] } }))
  })
  it('fails without installing when the requested iframe cannot be resolved', async () => {
    vi.mocked(resolveFrameId).mockResolvedValue({ success: false, error: 'No frame' })
    const t = task()
    t.monitor!.frame = '7'
    await expect(installPageMonitor(t, true)).rejects.toThrow('No frame')
    expect(execScript).not.toHaveBeenCalled()
    expect(handleExecuteJS).not.toHaveBeenCalled()
  })
  it('does not inject when Chat denies permission, and removes the relay on CSP failure', async () => {
    vi.mocked(requireConsent).mockResolvedValue(false)
    await expect(installPageMonitor(task(), false)).rejects.toThrow('未允许')
    expect(execScript).not.toHaveBeenCalled()
    vi.mocked(execScript).mockResolvedValue([{ result: true, documentId: 'doc' }] as any)
    vi.mocked(handleExecuteJS).mockResolvedValue({ success: false, error: 'CSP' })
    await expect(installPageMonitor(task(), true)).rejects.toThrow('CSP')
    expect(execScript).toHaveBeenCalledTimes(4)
  })
})

describe('emit serialization contract', () => {
  it('accepts JSON values and shared subobjects, rejects unsupported data and excessive size/depth', () => {
    const shared = { a: 1 }
    expect(serializeMonitorValue({ a: shared, b: shared, c: [null, true, '中文'] })).toBe('{"a":{"a":1},"b":{"a":1},"c":[null,true,"中文"]}')
    const cyclic: any = {}; cyclic.self = cyclic
    for (const value of [undefined, () => {}, 1n, Infinity, NaN, new Date(), document.body, cyclic, { a: undefined }, Array(1)]) expect(() => serializeMonitorValue(value)).toThrow()
    expect(() => serializeMonitorValue('中'.repeat(3000))).toThrow('字节')
    let nested: any = {}; for (let i = 0; i < 34; i++) nested = { nested }
    expect(() => serializeMonitorValue(nested)).toThrow('复杂')
  })
})
