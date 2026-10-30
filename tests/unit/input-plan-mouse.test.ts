import { describe, it, expect, beforeEach } from 'vitest'
import { planClick, planHover, planMove, initialMouseState, resetPlanIds } from '../../src/shared/input/plan-mouse'
import { MAX_PLAN_MS, BUTTONS_LEFT, BUTTONS_NONE, type InputPlan } from '../../src/shared/input/types'

// Reason: the old implementation called el.click(), which dispatches a single
// click event and nothing else — so anything listening on mousedown/pointerdown
// never fired. These tests pin the full ordering that replaces it.

function types(plan: InputPlan): string[] {
  return plan.steps.map(s => (s.op.kind === 'mouse' ? s.op.type : `${s.op.kind}:${'type' in s.op ? s.op.type : ''}`))
}

function state(over: Partial<ReturnType<typeof initialMouseState>> = {}) {
  return { ...initialMouseState({ w: 1000, h: 800 }), ...over }
}

beforeEach(() => resetPlanIds())

describe('planClick ordering', () => {
  it('moves, presses, focuses, releases, then clicks', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 100, y: 100 })
    const tail = types(plan).slice(-4)
    expect(tail).toEqual(['down', 'commit:focus', 'up', 'click'])
  })

  it('puts focus between down and up, not before the press', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 10, y: 10 })
    const seq = types(plan)
    expect(seq.indexOf('commit:focus')).toBeGreaterThan(seq.indexOf('down'))
    expect(seq.indexOf('commit:focus')).toBeLessThan(seq.indexOf('up'))
  })

  it('marks every move step for hover recomputation and no press step', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 300, y: 300 })
    for (const s of plan.steps) {
      if (s.op.kind === 'mouse' && s.op.type === 'move') expect(s.recomputeHover).toBe(true)
      else expect(s.recomputeHover).toBeUndefined()
    }
  })

  it('holds the left button down only between press and release', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 50, y: 50 })
    const down = plan.steps.find(s => s.op.kind === 'mouse' && s.op.type === 'down')!
    const up = plan.steps.find(s => s.op.kind === 'mouse' && s.op.type === 'up')!
    expect(down.buttons).toBe(BUTTONS_LEFT)
    expect(up.buttons).toBe(BUTTONS_NONE)
    expect(plan.endState.buttons).toBe(BUTTONS_NONE)
  })

  it('lands the press exactly on the requested point', () => {
    const to = { x: 337, y: 211 }
    const plan = planClick(state({ x: 12, y: 9 }), to)
    const down = plan.steps.find(s => s.op.kind === 'mouse' && s.op.type === 'down')!
    const lastMove = [...plan.steps].reverse().find(s => s.op.kind === 'mouse' && s.op.type === 'move')!
    expect(down.point).toEqual(to)
    // Reason: no terminal overshoot — the last move must agree with the press.
    expect(lastMove.point).toEqual(to)
    expect(plan.endState).toMatchObject({ x: to.x, y: to.y })
  })

  it('emits two press/release rounds with rising clickCount for a double click', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 20, y: 20 }, { doubleClick: true })
    const mouse = plan.steps.filter(s => s.op.kind === 'mouse' && s.op.type !== 'move')
    expect(mouse.map(s => [(s.op as { type: string }).type, (s.op as { clickCount: number }).clickCount])).toEqual([
      ['down', 1], ['up', 1], ['click', 1],
      ['down', 2], ['up', 2], ['click', 2],
      ['dblclick', 2],
    ])
  })

  it('separates the two rounds by the inter-click gap', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 20, y: 20 }, { doubleClick: true })
    const downs = plan.steps.filter(s => s.op.kind === 'mouse' && s.op.type === 'down')
    expect(downs[1].at - downs[0].at).toBe(60 + 90)
  })

  it('switches the pointer to a hand before the press for interactive targets', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 400, y: 400 }, { interactive: true })
    const shape = plan.cues.filter(c => c.kind === 'shape')
    expect(shape).toHaveLength(1)
    expect(shape[0].shape).toBe('hand')
    const press = plan.cues.find(c => c.kind === 'press')!
    // Reason: the shape must change before the press so the cursor telegraphs
    // intent rather than reporting it after the fact.
    expect(shape[0].at).toBeLessThan(press.at)
  })

  it('keeps an arrow for non-interactive targets', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 400, y: 400 })
    expect(plan.cues.find(c => c.kind === 'shape')?.shape).toBe('arrow')
  })

  it('carries modifiers onto every step so Ctrl+click is expressible', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 30, y: 30 }, { modifiers: { ctrl: true } })
    expect(plan.steps.every(s => s.modifiers.ctrl)).toBe(true)
    expect(plan.endState.modifiers.ctrl).toBe(true)
  })
})

describe('trajectory', () => {
  it('samples up to maxWaypoints moves', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 500, y: 500 })
    const moves = plan.steps.filter(s => s.op.kind === 'mouse' && s.op.type === 'move')
    expect(moves).toHaveLength(12)
  })

  it('collapses to a single move with zero delays in instant mode', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 500, y: 500 }, { timing: { instant: true } })
    const moves = plan.steps.filter(s => s.op.kind === 'mouse' && s.op.type === 'move')
    expect(moves).toHaveLength(1)
    expect(plan.durationMs).toBe(0)
    expect(plan.steps.every(s => s.at === 0)).toBe(true)
    expect(plan.degraded).toBe('instant')
  })

  it('still emits one move when the pointer is already parked on the target', () => {
    // Reason: the hit-test chain must be sampled so hover fires even with no travel.
    const plan = planClick(state({ x: 100, y: 100 }), { x: 100, y: 100 })
    const moves = plan.steps.filter(s => s.op.kind === 'mouse' && s.op.type === 'move')
    expect(moves).toHaveLength(1)
    expect(moves[0].at).toBe(0)
  })

  it('takes longer for longer travel but never exceeds the ceiling', () => {
    const near = planClick(state({ x: 0, y: 0 }), { x: 30, y: 0 })
    const far = planClick(state({ x: 0, y: 0 }), { x: 900, y: 700 })
    expect(far.durationMs).toBeGreaterThan(near.durationMs)
    expect(far.durationMs).toBeLessThanOrEqual(MAX_PLAN_MS)
  })

  it('never exceeds MAX_PLAN_MS for any plan', () => {
    for (const plan of [
      planMove(state(), { x: 999, y: 999 }),
      planHover(state(), { x: 1, y: 1 }),
      planClick(state(), { x: 800, y: 600 }, { doubleClick: true }),
    ]) {
      expect(plan.durationMs).toBeLessThanOrEqual(MAX_PLAN_MS)
    }
  })

  it('monotonically increases step timestamps', () => {
    const plan = planClick(state({ x: 0, y: 0 }), { x: 600, y: 400 }, { doubleClick: true })
    for (let i = 1; i < plan.steps.length; i++) {
      expect(plan.steps[i].at).toBeGreaterThanOrEqual(plan.steps[i - 1].at)
      expect(plan.steps[i].seq).toBeGreaterThan(plan.steps[i - 1].seq)
    }
  })
})

describe('planMove / planHover', () => {
  it('planMove emits only moves', () => {
    const plan = planMove(state({ x: 0, y: 0 }), { x: 200, y: 100 })
    expect(plan.steps.every(s => s.op.kind === 'mouse' && s.op.type === 'move')).toBe(true)
  })

  it('planHover ends with a shape cue matching interactivity', () => {
    expect(planHover(state(), { x: 5, y: 5 }, { interactive: true }).cues.at(-1)).toMatchObject({ kind: 'shape', shape: 'hand' })
    expect(planHover(state(), { x: 5, y: 5 }).cues.at(-1)).toMatchObject({ kind: 'shape', shape: 'arrow' })
  })

  it('preserves held buttons across a move so a drag stays pressed', () => {
    const plan = planMove(state({ x: 0, y: 0, buttons: BUTTONS_LEFT }), { x: 40, y: 40 })
    expect(plan.steps.every(s => s.buttons === BUTTONS_LEFT)).toBe(true)
    expect(plan.endState.buttons).toBe(BUTTONS_LEFT)
  })
})

describe('initialMouseState', () => {
  it('parks at the viewport centre when the size is known', () => {
    expect(initialMouseState({ w: 1024, h: 768 })).toMatchObject({ x: 512, y: 384 })
  })

  it('never carries a stale hover chain', () => {
    expect(initialMouseState({ w: 10, h: 10 }).hoverPath).toEqual([])
  })
})
