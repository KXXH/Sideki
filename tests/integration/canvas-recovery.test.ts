import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCanvasRequests } from '../../src/background/canvas-requests'
import { canvasStore } from '../../src/shared/canvas-storage'
import { canvasStorageKey } from '../../src/shared/canvas-state'
import { deleteSession, saveSession } from '../../src/shared/storage'

let data: Record<string, unknown>
beforeEach(() => {
  data = {}
  vi.mocked(chrome.runtime.onMessage.addListener).mockClear()
  vi.mocked(chrome.storage.local.get).mockImplementation(async keys => {
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data)
    return Object.fromEntries(list.map(key => [key, structuredClone(data[key])]))
  })
  vi.mocked(chrome.storage.local.set).mockImplementation(async values => { Object.assign(data, structuredClone(values)) })
  vi.mocked(chrome.storage.local.remove).mockImplementation(async keys => {
    for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]
  })
})
afterEach(() => vi.restoreAllMocks())

describe('canvas persistence recovery', () => {
  it('reconciles a durable message after a crash before the dirty acknowledgement', async () => {
    const session = { id: 's', title: 'Source', createdAt: 1, updatedAt: 1, messages: [] as unknown[] }
    await saveSession(session)
    const binding = { sessionId: 's', canvasId: 'a', title: 'A', path: '/viz/a.html' }
    await canvasStore.open(binding)
    await canvasStore.set(binding, { modelContent: { city: '杭州' } })
    const snapshots = await canvasStore.capture('s', 'old-runtime', 'old-message')
    vi.mocked(chrome.storage.local.set).mockImplementation(async values => {
      if (canvasStorageKey('s') in values) throw new Error('crash before canvas ack')
      Object.assign(data, structuredClone(values))
    })
    await expect(saveSession({ ...session, messages: [{ id: 'u', role: 'user', metadata: { v: 2 }, parts: [{ type: 'text', text: '分析' }, { type: 'data-canvas-context', data: snapshots }] }] })).rejects.toThrow('crash')
    vi.mocked(chrome.storage.local.set).mockImplementation(async values => { Object.assign(data, structuredClone(values)) })
    registerCanvasRequests(async () => {})
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0]
    const result = await new Promise(resolve => listener({ type: 'canvas:request', op: 'capture', sessionId: 's', owner: 'new-runtime', claimId: 'new-message' }, { id: chrome.runtime.id }, resolve))
    expect(result).toEqual({ success: true, result: [] })
    expect((await canvasStore.open(binding)).committedModelRevision).toBe(1)
    await deleteSession('s')
    expect(data[canvasStorageKey('s')]).toBeUndefined()
  })

  it('rejects requests from outside the extension before accessing state', async () => {
    registerCanvasRequests(async () => {})
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0]
    const reply = vi.fn()
    listener({ type: 'canvas:request', op: 'capture', sessionId: 's' }, { id: 'other-extension' }, reply)
    expect(reply).toHaveBeenCalledWith({ success: false, error: '画布来源无效' })
    expect(data).toEqual({})
  })
})
