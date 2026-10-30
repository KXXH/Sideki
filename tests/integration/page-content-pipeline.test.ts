import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleGetPageContent } from '../../src/background/tool-handlers'

// Reason: extraction is a two-phase pipeline — measure every frame cheaply, then
// fetch HTML from the winner alone. These tests pin the phase wiring, the
// navigation fallback, and numeric frame addressing.

type Injection = { target: { allFrames?: boolean; frameIds?: number[] }; injectImmediately?: boolean }

function injections(): Injection[] {
  return vi.mocked(chrome.scripting.executeScript).mock.calls.map(c => c[0] as unknown as Injection)
}

const METRICS = {
  url: 'https://a.com/',
  title: 'Article',
  textLen: 4000,
  htmlLen: 20000,
  area: 1_200_000,
  hasSemantic: true,
}

const HTML = { title: 'Article', url: 'https://a.com/', html: '<p>body</p>' }

describe('getPageContent extraction pipeline', () => {
  beforeEach(() => {
    vi.mocked(chrome.scripting.executeScript).mockReset()
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, status: 'complete' } as never)
  })

  it('measures all frames, then fetches only the winning frame', async () => {
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([
        { result: METRICS, frameId: 0 },
        { result: { ...METRICS, textLen: 9000, url: 'https://docs.x.com/d' }, frameId: 7 },
      ] as never)
      .mockResolvedValueOnce([{ result: HTML }] as never)

    const r = await handleGetPageContent(1, {}) as { success: boolean; frameId?: number; frameNote?: string }
    expect(r.success).toBe(true)

    const [probe, grab] = injections()
    expect(probe.target.allFrames).toBe(true)
    expect(probe.injectImmediately).toBe(true)
    // 9000 × 2.0 semantic beats 4000 × 2.0 × 1.5 top
    expect(grab.target.frameIds).toEqual([7])
    expect(grab.injectImmediately).toBe(true)
    expect(r.frameId).toBe(7)
    expect(r.frameNote).toContain('[content from frame 7')
    expect(r.frameNote).toContain('- 0 ·')
  })

  it('emits no frame note for an ordinary single-frame page', async () => {
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([{ result: METRICS, frameId: 0 }] as never)
      .mockResolvedValueOnce([{ result: HTML }] as never)

    const r = await handleGetPageContent(1, {}) as { success: boolean; frameId?: number; frameNote?: string }
    expect(r.frameId).toBe(0)
    expect(r.frameNote).toBeUndefined()
  })

  it('drops frames with no committed document before ranking', async () => {
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([
        { result: METRICS, frameId: 0 },
        { result: null, frameId: 9 },
        { result: null, frameId: 11 },
      ] as never)
      .mockResolvedValueOnce([{ result: HTML }] as never)

    const r = await handleGetPageContent(1, {}) as { success: boolean; frameCount?: number; frameNote?: string }
    expect(r.success).toBe(true)
    expect(r.frameCount).toBe(1)
    expect(r.frameNote).toBeUndefined()
  })

  it('falls back to the top frame when the winner disappears mid-flight', async () => {
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([
        { result: METRICS, frameId: 0 },
        { result: { ...METRICS, textLen: 9000 }, frameId: 7 },
      ] as never)
      .mockResolvedValueOnce([{ result: null }] as never)
      .mockResolvedValueOnce([{ result: HTML }] as never)

    const r = await handleGetPageContent(1, {}) as { success: boolean; frameId?: number }
    expect(r.success).toBe(true)
    expect(r.frameId).toBe(0)
    expect(injections()[2].target.frameIds).toEqual([0])
  })

  it('reports no readable content when every frame is empty', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: null, frameId: 0 }] as never)

    const r = await handleGetPageContent(1, {}) as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    expect(r.error).toBe('No readable content found on page')
    // Reason: nothing worth fetching — the second phase must be skipped entirely.
    expect(injections()).toHaveLength(1)
  })

  it('strips invisible watermark characters from title and html', async () => {
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([{ result: METRICS, frameId: 0 }] as never)
      .mockResolvedValueOnce([{ result: {
        title: '\u200B\u2061\u202CDoc',
        url: 'https://a.com/',
        html: '<p>a\u200Bb</p>',
      } }] as never)

    const r = await handleGetPageContent(1, {}) as { success: boolean; title?: string; html?: string }
    expect(r.title).toBe('Doc')
    expect(r.html).toBe('<p>ab</p>')
  })

  it('waits for the top frame when the tab is still loading', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, status: 'loading' } as never)
    vi.mocked(chrome.tabs.onUpdated.addListener).mockImplementation(((fn: (id: number, info: { status?: string }) => void) => {
      // Reason: simulate the load completing right after the gate subscribes.
      setTimeout(() => fn(1, { status: 'complete' }), 0)
    }) as never)
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([{ result: METRICS, frameId: 0 }] as never)
      .mockResolvedValueOnce([{ result: HTML }] as never)

    const r = await handleGetPageContent(1, {}) as { success: boolean }
    expect(r.success).toBe(true)
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalled()
  })
})

describe('numeric frame addressing', () => {
  beforeEach(() => {
    vi.mocked(chrome.scripting.executeScript).mockReset()
    vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://a.com/' },
      { frameId: 7, parentFrameId: 3, url: 'https://docs.x.com/d' },
    ] as never)
  })

  it('reads a nested frame by id without a CSS selector', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: HTML }] as never)

    const r = await handleGetPageContent(1, { frame: '7' }) as { success: boolean; frameId?: number }
    expect(r.success).toBe(true)
    expect(r.frameId).toBe(7)
    // Reason: numeric form must skip selector probing entirely — one call only.
    expect(injections()).toHaveLength(1)
    expect(injections()[0].target.frameIds).toEqual([7])
  })

  it('accepts the #id form too', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: HTML }] as never)
    const r = await handleGetPageContent(1, { frame: '#7' }) as { success: boolean; frameId?: number }
    expect(r.frameId).toBe(7)
  })

  it('rejects an id that is not on the page', async () => {
    const r = await handleGetPageContent(1, { frame: '42' }) as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    expect(r.error).toBe('No frame with id 42 on this page')
  })
})
