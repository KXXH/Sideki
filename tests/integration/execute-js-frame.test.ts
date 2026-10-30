import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleExecuteJS } from '../../src/background/tool-handlers'

// Reason: tests exercise the real handleExecuteJS routing — the --frame guard
// on both debugger paths (pre-approved host + CSP fallback) must fail fast
// instead of silently evaluating in the top frame.

const CSP_FAILURE = { success: false, error: 'Script did not execute (page CSP may block eval)' }

const FRAMES = [
  { frameId: 0, parentFrameId: -1, url: 'https://example.com' },
  { frameId: 7, parentFrameId: 0, url: 'https://example.com/frame' },
]

function mockFrameResolution() {
  // Reason: resolveFrameId makes two executeScript calls (iframe probe + src read)
  vi.mocked(chrome.scripting.executeScript)
    .mockResolvedValueOnce([{ result: -1 }] as never)
    .mockResolvedValueOnce([{ result: 'https://example.com/frame' }] as never)
  vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue(FRAMES as never)
}

describe('handleExecuteJS --frame × debugger path', () => {
  beforeEach(() => {
    vi.mocked(chrome.scripting.executeScript).mockReset()
    vi.mocked(chrome.debugger.attach).mockClear()
    vi.mocked(chrome.debugger.sendCommand).mockClear()
    vi.mocked(chrome.runtime.sendMessage).mockClear()
    vi.mocked(chrome.storage.local.get).mockResolvedValue({})
  })

  it('frame execution succeeds when eval is not CSP-blocked', async () => {
    mockFrameResolution()
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([{ result: { success: true, result: '42' } }] as never)

    const r = await handleExecuteJS(1, { code: '1+1', frameSelector: 'iframe' }) as { success: boolean; result?: string }
    expect(r.success).toBe(true)
    expect(r.result).toBe('42')
    // eval call targets the resolved frameId
    const evalCall = vi.mocked(chrome.scripting.executeScript).mock.calls[2][0] as { target: { frameIds?: number[] } }
    expect(evalCall.target.frameIds).toEqual([7])
  })

  it('CSP fallback with --frame fails fast without consent prompt or debugger attach', async () => {
    mockFrameResolution()
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([{ result: CSP_FAILURE }] as never)

    const r = await handleExecuteJS(1, { code: '1+1', frameSelector: 'iframe' }) as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    expect(r.error).toContain('--frame')
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('pre-approved host with --frame fails fast instead of running in top frame', async () => {
    // Seed approvedDebuggerHosts via a frameless CSP fallback with granted consent
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: CSP_FAILURE }] as never)
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ granted: true } as never)
    vi.mocked(chrome.debugger.sendCommand).mockResolvedValue({ result: { value: { s: 1, r: '"ok"' } } } as never)
    const seed = await handleExecuteJS(1, { code: '1+1' }) as { success: boolean }
    expect(seed.success).toBe(true)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)

    // Same host now routes straight to debugger — --frame must be rejected
    mockFrameResolution()
    const r = await handleExecuteJS(1, { code: '1+1', frameSelector: 'iframe' }) as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    expect(r.error).toContain('--frame')
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)

    // Frameless execution on the approved host still works via debugger
    const ok = await handleExecuteJS(1, { code: '1+1' }) as { success: boolean }
    expect(ok.success).toBe(true)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
  })
})
