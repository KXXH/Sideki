import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleClick, handleHover, handleType, handleKeypress } from '../../src/background/tool-handlers'
import { measurePlanTarget, interpretPlan } from '../../src/background/input-interpreter'
import { __resetInputState } from '../../src/background/input-state'
import type { InputPlan } from '../../src/shared/input'

// Reason: the plan path splits one action across two injections — a measure that
// reports geometry and an interpret that replays the timeline. Neither can be
// exercised in node (no DOM), so what these tests pin is the seam: the shape of
// each injection, that the plan crossing it stays structured-clone safe, and
// that the allFrames retry contract still keys off the measure's error wording.

type Injection = {
  target: { tabId: number; allFrames?: boolean; frameIds?: number[] }
  func: (...a: never[]) => unknown
  args?: unknown[]
  injectImmediately?: boolean
}

function injections(): Injection[] {
  return vi.mocked(chrome.scripting.executeScript).mock.calls
    .map(c => c[0] as unknown as Injection)
}

function planInjections(): Injection[] {
  return injections().filter(i => i.func === measurePlanTarget || i.func === interpretPlan)
}

const RECT = { x: 40, y: 60, width: 100, height: 20 }
const PROBE = {
  connected: true,
  rendered: true,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  rect: RECT,
  viewport: { w: 1000, h: 800 },
  scrolled: true,
}

// Reason: mirrors what the page returns — resolver probe true, measure with a
// rect, interpret with an observation.
function stubPage(over: { interactive?: boolean; contentEditable?: boolean; probe?: Partial<typeof PROBE> } = {}) {
  vi.mocked(chrome.scripting.executeScript).mockImplementation((async (injection: Injection) => {
    if (injection.func === measurePlanTarget) {
      const result = {
        success: true, rect: RECT, tagName: 'BUTTON', docId: 'https://a.test/|T',
        probe: { ...PROBE, ...over.probe },
        interactive: over.interactive ?? true,
        contentEditable: over.contentEditable ?? false,
      }
      return [{ frameId: 0, result }]
    }
    if (injection.func === interpretPlan) {
      return [{ frameId: 0, result: { success: true, tagName: 'BUTTON', text: 'Submit', observed: { defaultPrevented: false, focusChanged: true, valueChanged: false, domMutated: true, urlChanged: false } } }]
    }
    // resolver probe
    return [{ frameId: 0, result: true }]
  }) as never)
}

function lastPlan(): InputPlan {
  const interpret = planInjections().filter(i => i.func === interpretPlan)
  const args = interpret[interpret.length - 1].args as [string, string, string | null]
  return JSON.parse(args[1]) as InputPlan
}

describe('plan path injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Reason: the position map is module level and survives between tests, so a
    // later plan would otherwise start where an earlier test's click ended.
    __resetInputState()
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url: 'https://a.test/', windowId: 1 } as never)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function run(fn: () => Promise<unknown>) {
    const pending = fn()
    await vi.advanceTimersByTimeAsync(10_000)
    return await pending as { success: boolean; error?: string; observed?: string }
  }

  it('measures then interprets — two injections, not three', async () => {
    stubPage()
    const r = await run(() => handleClick(1, { target: '#btn' }))
    expect(r.success).toBe(true)

    const plan = planInjections()
    expect(plan.map(i => i.func)).toEqual([measurePlanTarget, interpretPlan])
  })

  it('sends the target and a plan string across the boundary', async () => {
    stubPage()
    await run(() => handleClick(1, { target: '#btn' }))

    const [measure, interpret] = planInjections()
    expect(measure.args).toEqual(['#btn', true])
    const args = interpret.args as unknown[]
    expect(args[0]).toBe('#btn')
    expect(typeof args[1]).toBe('string')
    expect(args[2]).toBe('https://a.test/|T')
  })

  it('keeps the plan structured-clone safe', async () => {
    stubPage()
    await run(() => handleClick(1, { target: '#btn' }))

    const args = planInjections()[1].args as unknown[]
    // Reason: executeScript args cross a serialization boundary. A round-trip
    // through structuredClone is the same check Chrome applies.
    expect(() => structuredClone(args)).not.toThrow()
    for (const a of args) {
      expect(['string', 'object']).toContain(a === null ? 'object' : typeof a)
    }
  })

  it('aims at the measured element centre in frame-local coordinates', async () => {
    stubPage()
    await run(() => handleClick(1, { target: '#btn' }))
    expect(lastPlan().to).toEqual({ x: 90, y: 70 })
  })

  it('reports the observation back to the model', async () => {
    stubPage()
    const r = await run(() => handleClick(1, { target: '#btn' }))
    expect(r.observed).toContain('focus')
  })

  it('retries across all frames when the top frame has no match', async () => {
    let measures = 0
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async (injection: Injection) => {
      if (injection.func === measurePlanTarget) {
        measures++
        if (measures === 1) {
          return [{ frameId: 0, result: { success: false, error: 'No element found matching "#btn". Try a CSS selector or different text.' } }]
        }
        return [
          { frameId: 0, result: { success: false, error: 'No element found matching "#btn".' } },
          { frameId: 7, result: { success: true, rect: RECT, tagName: 'BUTTON', interactive: true, docId: 'd' } },
        ]
      }
      if (injection.func === interpretPlan) return [{ frameId: 7, result: { success: true, tagName: 'BUTTON' } }]
      return [{ frameId: 0, result: true }]
    }) as never)

    const r = await run(() => handleClick(1, { target: '#btn' }))
    expect(r.success).toBe(true)
    expect(measures).toBe(2)

    const interpret = planInjections().filter(i => i.func === interpretPlan)[0]
    expect(interpret.target.frameIds).toEqual([7])
  })

  it('does not retry when the failure is not a resolution failure', async () => {
    let measures = 0
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async (injection: Injection) => {
      if (injection.func === measurePlanTarget) {
        measures++
        return [{ frameId: 0, result: { success: false, error: 'Element is disabled' } }]
      }
      return [{ frameId: 0, result: true }]
    }) as never)

    const r = await run(() => handleClick(1, { target: '#btn' }))
    expect(r.success).toBe(false)
    expect(r.error).toBe('Element is disabled')
    expect(measures).toBe(1)
    expect(planInjections().some(i => i.func === interpretPlan)).toBe(false)
  })

  it('shortens the trajectory for a target inside an iframe', async () => {
    stubPage()
    await run(() => handleClick(1, { target: '#btn' }))
    const top = lastPlan()

    // Reason: a frame id only becomes non-zero through the allFrames retry, so
    // the nested case has to go through a top-frame miss to be reached at all.
    vi.clearAllMocks()
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async (injection: Injection) => {
      if (injection.func === measurePlanTarget) {
        if (injection.target.allFrames) {
          return [
            { frameId: 0, result: { success: false, error: 'No element found matching "#btn".' } },
            { frameId: 7, result: { success: true, rect: RECT, tagName: 'BUTTON', interactive: true, docId: 'd' } },
          ]
        }
        return [{ frameId: 0, result: { success: false, error: 'No element found matching "#btn". Try a CSS selector.' } }]
      }
      if (injection.func === interpretPlan) return [{ frameId: 7, result: { success: true, tagName: 'BUTTON' } }]
      return [{ frameId: 0, result: true }]
    }) as never)
    await run(() => handleClick(1, { target: '#btn' }))
    const nested = lastPlan()

    expect(nested.durationMs).toBeLessThan(top.durationMs)
    expect(nested.waypoints.length).toBeLessThan(top.waypoints.length)
  })
})

describe('plan path per-tool plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Reason: clearAllMocks does not clear mockResolvedValue, and the position
    // map is module level — without both resets this block depends on running
    // before the kill-switch test, which leaves labInputEngine false behind.
    __resetInputState()
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never)
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url: 'https://a.test/', windowId: 1 } as never)
    stubPage()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function run(fn: () => Promise<unknown>) {
    const pending = fn()
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    return lastPlan()
  }

  it('click ends with a press and release at the target', async () => {
    const plan = await run(() => handleClick(1, { target: '#btn' }))
    const mouse = plan.steps.filter(s => s.op.kind === 'mouse')
    expect(mouse.some(s => s.op.kind === 'mouse' && s.op.type === 'down')).toBe(true)
    expect(mouse.some(s => s.op.kind === 'mouse' && s.op.type === 'up')).toBe(true)
    expect(mouse[mouse.length - 1].point).toEqual({ x: 90, y: 70 })
  })

  it('hover never presses a button', async () => {
    const plan = await run(() => handleHover(1, { target: '#btn' }))
    expect(plan.steps.every(s => s.op.kind === 'mouse' && s.op.type === 'move')).toBe(true)
    expect(plan.steps.every(s => s.buttons === 0)).toBe(true)
  })

  it('type emits real keystrokes plus the value write', async () => {
    const plan = await run(() => handleType(1, { target: '#in', text: 'ab', clear: false }))
    const kinds = plan.steps.map(s => s.op.kind)
    expect(kinds).toContain('key')
    expect(kinds).toContain('edit')
    expect(plan.steps.filter(s => s.op.kind === 'edit' && s.op.op === 'insertChar')).toHaveLength(2)
  })

  it('type with clear leads with a deletion', async () => {
    const plan = await run(() => handleType(1, { target: '#in', text: 'x' }))
    expect(plan.steps.some(s => s.op.kind === 'edit' && s.op.op === 'deleteAll')).toBe(true)
  })

  it('keypress carries the modifier state', async () => {
    const plan = await run(() => handleKeypress(1, { key: 'Enter', target: '#in', ctrlKey: true }))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].modifiers.ctrl).toBe(true)
    expect(plan.steps[0].op).toMatchObject({ kind: 'key', type: 'down', key: 'Enter' })
  })

  it('targetless keypress skips the plan path entirely', async () => {
    await handleKeypress(1, { key: 'Escape' })
    expect(planInjections()).toHaveLength(0)
  })
})

describe('plan path continuity and kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    __resetInputState()
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url: 'https://a.test/', windowId: 1 } as never)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function run(fn: () => Promise<unknown>) {
    const pending = fn()
    await vi.advanceTimersByTimeAsync(10_000)
    return await pending as { success: boolean }
  }

  it('starts the second action where the first ended', async () => {
    stubPage()
    await run(() => handleClick(1, { target: '#btn' }))
    const first = lastPlan()
    expect(first.from).not.toEqual(first.to)

    await run(() => handleClick(1, { target: '#btn' }))
    const second = lastPlan()
    // Reason: this is the whole point of persisting the position — a second
    // click continues from the first instead of teleporting to an approach point.
    expect(second.from).toEqual({ x: first.endState.x, y: first.endState.y })
    expect(second.from).toEqual(first.to)
  })

  it('forgets the position when the document fingerprint changes', async () => {
    stubPage()
    await run(() => handleClick(1, { target: '#btn' }))

    // Reason: models an SPA soft navigation — same tab, replaced document.
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async (injection: Injection) => {
      if (injection.func === measurePlanTarget) {
        return [{ frameId: 0, result: { success: true, rect: RECT, tagName: 'BUTTON', interactive: true, docId: 'https://a.test/other|B' } }]
      }
      if (injection.func === interpretPlan) return [{ frameId: 0, result: { success: true, tagName: 'BUTTON' } }]
      return [{ frameId: 0, result: true }]
    }) as never)
    await run(() => handleClick(1, { target: '#btn' }))
    expect(lastPlan().from).not.toEqual({ x: 90, y: 70 })
  })

  it('falls back to the legacy path when the engine is switched off', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ sidekick_config: { labInputEngine: false } } as never)
    stubPage()
    await run(() => handleClick(1, { target: '#btn' }))

    expect(planInjections()).toHaveLength(0)
    // Reason: the legacy path passes the action name as the second argument to
    // one big resolve-and-dispatch function.
    const actions = injections().map(i => (i.args ?? [])[1])
    expect(actions).toContain('click')
  })
})

describe('renderability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    __resetInputState()
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never)
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url: 'https://a.test/', windowId: 1 } as never)
  })
  afterEach(() => { vi.useRealTimers() })

  async function run(fn: () => Promise<unknown>) {
    const pending = fn()
    await vi.advanceTimersByTimeAsync(10_000)
    return await pending as { success: boolean; error?: string }
  }

  // Reason: the whole point of the gate — an unrendered box has no hit testing,
  // so the old behaviour was to dispatch into nothing and report success.
  it('refuses an unrendered target without dispatching', async () => {
    stubPage({ probe: { rendered: false, display: 'none' } })
    const r = await run(() => handleClick(1, { target: '#hidden' }))

    expect(r.success).toBe(false)
    expect(r.error).toContain('display:none')
    expect(planInjections().map(i => i.func)).toEqual([measurePlanTarget])
  })

  it('refuses a zero-area box rather than dispatching at its corner', async () => {
    stubPage({ probe: { rect: { x: 0, y: 0, width: 0, height: 0 } } })
    const r = await run(() => handleHover(1, { target: '#empty' }))

    expect(r.success).toBe(false)
    expect(r.error).toContain('0x0')
  })

  it('refuses a target parked off-page', async () => {
    stubPage({ probe: { rect: { x: -9999, y: 10, width: 80, height: 20 } } })
    const r = await run(() => handleType(1, { target: '#sronly', text: 'hi' }))

    expect(r.success).toBe(false)
    expect(r.error).toContain('off-page')
  })

  // Reason: the sr-only pattern puts a real input at opacity 0 over a styled
  // span. Blocking it would break custom checkboxes and file pickers.
  it('lets an opacity 0 target through', async () => {
    stubPage({ probe: { opacity: 0 } })
    const r = await run(() => handleClick(1, { target: '#real-checkbox' }))

    expect(r.success).toBe(true)
    expect(planInjections().map(i => i.func)).toEqual([measurePlanTarget, interpretPlan])
  })

  it('lets a 1x1 clipped target through', async () => {
    stubPage({ probe: { rect: { x: 0, y: 0, width: 1, height: 1 } } })
    const r = await run(() => handleClick(1, { target: '#sr' }))
    expect(r.success).toBe(true)
  })

  // Reason: the element was located, so retrying across frames would be wasted
  // work — and would report the wrong failure if a frame happened to have one.
  it('does not trigger the allFrames retry for a hidden target', async () => {
    stubPage({ probe: { rendered: false, visibility: 'hidden' } })
    await run(() => handleClick(1, { target: '#hidden' }))

    expect(injections().some(i => i.target.allFrames && i.func === measurePlanTarget)).toBe(false)
  })
})

describe('observation baseline', () => {
  // Reason: interpretPlan runs in the page and cannot be executed under vitest's
  // node environment, so this pins the ordering in its source instead. The
  // pointer host is appended to documentElement inside the same injection that
  // observes documentElement for childList changes — arming before the append
  // makes domMutated permanently true, and because releaseTurn fades the host
  // out, the host is absent (and therefore re-created) at the start of most
  // turns. That would poison the one signal the model uses to decide whether a
  // click did anything.
  const src = interpretPlan.toString()

  it('arms the mutation observer after the pointer host is appended', () => {
    const observeAt = src.indexOf('.observe(')
    const appendAt = src.indexOf('appendChild(')
    expect(appendAt).toBeGreaterThan(-1)
    expect(observeAt).toBeGreaterThan(-1)
    expect(appendAt).toBeLessThan(observeAt)
  })

  it('observes only once', () => {
    expect(src.split('.observe(').length - 1).toBe(1)
  })

  // Reason: cue updates write into the shadow root. A MutationObserver on
  // documentElement does not traverse shadow trees, so they stay invisible —
  // but only as long as the cursor is reached through the shadow root.
  it('reaches the cursor through the shadow root', () => {
    expect(src).toContain('shadowRoot')
  })
})

describe('occlusion reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    __resetInputState()
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never)
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url: 'https://a.test/', windowId: 1 } as never)
  })
  afterEach(() => { vi.useRealTimers() })

  function stubWith(over: Record<string, unknown>) {
    vi.mocked(chrome.scripting.executeScript).mockImplementation((async (injection: Injection) => {
      if (injection.func === measurePlanTarget) {
        return [{ frameId: 0, result: { success: true, rect: RECT, tagName: 'BUTTON', docId: 'd', probe: PROBE, interactive: true } }]
      }
      if (injection.func === interpretPlan) {
        return [{ frameId: 0, result: { success: true, tagName: 'BUTTON', text: 'Submit', ...over } }]
      }
      return [{ frameId: 0, result: true }]
    }) as never)
  }

  async function run(fn: () => Promise<unknown>) {
    const pending = fn()
    await vi.advanceTimersByTimeAsync(10_000)
    return await pending as { success: boolean; occludedBy?: string; observed?: string }
  }

  // Reason: dispatching to the topmost element is correct — a real mouse hits the
  // banner too — but reporting the intended element's tagName while a banner took
  // the event tells the model it clicked Submit when it did not.
  it('passes the occluder through to the caller', async () => {
    stubWith({ occludedBy: 'div.cookie-banner' })
    const r = await run(() => handleClick(1, { target: '#submit' }))
    expect(r.success).toBe(true)
    expect(r.occludedBy).toBe('div.cookie-banner')
  })

  it('omits the field when nothing covered the point', async () => {
    stubWith({})
    const r = await run(() => handleClick(1, { target: '#submit' }))
    expect(r.occludedBy).toBeUndefined()
  })

  // Reason: the interpreter runs in the page and cannot execute under node, so
  // the subtree rule is pinned in its source. Hitting a descendant (a button's
  // inner span) or an ancestor (pointer-events:none) is ordinary and must not
  // report; only a genuinely different subtree counts.
  it('only counts a different subtree', () => {
    const src = interpretPlan.toString()
    expect(src).toContain('.contains(')
    expect(src.split('.contains(').length - 1).toBeGreaterThanOrEqual(2)
  })
})
