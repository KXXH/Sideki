import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleClick } from '../../src/background/tool-handlers'
import { debugSession } from '../../src/background/debug-session'
import { __resetInputState } from '../../src/background/input-state'
import { armObservation, collectObservation } from '../../src/background/input-interpreter'

// Reason: the page reports this so the service worker can refuse an unrendered
// target before paying for a debugger attach. Visible by default; the refusal
// cases override it.
const VISIBLE_PROBE = {
  connected: true,
  rendered: true,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  rect: { x: 40, y: 60, width: 100, height: 20 },
  viewport: { w: 1200, h: 900 },
  scrolled: true,
}

const chromeMock = chrome as unknown as {
  tabs: { get: ReturnType<typeof vi.fn> }
  runtime: { sendMessage: ReturnType<typeof vi.fn> }
  scripting: { executeScript: ReturnType<typeof vi.fn> }
  debugger: { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> }
  webNavigation: { getAllFrames: ReturnType<typeof vi.fn> }
}

// Reason: the real-click path used to send exactly two bare commands
// (mousePressed, mouseReleased) with no trajectory, no buttons bitmask, no
// press/release gap, and a single pair for double clicks — and it measured the
// element without scrolling it into view first, so anything below the fold was
// clicked at negative coordinates. It also attached the debugger, raising
// Chrome's banner, without ever asking. These tests pin all of that.

function mouseEvents() {
  return chromeMock.debugger.sendCommand.mock.calls
    .filter(c => c[1] === 'Input.dispatchMouseEvent')
    .map(c => c[2] as Record<string, unknown>)
}

function injectedActions() {
  return chromeMock.scripting.executeScript.mock.calls
    .map(c => (c[0].args as unknown[] | undefined)?.[1])
    .filter(Boolean)
}

// Reason: a single top-level element at rect 40,60 100x20 — centre is 90,70.
function stubTopLevelElement(hostname = 'host.test') {
  chromeMock.tabs.get.mockResolvedValue({ id: 1, url: `https://${hostname}/page`, windowId: 1 })
  chromeMock.webNavigation.getAllFrames.mockResolvedValue([
    { frameId: 0, parentFrameId: -1, url: `https://${hostname}/page` },
  ])
  chromeMock.scripting.executeScript.mockImplementation(async (injection: Record<string, unknown>) => {
    const args = injection.args as unknown[] | undefined
    if (args?.[1] === 'getElementInfo') {
      return [{ frameId: 0, result: { success: true, boundingRect: { x: 40, y: 60, width: 100, height: 20 }, probe: VISIBLE_PROBE } }]
    }
    // Reason: the service worker skips collection entirely when the arm did not
    // take, so the stub has to answer with what the page really returns.
    if (injection.func === armObservation) return [{ frameId: 0, result: { ok: true } }]
    if (injection.func === collectObservation) {
      return [{ frameId: 0, result: { focusChanged: false, valueChanged: false, domMutated: false } }]
    }
    return [{ frameId: 0, result: { success: true } }]
  })
}

// Reason: the plan carries real press/release and trajectory delays. Their values
// are asserted in input-cdp.test.ts against the pure projection, so here they are
// only fast-forwarded — otherwise every case costs ~700ms of wall clock.
async function runClick(params: { target: string; real?: boolean; doubleClick?: boolean }) {
  const pending = handleClick(1, params)
  await vi.advanceTimersByTimeAsync(5_000)
  return pending as Promise<{ success: boolean; error?: string }>
}

describe('handleClick real=true', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Reason: the position map is module level, so without this a later test
    // starts where an earlier click ended and its trajectory collapses.
    __resetInputState()
    chromeMock.tabs.get.mockResolvedValue({ id: 1, url: 'https://host.test/page', windowId: 1 })
    chromeMock.runtime.sendMessage.mockResolvedValue({ granted: true })
    chromeMock.debugger.attach.mockResolvedValue(undefined)
    chromeMock.debugger.detach.mockResolvedValue(undefined)
    chromeMock.debugger.sendCommand.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('converts iframe-local element rect to top viewport coordinates', async () => {
    chromeMock.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://host.test/page' },
      { frameId: 7, parentFrameId: 0, url: 'https://child.test/frame' },
    ])
    chromeMock.scripting.executeScript.mockImplementation(async (injection: Record<string, unknown>) => {
      const target = injection.target as { allFrames?: boolean } | undefined
      const args = injection.args as unknown[] | undefined

      if (target?.allFrames) {
        return [
          { frameId: 0, result: { success: false, error: 'No element found matching "#inside".' } },
          { frameId: 7, result: { success: true, boundingRect: { x: 10, y: 20, width: 30, height: 40 } } },
        ]
      }
      if (args?.[0] === 'https://child.test/frame') {
        return [{ frameId: 0, result: { success: true, rect: { x: 100, y: 200, width: 500, height: 300 } } }]
      }
      if (args?.[1] === 'getElementInfo') {
        return [{ frameId: 0, result: { success: false, error: 'No element found matching "#inside".' } }]
      }
      return [{ frameId: 0, result: true }]
    })

    const result = await runClick({ target: '#inside', real: true })

    expect(result.success).toBe(true)
    // iframe owner at (100,200) + element (10,20) + half of 30x40 => (125,240)
    const press = mouseEvents().find(e => e.type === 'mousePressed')!
    expect(press).toMatchObject({ x: 125, y: 240, button: 'left', clickCount: 1 })
    const release = mouseEvents().find(e => e.type === 'mouseReleased')!
    expect(release).toMatchObject({ x: 125, y: 240, button: 'left', clickCount: 1 })
  })

  it('scrolls the element into view before measuring it', async () => {
    stubTopLevelElement()
    await runClick({ target: '#below', real: true })
    const actions = injectedActions()
    // Reason: measuring first would capture a negative rect for anything below
    // the fold, and scrolling afterwards would invalidate the coordinates.
    expect(actions.indexOf('scrollIntoView')).toBeLessThan(actions.indexOf('getElementInfo'))
  })

  // Reason: a real click is the escalation path, so it used to skip everything
  // the synthetic path gained — it animated from a fixed origin, left no trace
  // for the next action, and drew no pointer even though it is the one action
  // most likely to navigate or open a window.
  it('starts where the previous click ended', async () => {
    stubTopLevelElement()
    await runClick({ target: '#btn', real: true })
    const first = mouseEvents()
    expect(first.filter(e => e.type === 'mouseMoved').length).toBeGreaterThan(1)

    chromeMock.debugger.sendCommand.mockClear()
    await runClick({ target: '#btn', real: true })
    const second = mouseEvents()

    // Reason: same target twice — the cursor is already there, so there is
    // nothing to traverse. A fixed approach origin would replay the whole
    // trajectory and read as a teleport back before every click.
    expect(second.filter(e => e.type === 'mouseMoved').length).toBeLessThan(
      first.filter(e => e.type === 'mouseMoved').length,
    )
  })

  it('animates the pointer overlay in the top frame after attach', async () => {
    stubTopLevelElement()
    await runClick({ target: '#btn', real: true })

    const pointer = chromeMock.scripting.executeScript.mock.calls
      .map(c => c[0] as { target?: { frameIds?: number[] }; args?: unknown[] })
      .filter(c => typeof c.args?.[0] === 'string' && c.args[0] === '__sidekick_ai_pointer__')
    expect(pointer).toHaveLength(1)
    expect(pointer[0].target?.frameIds).toEqual([0])
    // Reason: the cue timeline crosses executeScript, so it has to be a string.
    expect(typeof pointer[0].args?.[3]).toBe('string')
  })

  // Reason: the synthetic path arms and collects inside its own injection. CDP
  // dispatches from the service worker, so the same measurements have to bracket
  // it from two injections — and they must bracket it, not trail it.
  it('brackets the dispatch with the observation pair', async () => {
    stubTopLevelElement()
    const order: string[] = []
    const script = chromeMock.scripting.executeScript.getMockImplementation()!
    chromeMock.scripting.executeScript.mockImplementation(async (injection: Record<string, unknown>) => {
      if (injection.func === armObservation) order.push('arm')
      if (injection.func === collectObservation) {
        order.push('collect')
        return [{ frameId: 0, result: { focusChanged: true, valueChanged: false, domMutated: true } }]
      }
      return script(injection)
    })
    chromeMock.debugger.sendCommand.mockImplementation(async () => {
      order.push('dispatch')
      return {}
    })

    const r = await runClick({ target: '#btn', real: true }) as { success: boolean; observed?: string }
    expect(r.success).toBe(true)
    expect(order.indexOf('arm')).toBeLessThan(order.indexOf('dispatch'))
    expect(order.lastIndexOf('dispatch')).toBeLessThan(order.indexOf('collect'))
    // Reason: same vocabulary as the synthetic path, minus the two fields CDP
    // structurally cannot measure.
    expect(r.observed).toBe('dom mutated, focus moved')
  })

  it('reports no observable change rather than omitting the field', async () => {
    stubTopLevelElement()
    const script = chromeMock.scripting.executeScript.getMockImplementation()!
    chromeMock.scripting.executeScript.mockImplementation(async (injection: Record<string, unknown>) => {
      if (injection.func === collectObservation) {
        return [{ frameId: 0, result: { focusChanged: false, valueChanged: false, domMutated: false } }]
      }
      return script(injection)
    })

    const r = await runClick({ target: '#btn', real: true }) as { observed?: string }
    expect(r.observed).toBe('no observable change')
  })

  // Reason: an all-false observation is indistinguishable from a genuinely
  // inert click, and that distinction is the whole input to the escalate-or-not
  // decision. If the arm never took, say nothing.
  it('omits observed entirely when the arm failed', async () => {
    stubTopLevelElement()
    const script = chromeMock.scripting.executeScript.getMockImplementation()!
    let collectCalls = 0
    chromeMock.scripting.executeScript.mockImplementation(async (injection: Record<string, unknown>) => {
      if (injection.func === armObservation) throw new Error('frame gone')
      if (injection.func === collectObservation) { collectCalls++ }
      return script(injection)
    })

    const r = await runClick({ target: '#btn', real: true }) as { success: boolean; observed?: string }
    expect(r.success).toBe(true)
    expect(r.observed).toBeUndefined()
    expect(collectCalls).toBe(0)
  })

  it('refuses an unrendered target before attaching the debugger', async () => {
    stubTopLevelElement()
    chromeMock.scripting.executeScript.mockImplementation(async (injection: Record<string, unknown>) => {
      const args = injection.args as unknown[] | undefined
      if (args?.[1] === 'getElementInfo') {
        return [{
          frameId: 0,
          result: {
            success: true,
            boundingRect: { x: 40, y: 60, width: 100, height: 20 },
            probe: { ...VISIBLE_PROBE, rendered: false, display: 'none' },
          },
        }]
      }
      return [{ frameId: 0, result: { success: true } }]
    })

    const r = await runClick({ target: '#hidden', real: true })
    expect(r.success).toBe(false)
    expect(r.error).toContain('display:none')
    expect(chromeMock.debugger.attach).not.toHaveBeenCalled()
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('leads with a mouseMoved trajectory before the press', async () => {
    stubTopLevelElement()
    await runClick({ target: '#btn', real: true })
    const events = mouseEvents()
    expect(events[0].type).toBe('mouseMoved')
    expect(events.filter(e => e.type === 'mouseMoved').length).toBeGreaterThan(1)
    // Reason: real mouseMoved is the only way to drive genuine CSS :hover, which
    // is the main thing the synthetic path cannot do.
    expect(events.findIndex(e => e.type === 'mousePressed')).toBeGreaterThan(0)
  })

  it('ends the trajectory exactly on the element centre', async () => {
    stubTopLevelElement()
    await runClick({ target: '#btn', real: true })
    const events = mouseEvents()
    const lastMove = [...events].reverse().find(e => e.type === 'mouseMoved')!
    const press = events.find(e => e.type === 'mousePressed')!
    expect(press).toMatchObject({ x: 90, y: 70 })
    expect(lastMove).toMatchObject({ x: 90, y: 70 })
  })

  it('carries the buttons bitmask, held only between press and release', async () => {
    stubTopLevelElement()
    await runClick({ target: '#btn', real: true })
    const events = mouseEvents()
    expect(events.find(e => e.type === 'mousePressed')!.buttons).toBe(1)
    expect(events.find(e => e.type === 'mouseReleased')!.buttons).toBe(0)
    expect(events.filter(e => e.type === 'mouseMoved').every(e => e.buttons === 0)).toBe(true)
  })

  it('sends two press/release rounds with rising clickCount for a double click', async () => {
    stubTopLevelElement()
    await runClick({ target: '#btn', real: true, doubleClick: true })
    const clicks = mouseEvents().filter(e => e.type !== 'mouseMoved')
    expect(clicks.map(e => [e.type, e.clickCount])).toEqual([
      ['mousePressed', 1], ['mouseReleased', 1],
      ['mousePressed', 2], ['mouseReleased', 2],
    ])
  })

  it('asks for debugger consent before attaching', async () => {
    stubTopLevelElement('consent-ask.test')
    await runClick({ target: '#btn', real: true })
    const consent = chromeMock.runtime.sendMessage.mock.calls
      .find(c => (c[0] as { type?: string })?.type === 'request-debugger-consent')
    expect(consent).toBeDefined()
    expect(consent![0]).toMatchObject({ hostname: 'consent-ask.test' })
  })

  it('does not attach or dispatch when consent is declined', async () => {
    stubTopLevelElement('consent-deny.test')
    chromeMock.runtime.sendMessage.mockResolvedValue({ granted: false })
    const result = await runClick({ target: '#btn', real: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('declined')
    expect(chromeMock.debugger.attach).not.toHaveBeenCalled()
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('caches consent per hostname so a second click does not re-prompt', async () => {
    stubTopLevelElement('consent-cache.test')
    await runClick({ target: '#btn', real: true })
    chromeMock.runtime.sendMessage.mockClear()
    await runClick({ target: '#btn', real: true })
    const reprompt = chromeMock.runtime.sendMessage.mock.calls
      .find(c => (c[0] as { type?: string })?.type === 'request-debugger-consent')
    expect(reprompt).toBeUndefined()
  })

  it('attaches and detaches when it does not already own the debugger', async () => {
    stubTopLevelElement()
    await runClick({ target: '#btn', real: true })
    expect(chromeMock.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3')
    // Reason: detaching a debugger we do own would tear down Pro mode's
    // console/network capture, so ownership decides both ends.
    expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 1 })
  })

  it('reuses an existing Pro-mode debugger without attaching or detaching', async () => {
    stubTopLevelElement()
    const attached = vi.spyOn(debugSession, 'isAttached').mockReturnValue(true)
    const owner = vi.spyOn(debugSession, 'getTabId').mockReturnValue(1)
    try {
      const result = await runClick({ target: '#btn', real: true })
      expect(result.success).toBe(true)
      // Reason: Chrome refuses a second attach on the same tab, and detaching in
      // finally would kill Pro mode's console/network capture.
      expect(chromeMock.debugger.attach).not.toHaveBeenCalled()
      expect(chromeMock.debugger.detach).not.toHaveBeenCalled()
      expect(mouseEvents().some(e => e.type === 'mousePressed')).toBe(true)
    } finally {
      attached.mockRestore()
      owner.mockRestore()
    }
  })

  it('still attaches when the debugger is held for a different tab', async () => {
    stubTopLevelElement()
    const attached = vi.spyOn(debugSession, 'isAttached').mockReturnValue(true)
    const owner = vi.spyOn(debugSession, 'getTabId').mockReturnValue(99)
    try {
      await runClick({ target: '#btn', real: true })
      expect(chromeMock.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3')
      expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 1 })
    } finally {
      attached.mockRestore()
      owner.mockRestore()
    }
  })

  it('reports a dispatch failure instead of throwing', async () => {
    stubTopLevelElement()
    chromeMock.debugger.sendCommand.mockRejectedValue(new Error('target closed'))
    const result = await runClick({ target: '#btn', real: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain('target closed')
    expect(chromeMock.debugger.detach).toHaveBeenCalled()
  })
})
