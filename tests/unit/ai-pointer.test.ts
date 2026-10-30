import { describe, it, expect, vi, beforeEach } from 'vitest'
import { animateAiPointer, removeAiPointer, animatePointerInTopFrame, hideAiPointer, setAiPointerEnabled, isAiPointerEnabled, AI_POINTER_MARKUP } from '../../src/background/ai-pointer'
import { interpretPlan } from '../../src/background/input-interpreter'
import { handleScreenshot } from '../../src/background/tool-handlers'
import { AI_POINTER_ID, AI_POINTER_Z_INDEX, SK_OVERLAY_ATTR, POINTER_SHAPES, reduceCues, initialVisual, pointerTransform, applyCue, planClick, initialMouseState } from '../../src/shared/input'

// Reason: the pointer is decoration driven by the same plan as the events, so
// what matters is (a) cue reduction produces the visual state the plan intends,
// (b) it is injected as an argument-driven, self-contained function, and (c) it
// can never fail or slow down the action it depicts.

describe('cue reduction', () => {
  it('lands on the plan target', () => {
    const plan = planClick({ ...initialMouseState(), x: 0, y: 0 }, { x: 200, y: 120 }, { interactive: true })
    const visual = reduceCues(plan.from, plan.cues)
    expect(visual.transform).toBe(pointerTransform({ x: 200, y: 120 }))
  })

  it('switches to the hand shape before a click on an interactive target', () => {
    const plan = planClick({ ...initialMouseState(), x: 0, y: 0 }, { x: 200, y: 120 }, { interactive: true })
    expect(reduceCues(plan.from, plan.cues).shape).toBe('hand')
  })

  it('keeps the arrow on a non-interactive target', () => {
    const plan = planClick({ ...initialMouseState(), x: 0, y: 0 }, { x: 200, y: 120 }, { interactive: false })
    expect(reduceCues(plan.from, plan.cues).shape).toBe('arrow')
  })

  it('releases the press by the end of the plan', () => {
    const plan = planClick({ ...initialMouseState(), x: 0, y: 0 }, { x: 200, y: 120 })
    expect(reduceCues(plan.from, plan.cues).pressed).toBe(false)
  })

  it('is pressed midway through a click', () => {
    const plan = planClick({ ...initialMouseState(), x: 0, y: 0 }, { x: 200, y: 120 })
    const pressAt = plan.cues.find(c => c.kind === 'press')!.at
    const upTo = plan.cues.filter(c => c.at <= pressAt)
    expect(reduceCues(plan.from, upTo).pressed).toBe(true)
  })

  it('renders position as a compositor-friendly transform', () => {
    expect(pointerTransform({ x: 12, y: 34 })).toContain('translate3d(12px, 34px, 0)')
  })

  it('ignores a move cue with no point', () => {
    const start = initialVisual({ x: 5, y: 5 })
    expect(applyCue(start, { at: 0, kind: 'move' }).transform).toBe(start.transform)
  })
})

describe('pointer injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setAiPointerEnabled(true)
  })

  function lastCall() {
    const calls = vi.mocked(chrome.scripting.executeScript).mock.calls
    return calls[calls.length - 1][0] as unknown as { target: { frameIds?: number[] }; func: unknown; args: unknown[] }
  }

  it('animates in the top frame only', () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: { ok: true } }] as never)
    animatePointerInTopFrame(1, [{ at: 0, kind: 'move', point: { x: 1, y: 2 } }], { x: 0, y: 0 })
    const call = lastCall()
    expect(call.target.frameIds).toEqual([0])
    expect(call.func).toBe(animateAiPointer)
  })

  it('passes the id, z-index and markup as arguments', () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: { ok: true } }] as never)
    animatePointerInTopFrame(1, [{ at: 0, kind: 'press' }], { x: 0, y: 0 })
    const args = lastCall().args
    expect(args[0]).toBe(AI_POINTER_ID)
    expect(args[1]).toBe(AI_POINTER_Z_INDEX)
    expect(args[2]).toBe(AI_POINTER_MARKUP)
    expect(typeof args[3]).toBe('string')
  })

  it('does nothing when the preference is off', () => {
    setAiPointerEnabled(false)
    expect(isAiPointerEnabled()).toBe(false)
    animatePointerInTopFrame(1, [{ at: 0, kind: 'press' }], { x: 0, y: 0 })
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('does nothing when there are no cues', () => {
    animatePointerInTopFrame(1, [], { x: 0, y: 0 })
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('swallows an injection failure instead of surfacing it', async () => {
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error('chrome:// page') as never)
    expect(() => animatePointerInTopFrame(1, [{ at: 0, kind: 'press' }], { x: 0, y: 0 })).not.toThrow()
    expect(() => hideAiPointer(1)).not.toThrow()
    await Promise.resolve()
  })

  it('hides by id in the top frame', () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: { ok: true } }] as never)
    hideAiPointer(1)
    const call = lastCall()
    expect(call.func).toBe(removeAiPointer)
    expect(call.args).toEqual([AI_POINTER_ID])
  })
})

describe('pointer glyph markup', () => {
  // Reason: every glyph rendered at once once before, because `.p > svg` (0,1,1)
  // set display:block and outranked `.arrow, .hand` (0,1,0) setting display:none.
  // There is no DOM here to render, so specificity is computed from the text.
  function specificity(selector: string): number {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length
    const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[a-z-]+\(/g) ?? []).length
    const types = (selector.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length
    return ids * 100 + classes * 10 + types
  }

  function rulesFor(prop: string, value: string): string[] {
    const out: string[] = []
    // Reason: comments must go first — otherwise the comment preceding a rule is
    // captured as part of its selector and its words count as type selectors.
    const sheet = AI_POINTER_MARKUP.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (new RegExp(`${prop}\\s*:\\s*${value}\\b`).test(m[2])) out.push(m[1].trim())
    }
    return out
  }

  it('reveals a glyph with higher specificity than it hides one', () => {
    const hide = rulesFor('display', 'none')
    const show = rulesFor('display', 'block')
    expect(hide.length).toBeGreaterThan(0)
    expect(show.length).toBeGreaterThan(0)

    const weakestShow = Math.min(...show.map(specificity))
    const strongestHide = Math.max(...hide.map(specificity))
    expect(weakestShow).toBeGreaterThan(strongestHide)
  })

  it('carries exactly one svg per declared shape', () => {
    const svgs = [...AI_POINTER_MARKUP.matchAll(/<svg class="(\w+)"/g)].map(m => m[1])
    expect(svgs.sort()).toEqual([...POINTER_SHAPES].sort())
  })

  it('declares a hotspot for every glyph', () => {
    // Reason: an icon is drawn centred in its box but a cursor's tip has to land
    // on the event coordinate, so each glyph must say where its own tip is.
    const svgs = [...AI_POINTER_MARKUP.matchAll(/<svg class="\w+"([^>]*)>/g)].map(m => m[1])
    expect(svgs.length).toBe(POINTER_SHAPES.length)
    for (const attrs of svgs) {
      expect(attrs).toMatch(/--tx:\s*[\d.]+/)
      expect(attrs).toMatch(/--ty:\s*[\d.]+/)
    }
  })

  it('signals the press with fill rather than a second element', () => {
    expect(AI_POINTER_MARKUP).toContain("data-press='1'")
    expect(AI_POINTER_MARKUP).toMatch(/data-press='1'\][^{]*\{[^}]*fill-opacity/)
  })

  it('outlines every glyph so it stays visible on any background', () => {
    // Reason: a white cursor vanishes on a white page and a dark one on a dark
    // page — each stroke path needs a wider light halo underneath it.
    const halos = (AI_POINTER_MARKUP.match(/class="halo"/g) ?? []).length
    expect(halos).toBeGreaterThanOrEqual(POINTER_SHAPES.length)
  })
})

describe('pointer serialization safety', () => {
  it('marks the host with the shared overlay attribute', () => {
    // Reason: the perception paths exclude by attribute, so a pointer host that
    // forgets it would leak into dom snapshots and page content.
    expect(animateAiPointer.toString()).toContain(SK_OVERLAY_ATTR)
    expect(interpretPlan.toString()).toContain(SK_OVERLAY_ATTR)
  })

  it('takes markup as a parameter rather than closing over it', () => {
    const src = animateAiPointer.toString()
    expect(src).not.toContain('AI_POINTER_MARKUP')
    expect(src).toContain('markup')
  })

  it('collapses the timeline for a hidden tab', () => {
    // Reason: Chrome clamps a hidden page's timers to ~1/s and stops painting,
    // so a waypoint animation there would stall the action for seconds.
    expect(animateAiPointer.toString()).toContain('visibilityState')
  })
})

describe('screenshot does not photograph the pointer', () => {
  // Reason: OVERLAY_SELECTOR keeps the overlay out of the resolver, the DOM
  // snapshot and the raw HTML, but a screenshot is pixels — attribute-based
  // exclusion cannot help, so the pointer has to be hidden first.
  it('hides the pointer before capturing', async () => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, windowId: 9, active: true } as never)
    vi.mocked(chrome.tabs.captureVisibleTab).mockResolvedValue('data:image/jpeg;base64,AAAA' as never)
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never)
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { ok: true } }] as never)

    const order: string[] = []
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async () => {
      order.push('inject')
      return [{ frameId: 0, result: { ok: true } }]
    }) as never)
    vi.mocked(chrome.tabs.captureVisibleTab).mockImplementation((async () => {
      order.push('capture')
      return 'data:image/jpeg;base64,AAAA'
    }) as never)

    // Reason: compressDataUrl needs createImageBitmap, which node does not
    // have. It runs after the capture, so the ordering this test cares about is
    // already recorded by the time it throws.
    const pending = handleScreenshot(1, {}).catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    await pending

    expect(order.indexOf('inject')).toBeGreaterThan(-1)
    expect(order.indexOf('inject')).toBeLessThan(order.indexOf('capture'))
    vi.useRealTimers()
  })
})

describe('screenshot refuses a backgrounded operating tab', () => {
  // Reason: captureVisibleTab photographs the window's visible tab, not the
  // tab id — a backgrounded operating tab would yield the foreground tab's
  // pixels and hand the model a picture of a page it never touched.
  it('fails before any side effects when the operating tab is not active', async () => {
    vi.clearAllMocks()
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, windowId: 9, active: false, title: 'Locked page' } as never)

    const r = await handleScreenshot(1, {}) as { success: boolean; error?: string }

    expect(r.success).toBe(false)
    expect(r.error).toContain('background')
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled()
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('captures normally when the operating tab is active', async () => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, windowId: 9, active: true } as never)
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never)
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { ok: true } }] as never)
    vi.mocked(chrome.tabs.captureVisibleTab).mockResolvedValue('data:image/jpeg;base64,AAAA' as never)

    // Reason: compressDataUrl needs createImageBitmap, which node lacks — the
    // capture assertion is recorded before it throws.
    const pending = handleScreenshot(1, {}).catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    await pending

    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(9, expect.anything())
    vi.useRealTimers()
  })
})
