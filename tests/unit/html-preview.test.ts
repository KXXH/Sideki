// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodePreviewBytes, mountHtmlPreview, previewFileBlob, readHtmlPreview, readPreviewFile, validatePreviewPath,
} from '../../src/preview/preview-host'

const emptyTheme = () => ({ mode: 'light' as const, tokens: { '--seed-primary': '#d0261a' } })
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('HTML preview files', () => {
  it('keeps the read bound to the requested session and does not read old policy sidecars', async () => {
    const html = '<!doctype html><html><body><p>Report</p></body></html>'
    const send = vi.fn(async (message: Record<string, unknown>) => message.path === '/viz/report.html'
      ? { success: true, content: html }
      : { success: true, content: '{"version":1,"network":true}' })
    expect(await readHtmlPreview(send, 'session-b', '/viz/report.html')).toEqual({ html, network: false })
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'dev:cat', sessionId: 'session-b', path: '/viz/report.html' },
    ])
  })

  it('uses the requested online mode and validates the same HTTPS content as the canvas', async () => {
    const html = '<script src="https://cdn.example.com/chart.js"></script>'
    const send = vi.fn(async () => ({ success: true, content: html }))
    await expect(readHtmlPreview(send, 'session', '/viz/live.html')).rejects.toThrow(/offline/)
    expect(await readHtmlPreview(send, 'session', '/viz/live.html', true)).toEqual({ html, network: true })
  })

  it('does not consult a conflicting stored offline mode for an explicitly online URL', async () => {
    const send = vi.fn(async (message: Record<string, unknown>) => message.path === '/viz/report.html'
      ? { success: true, content: '<p>Report</p>' }
      : { success: true, content: '{"version":1,"network":false}' })
    expect((await readHtmlPreview(send, 's', '/viz/report.html', true)).network).toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })

  it('rejects relative VFS resources rather than pretending the tab is a file server', async () => {
    const send = vi.fn(async (message: Record<string, unknown>) => message.path === '/viz/report.html'
      ? { success: true, content: '<img src="/tmp/photo.png">' }
      : { success: false })
    await expect(readHtmlPreview(send, 's', '/viz/report.html')).rejects.toThrow()
    expect(() => validatePreviewPath('/notes/private.html')).toThrow()
    expect(() => validatePreviewPath('/viz/../notes/private.html')).toThrow()
  })

  it('times out an unresponsive file read before mounting a frame', async () => {
    vi.useFakeTimers()
    const pending = new Promise<never>(() => {})
    const fileRead = readPreviewFile(() => pending, 's', '/viz/report.html')
    const fileResult = expect(fileRead).rejects.toThrow('读取文件超时')
    await vi.advanceTimersByTimeAsync(10_000)
    await fileResult
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the read deadline once a response arrives', async () => {
    vi.useFakeTimers()
    await expect(readPreviewFile(async () => ({ success: true, content: 'done' }), 's', '/tmp/a.txt')).resolves.toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves high image bytes while keeping text downloads as Unicode', async () => {
    const latin1 = String.fromCharCode(0x89, 0x50, 0x4e, 0xff)
    expect([...decodePreviewBytes(latin1)]).toEqual([0x89, 0x50, 0x4e, 0xff])
    const readBlob = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
    expect([...await readBlob(previewFileBlob('/tmp/x.png', latin1))]).toEqual([0x89, 0x50, 0x4e, 0xff])
    expect([...await readBlob(previewFileBlob('/viz/a.html', '中文'))]).toEqual([...new TextEncoder().encode('中文')])
  })
})

describe('HTML preview sandbox handshake', () => {
  const mount = (network = false) => {
    const container = document.createElement('main')
    document.body.appendChild(container)
    const onError = vi.fn(), onRendered = vi.fn()
    const host = mountHtmlPreview({ container, html: '<p>Test</p>', network, title: 'Report', getTheme: emptyTheme, onError, onRendered })
    const frame = container.querySelector('iframe')!
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    const message = (data: object, source: Window | null = frame.contentWindow) => {
      window.dispatchEvent(new MessageEvent('message', { data, source }))
    }
    return { host, frame, onError, onRendered, post, message }
  }

  it('only accepts messages from its own frame and matching render nonce', () => {
    const { host, frame, post, message, onRendered } = mount()
    expect(frame.src).toContain('/src/viz/sandbox.html')
    expect(frame.hasAttribute('srcdoc')).toBe(false)
    message({ type: 'viz:ready' }, window)
    expect(post).not.toHaveBeenCalled()
    message({ type: 'viz:ready' })
    message({ type: 'viz:ready' })
    expect(post).toHaveBeenCalledOnce()
    const render = post.mock.calls[0][0] as { id: string; html: string; theme: unknown }
    expect(render.html).toBe('<p>Test</p>')
    expect(render.theme).toEqual(emptyTheme())
    message({ type: 'viz:rendered', id: 'another-frame' })
    expect(onRendered).not.toHaveBeenCalled()
    message({ type: 'viz:resize', id: render.id, height: 420 })
    expect(frame.style.height).toBe('100%')
    message({ type: 'viz:rendered', id: render.id })
    expect(onRendered).toHaveBeenCalledOnce()
    host.updateTheme()
    expect(post.mock.calls.at(-1)?.[0]).toEqual({ type: 'viz:theme', id: render.id, theme: emptyTheme() })
    host.dispose()
  })

  it('selects the online sandbox only for explicit online capabilities', () => {
    const { host, frame } = mount(true)
    expect(frame.src).toContain('/src/viz/sandbox-online.html')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    host.dispose()
  })

  it('keeps retry instances isolated from stale sources and render nonces', () => {
    const first = mount()
    first.message({ type: 'viz:ready' })
    const oldId = (first.post.mock.calls[0][0] as { id: string }).id
    const oldSource = first.frame.contentWindow
    first.host.dispose()
    const second = mount()
    second.message({ type: 'viz:ready' }, oldSource)
    expect(second.post).not.toHaveBeenCalled()
    second.message({ type: 'viz:ready' })
    const newId = (second.post.mock.calls[0][0] as { id: string }).id
    expect(newId).not.toBe(oldId)
    second.message({ type: 'viz:error', id: oldId, message: 'old error' })
    expect(second.onError).not.toHaveBeenCalled()
    second.message({ type: 'viz:rendered', id: newId })
    expect(second.onRendered).toHaveBeenCalledOnce()
    second.host.dispose()
  })

  it('times out instead of leaving an unresponsive frame loading forever', () => {
    vi.useFakeTimers()
    const { host, onError } = mount()
    vi.advanceTimersByTime(12_000)
    expect(onError).toHaveBeenCalledWith('HTML 加载超时，请重试。')
    host.dispose()
  })

  it('reports renderer errors and removes the old listener on retry/dispose', () => {
    vi.useFakeTimers()
    const { host, post, message, onError, onRendered } = mount()
    message({ type: 'viz:ready' })
    const { id } = post.mock.calls[0][0] as { id: string }
    message({ type: 'viz:error', id, message: 'Script failed' })
    expect(onError).toHaveBeenCalledWith('Script failed')
    message({ type: 'viz:rendered', id })
    expect(onRendered).not.toHaveBeenCalled()
    host.dispose()
    message({ type: 'viz:error', id, message: 'Stale frame' })
    vi.advanceTimersByTime(12_000)
    expect(onError).toHaveBeenCalledOnce()
  })
})
