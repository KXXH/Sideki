import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleGetPageContent, handleDomSnapshot, handleFindElement } from '../../src/background/tool-handlers'

// Reason: executeScript defaults to document_idle in every target frame and only
// settles once all injections complete, so one frame that never reaches idle
// (off-screen lazy iframe, autoplaying media embed) hung getPageContent forever.
// These tests pin both halves of the fix: read-only extraction must opt into
// injectImmediately, and a stalled injection must surface as an error.
// The getPageContent two-phase pipeline itself is covered in
// page-content-pipeline.test.ts.

// Reason: shaped to satisfy both phases — metrics for the probe, html for the grab.
const PROBE_AND_HTML = {
  url: 'https://a.com/', title: 'T', html: '<p>body</p>',
  textLen: 4000, htmlLen: 20000, area: 1_200_000, hasSemantic: true,
}

type Injection = { target: { allFrames?: boolean; frameIds?: number[] }; injectImmediately?: boolean }

function lastInjection(): Injection {
  const calls = vi.mocked(chrome.scripting.executeScript).mock.calls
  return calls[calls.length - 1][0] as unknown as Injection
}

describe('script injection timing', () => {
  beforeEach(() => {
    vi.mocked(chrome.scripting.executeScript).mockReset()
  })

  it('getPageContent injects immediately when targeting one frame', async () => {
    vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://a.com' },
      { frameId: 7, parentFrameId: 0, url: 'https://a.com/embed' },
    ] as never)
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([{ result: -1 }] as never)
      .mockResolvedValueOnce([{ result: 'https://a.com/embed' }] as never)
      .mockResolvedValueOnce([{ result: { title: 'T', url: 'https://a.com/embed', html: 'y' } }] as never)

    const r = await handleGetPageContent(1, { frame: 'iframe' }) as { success: boolean }
    expect(r.success).toBe(true)
    expect(lastInjection().injectImmediately).toBe(true)
  })

  it('domSnapshot and findElement also inject immediately', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: null }] as never)
    await handleDomSnapshot(1, {})
    expect(lastInjection().injectImmediately).toBe(true)

    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: [] }] as never)
    await handleFindElement(1, { text: 'Submit' })
    expect(lastInjection().injectImmediately).toBe(true)
  })
})

describe('script injection deadline', () => {
  beforeEach(() => {
    vi.mocked(chrome.scripting.executeScript).mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports an error instead of hanging when a frame never settles', async () => {
    // Reason: models the pathological case — executeScript never resolves.
    vi.mocked(chrome.scripting.executeScript).mockReturnValue(new Promise(() => {}) as never)

    const pending = handleGetPageContent(1, {}) as Promise<{ success: boolean; error?: string }>
    await vi.advanceTimersByTimeAsync(30_000)
    const r = await pending

    expect(r.success).toBe(false)
    expect(r.error).toContain('timed out after 30000ms')
    expect(r.error).toContain('allFrames')
  })

  it('does not fire before the deadline elapses', async () => {
    let settle: (v: unknown) => void = () => {}
    vi.mocked(chrome.scripting.executeScript).mockReturnValue(
      new Promise(res => { settle = res }) as never,
    )

    const pending = handleGetPageContent(1, {}) as Promise<{ success: boolean }>
    await vi.advanceTimersByTimeAsync(29_000)
    settle([{ result: PROBE_AND_HTML, frameId: 0 }])
    await vi.advanceTimersByTimeAsync(0)

    expect((await pending).success).toBe(true)
  })
})
