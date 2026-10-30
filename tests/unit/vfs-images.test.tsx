// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StreamingMarkdown from '../../src/sidepanel/components/StreamingMarkdown'

vi.mock('@iconify/react', () => ({ Icon: () => null }))

let root: Root, container: HTMLDivElement
const createUrl = vi.fn((blob: Blob) => { void blob; return 'blob:vfs-image' })
const revokeUrl = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  chrome.storage.local.onChanged = { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(), hasListeners: vi.fn() }
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl })
  createUrl.mockClear()
  revokeUrl.mockClear()
  vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue({ success: true, content: '\x89PNG\xff' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())

async function render(content: string, sessionId: string | undefined = 'session-a') {
  await act(async () => root.render(<StreamingMarkdown content={content} isStreaming={false} sessionId={sessionId} />))
}

describe('Markdown VFS images', () => {
  it('renders encoded VFS paths through the real Markdown pipeline and preserves binary bytes', async () => {
    await render('![截图](/tmp/%E6%88%AA%E5%9B%BE.png "标题")')
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'dev:cat', sessionId: 'session-a', path: '/tmp/截图.png' })
    const image = container.querySelector('img')!
    expect(image?.getAttribute('src')).toBe('blob:vfs-image')
    expect(image.alt).toBe('截图')
    expect(image.title).toBe('标题')
    const blob = createUrl.mock.calls[0]?.[0] as unknown as Blob
    expect(blob.type).toBe('image/png')
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = reject
      reader.readAsArrayBuffer(blob)
    })
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0xff])
    await act(async () => root.render(<div />))
    expect(revokeUrl).toHaveBeenCalledWith('blob:vfs-image')
  })

  it('keeps network images on the default Streamdown renderer', async () => {
    await render('![远程](https://example.com/image.png)')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/image.png')
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
  })

  it.each(['/page/screen.jpg', '/viz/chart.svg'])('supports %s', async path => {
    await render(`![图](${path})`)
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'dev:cat', sessionId: 'session-a', path })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:vfs-image')
  })

  it.each(['/tmp/../notes/private.png', '/tmp/%2e%2e/notes/private.png', '/viz/report.html'])('does not read invalid or non-image VFS paths (%s)', async path => {
    await render(`![图](${path})`)
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('图片加载失败')
  })

  it('shows a read failure without falling back to a network URL', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: false, error: 'missing' })
    await render('![缺失](/tmp/missing.png)')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('图片加载失败：缺失')
  })

  it('does not read a VFS image without a message session', async () => {
    await act(async () => root.render(<StreamingMarkdown content="![图](/tmp/image.png)" isStreaming={false} />))
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('图片加载失败')
  })

  it('releases the previous session image immediately while the next one loads', async () => {
    const content = '![图](/tmp/image.png)'
    await render(content)
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => new Promise(() => {}))
    await render(content, 'session-b')
    expect(revokeUrl).toHaveBeenCalledWith('blob:vfs-image')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('正在加载图片')
    await render(content, 'session-a')
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'dev:cat', sessionId: 'session-a', path: '/tmp/image.png' })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:vfs-image')
  })

  it('shows corrupt image failures', async () => {
    await render('![坏图](/tmp/broken.png)')
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('图片加载失败：坏图')
  })

  it('discards a stale read after switching sessions even when the Markdown is unchanged', async () => {
    let resolveOld!: (response: { success: boolean; content: string }) => void
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    await render('![图](/tmp/image.png)')
    expect(container.textContent).toContain('正在加载图片')
    await render('![图](/tmp/image.png)', 'session-b')
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'dev:cat', sessionId: 'session-b', path: '/tmp/image.png' })
    expect(createUrl).toHaveBeenCalledOnce()
    await act(async () => resolveOld({ success: true, content: 'old' }))
    expect(createUrl).toHaveBeenCalledOnce()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:vfs-image')
  })
})
