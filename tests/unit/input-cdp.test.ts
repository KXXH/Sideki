import { describe, it, expect, beforeEach } from 'vitest'
import { toCdpCommands } from '../../src/shared/input/cdp'
import { planClick, initialMouseState, resetPlanIds } from '../../src/shared/input/plan-mouse'
import { planType, planKeypress } from '../../src/shared/input/plan-keyboard'
import { cdpModifiers, modifiersFrom } from '../../src/shared/input/types'

// Reason: the previous real-click path sent exactly two commands (mousePressed,
// mouseReleased) with no mouseMoved, no buttons bitmask, no press/release gap,
// and a single pair for double clicks. Projecting a plan makes the whole wire
// sequence a pure value, so it can be asserted here rather than spot-checked
// through a chrome.debugger mock.

const st = () => initialMouseState({ w: 1000, h: 800 })

beforeEach(() => resetPlanIds())

function wire(plan: ReturnType<typeof planClick>) {
  return toCdpCommands(plan).map(c => [c.params.type, c.params.button, c.params.buttons, c.params.clickCount])
}

describe('toCdpCommands for a click', () => {
  it('leads with mouseMoved before the press', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 100, y: 100 }, { timing: { instant: true } }))
    expect(cmds.map(c => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('drops click and dblclick because CDP derives them from press/release', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 10, y: 10 }, { doubleClick: true, timing: { instant: true } }))
    expect(cmds.map(c => c.params.type)).toEqual([
      'mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased',
    ])
  })

  it('sends both rounds of a double click with rising clickCount', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 10, y: 10 }, { doubleClick: true, timing: { instant: true } }))
    expect(cmds.map(c => c.params.clickCount)).toEqual([0, 1, 1, 2, 2])
  })

  it('carries the buttons bitmask, held only between press and release', () => {
    expect(wire(planClick(st(), { x: 5, y: 5 }, { timing: { instant: true } }))).toEqual([
      ['mouseMoved', 'none', 0, 0],
      ['mousePressed', 'left', 1, 1],
      ['mouseReleased', 'left', 0, 1],
    ])
  })

  it('names the right button for a secondary click', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 5, y: 5 }, { button: 2, timing: { instant: true } }))
    expect(cmds[1].params).toMatchObject({ type: 'mousePressed', button: 'right', buttons: 2 })
  })

  it('spaces press and release by the hold time', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 5, y: 5 }))
    const release = cmds.find(c => c.params.type === 'mouseReleased')!
    expect(release.delayBeforeMs).toBe(60)
  })

  it('emits the whole trajectory as mouseMoved with cumulative delays', () => {
    const cmds = toCdpCommands(planClick(st({}), { x: 600, y: 400 }))
    const moves = cmds.filter(c => c.params.type === 'mouseMoved')
    expect(moves).toHaveLength(12)
    expect(moves.every(c => c.params.pointerType === 'mouse')).toBe(true)
    // Reason: delays are deltas, so they must all be non-negative and sum to the
    // trajectory duration.
    expect(cmds.every(c => c.delayBeforeMs >= 0)).toBe(true)
  })

  it('lands the press on the exact target coordinates', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 421, y: 133 }))
    const press = cmds.find(c => c.params.type === 'mousePressed')!
    expect(press.params).toMatchObject({ x: 421, y: 133 })
  })

  it('encodes modifiers as the CDP bitmask, not as MouseEvent flags', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 5, y: 5 }, { modifiers: { ctrl: true, shift: true }, timing: { instant: true } }))
    expect(cmds[1].params.modifiers).toBe(2 | 8)
  })

  it('omits focus commits because a real press produces focus itself', () => {
    const cmds = toCdpCommands(planClick(st(), { x: 5, y: 5 }, { timing: { instant: true } }))
    expect(cmds).toHaveLength(3)
  })
})

describe('toCdpCommands for keyboard', () => {
  it('maps keypress to keyDown and keyUp with virtual key codes', () => {
    const cmds = toCdpCommands(planKeypress(st(), 'Enter'))
    expect(cmds).toHaveLength(2)
    expect(cmds[0].params).toMatchObject({
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    })
    expect(cmds[1].params).toMatchObject({ type: 'keyUp', key: 'Enter' })
  })

  it('supplies text only for printable single characters', () => {
    expect(toCdpCommands(planKeypress(st(), 'a'))[0].params.text).toBe('a')
    expect(toCdpCommands(planKeypress(st(), 'Escape'))[0].params.text).toBeUndefined()
  })

  it('lets the browser produce text for per-character typing', () => {
    // Reason: insertChar is skipped because the keyDown already yields the
    // character; inserting it again would double every keystroke.
    const cmds = toCdpCommands(planType(st(), 'hi'))
    expect(cmds.map(c => c.params.type)).toEqual(['keyDown', 'keyUp', 'keyDown', 'keyUp'])
  })

  it('uses insertText for the collapsed long-text write', () => {
    const text = 'a'.repeat(250)
    const cmds = toCdpCommands(planType(st(), text))
    const insert = cmds.find(c => c.method === 'Input.insertText')!
    expect(insert.params).toEqual({ text })
  })

  it('uses insertText for contenteditable', () => {
    const cmds = toCdpCommands(planType(st(), 'body text', { contentEditable: true }))
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ method: 'Input.insertText', params: { text: 'body text' } })
  })
})

describe('cdpModifiers', () => {
  it('uses the CDP bit order Alt=1 Ctrl=2 Meta=4 Shift=8', () => {
    expect(cdpModifiers(modifiersFrom())).toBe(0)
    expect(cdpModifiers(modifiersFrom({ alt: true }))).toBe(1)
    expect(cdpModifiers(modifiersFrom({ ctrl: true }))).toBe(2)
    expect(cdpModifiers(modifiersFrom({ meta: true }))).toBe(4)
    expect(cdpModifiers(modifiersFrom({ shift: true }))).toBe(8)
    expect(cdpModifiers({ alt: true, ctrl: true, meta: true, shift: true })).toBe(15)
  })
})
