// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvasHost, type CanvasHost } from '../../src/shared/canvas-host'
import { CanvasStateStore } from '../../src/shared/canvas-state'
import { mountHtmlPreview } from '../../src/preview/preview-host'

const binding = { sessionId: 'source-session', canvasId: 'source-canvas', path: '/viz/chart.html', title: '预算规划' }
const hosts: CanvasHost[] = []
beforeEach(() => {
  vi.mocked(chrome.runtime.sendMessage).mockReset()
  document.body.replaceChildren()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false } })
  let doc: unknown
  const store = new CanvasStateStore({ read: async () => structuredClone(doc) as never, write: async (_id, value) => { doc = structuredClone(value) }, lock: async (_id, work) => work() })
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
    if (message.op === 'open') return { success: true, result: await store.open(binding) }
    if (message.op === 'set') return { success: true, result: await store.set(binding, message.state) }
    if (message.op === 'follow-up') return { success: true, result: { status: 'queued', messageId: 'queued-1' } }
    return { success: false }
  })
})
afterEach(() => { hosts.splice(0).forEach(h => h.dispose()); vi.restoreAllMocks() })

async function open() {
  const post = vi.fn()
  const host = await createCanvasHost(binding, post)
  hosts.push(host)
  return { host, post }
}

describe('trusted canvas host', () => {
  it('uses the same SDK in a new-tab frame and rejects messages from the wrong source or render nonce', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const preview = mountHtmlPreview({ container, html: '<p>Chart</p>', network: false, title: 'Chart', canvas: binding, getTheme: () => ({ mode: 'light', tokens: {} }), onRendered: vi.fn(), onError: vi.fn() })
    try {
      const frame = container.querySelector('iframe')!
      const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
      const dispatch = (data: unknown, source = frame.contentWindow) => window.dispatchEvent(new MessageEvent('message', { source, data }))
      dispatch({ type: 'viz:ready' })
      await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'viz:render', sideki: expect.objectContaining({ enabled: true }) }), '*'))
      const render = post.mock.calls.find(([data]) => data.type === 'viz:render')![0]
      const request = { type: 'viz:request', id: render.id, requestId: 'new-tab-request', method: 'setWidgetState', args: { modelContent: { city: '杭州' } } }
      dispatch(request, window)
      dispatch({ ...request, id: 'old-render' })
      expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([msg]) => msg.op === 'set')).toBe(false)
      dispatch(request)
      await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ op: 'set', ...binding })))
    } finally { preview.dispose() }
  })
  it('writes against the host binding, deduplicates requests and returns the persisted revision', async () => {
    const { host, post } = await open()
    const request = { type: 'viz:request', requestId: 'r1', method: 'setWidgetState', args: { modelContent: { budget: 5000 } } }
    host.handle(request)
    host.handle(request)
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ result: { revision: 1, widgetState: { modelContent: { budget: 5000 }, privateContent: null } } })))
    const writes = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([msg]) => msg.op === 'set')
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toMatchObject(binding)
  })

  it('requires trusted confirmation and sends only to the source session', async () => {
    const { host, post } = await open()
    host.handle({ type: 'viz:request', requestId: 'r1', method: 'sendFollowUpMessage', args: { prompt: '按当前条件分析', title: '继续分析' } })
    await vi.waitFor(() => expect(document.querySelector('dialog')?.open).toBe(true))
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([msg]) => msg.op === 'follow-up')).toBe(false)
    const buttons = [...document.querySelectorAll('dialog button')]
    ;(buttons.find(button => button.textContent === '发送') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ result: { status: 'queued', messageId: 'queued-1' } })))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ ...binding, op: 'follow-up' }))
  })

  it('cancels without enqueueing and disposes an outstanding confirmation', async () => {
    const { host } = await open()
    host.handle({ type: 'viz:request', requestId: 'r1', method: 'sendFollowUpMessage', args: { prompt: '分析' } })
    await vi.waitFor(() => expect(document.querySelector('dialog')?.open).toBe(true))
    host.dispose()
    await Promise.resolve()
    expect(document.querySelector('dialog')).toBeNull()
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([msg]) => msg.op === 'follow-up')).toBe(false)
  })
})
