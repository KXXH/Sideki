// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StreamingMarkdown from '../../src/sidepanel/components/StreamingMarkdown'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('streamdown', () => ({
  Streamdown: ({ children, components }: { children: string; components: { a: React.ComponentType<{ href: string; children: string }> } }) => {
    const href = children.match(/\]\(([^)]+)\)/)?.[1] ?? ''
    return React.createElement(components.a, { href, children: '查看' })
  },
  useIsCodeFenceIncomplete: () => false,
}))

let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  chrome.runtime.getURL = vi.fn(path => `chrome-extension://extension/${path}`)
  chrome.storage.local.onChanged = { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(), hasListeners: vi.fn() }
  vi.mocked(chrome.tabs.create).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Markdown VFS preview links', () => {
  it.each([
    ['?network=1', '1'], ['?network=0', '0'], ['', '0'],
    ['?network=true', '0'], ['?network=1&network=0', '0'],
  ])('opens the correct file with URL-controlled mode (%s)', async (query, expected) => {
    await act(async () => root.render(<StreamingMarkdown content={`[查看](/viz/report.html${query})`} isStreaming={false} sessionId="session-a" />))
    const link = container.querySelector('button')!
    expect(link).not.toBeNull()
    await act(async () => link.click())
    expect(chrome.tabs.create).toHaveBeenCalledOnce()
    const url = new URL(vi.mocked(chrome.tabs.create).mock.calls[0][0].url as string)
    expect(url.searchParams.get('file')).toBe('/viz/report.html')
    expect(url.searchParams.get('session')).toBe('session-a')
    expect(url.searchParams.get('network')).toBe(expected)
  })

  it('decodes an encoded VFS filename without folding its query into the filename', async () => {
    await act(async () => root.render(<StreamingMarkdown content="[查看](/viz/%E8%90%A5%E6%94%B6%20%26%20%E5%88%A9%E6%B6%A6.html?network=1)" isStreaming={false} sessionId="session-b" />))
    await act(async () => container.querySelector('button')!.click())
    const url = new URL(vi.mocked(chrome.tabs.create).mock.calls[0][0].url as string)
    expect(url.searchParams.get('file')).toBe('/viz/营收 & 利润.html')
    expect(url.searchParams.get('network')).toBe('1')
  })
})
