import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleWait, handleNavigate } from '../../src/background/tool-handlers'

// Reason: an agent reported `bash: execution aborted` from page-wait and navigate
// on pages it had not cancelled. Root cause was structural, not a logic bug:
// every SW-side lifeline was sized ABOVE the 5s Chat bash budget, so bash always
// aborted first and the model read something that looked like user cancellation.
// These tests pin the budget relationship, which no type or lint check can.
const CHAT_BASH_BUDGET_MS = 5000

describe('wait and navigate stay inside the bash budget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('a hanging injection ends inside the budget and says why', async () => {
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async () => {
      // Reason: a frame mid-navigation never accepts the script, so the promise
      // simply never settles — the only thing that can end the call is the
      // deadline inside execScript.
      return await new Promise(() => {})
    }) as never)
    const p = handleWait(1, { target: '.spinner', timeout: 3000, maxMs: 4000 })
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(CHAT_BASH_BUDGET_MS - 1)
    await Promise.resolve()
    expect(settled).toBe(true)
    const r = await p as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    // Reason: the injected function's own timeout is unreachable when the
    // injection never lands, so "not found" would be a lie about what happened.
    expect(r.error).not.toContain('not found')
    expect(r.error).toContain('still navigating')
  })

  it('slow attempts cannot push the total past the budget', async () => {
    // Reason: each attempt takes nearly the full per-attempt deadline, so an
    // attempt starting near the end used to add its whole length on top —
    // 4000 + 1500 = 5500, over the budget the clamp exists to respect, which
    // reproduced the original `execution aborted` symptom.
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async () => {
      await new Promise(r => setTimeout(r, 1400))
      return [{ frameId: 0, result: { found: false } }]
    }) as never)
    const p = handleWait(1, { target: '#nope', timeout: 4000, maxMs: 4000 })
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(CHAT_BASH_BUDGET_MS - 1)
    await Promise.resolve()
    expect(settled).toBe(true)
    await p
  })

  it('keeps retrying after a deadline miss while budget remains', async () => {
    let attempt = 0
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async () => {
      attempt++
      // Reason: the page commits partway through the wait. Giving up on the first
      // deadline miss would fail a wait that the old in-page loop got right.
      if (attempt === 1) return await new Promise(() => {})
      return [{ frameId: 0, result: { found: true } }]
    }) as never)
    const p = handleWait(1, { target: '#late', timeout: 4000, maxMs: 4000 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toEqual({ success: true })
    expect(attempt).toBeGreaterThan(1)
  })

  it('returns on the first attempt when the element is already there', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { found: true } }] as never)
    const p = handleWait(1, { target: '#dd', timeout: 3000 })
    // Reason: the regression this replaces — the poll loop used to live inside the
    // injected function, and allFrames only settles once every frame's copy
    // returns, so an already-present element still cost ~1x timeout.
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ success: true })
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1)
  })

  it('a frame that never holds the target does not delay a hit in another frame', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([
      { frameId: 0, result: { found: false } },
      { frameId: 2, result: { found: true } },
    ] as never)
    const p = handleWait(1, { target: '#dd', timeout: 3000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ success: true })
  })

  it("passes Chrome's own failure message through instead of guessing", async () => {
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(
      new Error('Frame with ID 0 is showing error page'),
    )
    const r = await handleWait(1, { target: '#dd', timeout: 3000 }) as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    expect(r.error).toBe('Frame with ID 0 is showing error page')
    // Reason: a refused connection never settles, so "wait for it to settle" is
    // not merely unhelpful, it is wrong. Chrome already named the cause.
    expect(r.error).not.toContain('still navigating')
    expect(r.error).not.toContain('settle')
  })

  it('polls until the timeout before reporting a genuine miss', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { found: false } }] as never)
    const p = handleWait(1, { target: '#nope', timeout: 1000 })
    await vi.advanceTimersByTimeAsync(1500)
    const r = await p as { success: boolean; error?: string }
    expect(r.error).toContain('not found within 1000ms')
    // Reason: waiting for something that never appears must still cost the full
    // timeout — that is what a wait means. Only the already-present case got faster.
    expect(vi.mocked(chrome.scripting.executeScript).mock.calls.length).toBeGreaterThan(1)
  })

  it('honours the full timeout when the caller has no budget', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { found: false } }] as never)
    // Reason: the native wait tool does not run under a bash budget, so it passes
    // no maxMs. Capping it anyway would silently shorten the wait it asked for and
    // then blame a budget that does not apply to it.
    const p = handleWait(1, { target: '#nope', timeout: 20_000 })
    await vi.advanceTimersByTimeAsync(21_000)
    const r = await p as { success: boolean; error?: string }
    expect(r.error).toContain('not found within 20000ms')
    expect(r.error).not.toContain('capped')
  })

  it('says so when an over-budget timeout is capped', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { found: false } }] as never)
    const p = handleWait(1, { target: '#nope', timeout: 20_000, maxMs: 4000 })
    await vi.advanceTimersByTimeAsync(CHAT_BASH_BUDGET_MS)
    const r = await p as { success: boolean; error?: string }
    // Reason: a silently shortened wait reads as a flaky page. Name the clamp so
    // the caller can split the work instead of retrying the same thing.
    expect(r.error).toContain('requested 20000ms')
    expect(r.error).toContain("capped to 4000ms by the caller's budget")
  })

  it('navigate resolves within the budget when the load never completes', async () => {
    vi.mocked(chrome.tabs.update).mockResolvedValue({} as never)
    const p = handleNavigate(1, { url: 'http://10.255.255.1/' })
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(CHAT_BASH_BUDGET_MS - 1)
    await Promise.resolve()
    expect(settled).toBe(true)
    const r = await p as { success: boolean; pending?: boolean; message?: string }
    // Reason: the navigation did start, so this is not a failure — but the frame
    // is still pending, which is exactly what makes a following page-wait fail.
    expect(r.success).toBe(true)
    expect(r.pending).toBe(true)
    expect(r.message).toContain('still loading')
  })

  it('navigate reports plain success once the tab completes', async () => {
    vi.mocked(chrome.tabs.update).mockResolvedValue({} as never)
    let fire: ((id: number, info: { status?: string }) => void) | undefined
    vi.mocked(chrome.tabs.onUpdated.addListener).mockImplementation((fn: unknown) => {
      fire = fn as (id: number, info: { status?: string }) => void
    })
    const p = handleNavigate(1, { url: 'https://a.test/' })
    await Promise.resolve()
    fire?.(1, { status: 'complete' })
    const r = await p as { success: boolean; pending?: boolean }
    expect(r.success).toBe(true)
    expect(r.pending).toBeUndefined()
  })
})
