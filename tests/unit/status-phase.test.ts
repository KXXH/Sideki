import { describe, it, expect } from 'vitest'
import {
  advanceLabel, derivePhase, draw, PHASE_POOLS,
  type LabelState, type PhaseInput, type StatusPhase, type TrailingKind,
} from '../../src/sidepanel/status-phase'

const phase = (over: Partial<PhaseInput> = {}) =>
  derivePhase({ status: 'ready', preparing: false, dispatching: false, trailing: 'none', ...over })

const streaming = (trailing: TrailingKind) => phase({ status: 'streaming', trailing })

describe('derivePhase — turn chain', () => {
  it('building outranks every status: the craton build is not a request yet', () => {
    expect(phase({ preparing: true })).toBe('building')
    expect(phase({ preparing: true, status: 'submitted' })).toBe('building')
    expect(phase({ preparing: true, status: 'streaming', trailing: 'text' })).toBe('building')
  })

  it('submitted → requesting (waiting for the first token)', () => {
    expect(phase({ status: 'submitted' })).toBe('requesting')
  })

  it('a send in flight is requesting before the SDK ever sees it', () => {
    // Reason: the attachment mirror and the handoff run while status is still
    // 'ready' — without this the panel would render an idle turn.
    expect(phase({ dispatching: true })).toBe('requesting')
    expect(phase({ dispatching: true, status: 'submitted' })).toBe('requesting')
  })

  it('building outranks dispatching: a dispatch that needs the craton says so', () => {
    expect(phase({ dispatching: true, preparing: true })).toBe('building')
  })

  it('streaming splits on what the message is ending on', () => {
    expect(streaming('text')).toBe('writing')
    expect(streaming('tool')).toBe('working')
    expect(streaming('reasoning')).toBe('working')
    // Reason: a stream that has produced no renderable part yet is still work,
    // not writing.
    expect(streaming('none')).toBe('working')
  })

  it('ready and error both fall back to idle — the error bar owns the error signal', () => {
    expect(phase({ status: 'ready', trailing: 'text' })).toBe('idle')
    expect(phase({ status: 'error' })).toBe('idle')
    expect(phase({ status: 'error', preparing: true })).toBe('building')
  })
})

describe('PHASE_POOLS', () => {
  const speaking = ['building', 'requesting', 'working'] as const

  it('every speaking phase has wording of its own', () => {
    for (const p of speaking) expect(PHASE_POOLS[p].length).toBeGreaterThan(0)
  })

  it('idle and writing are wordless: writing is signaled by the text itself', () => {
    expect(PHASE_POOLS.idle).toEqual([])
    expect(PHASE_POOLS.writing).toEqual([])
  })

  it('building and requesting are single-fact pools, not rotation material', () => {
    expect(PHASE_POOLS.building).toHaveLength(1)
    expect(PHASE_POOLS.requesting).toHaveLength(1)
  })

  it('working rotation has no duplicates (a redraw must be able to move on)', () => {
    expect(new Set(PHASE_POOLS.working).size).toBe(PHASE_POOLS.working.length)
  })
})

describe('draw — rotation inside one pool', () => {
  it('a single-entry pool yields that entry', () => {
    expect(draw(['only'], 'only')).toBe('only')
    expect(draw(['only'], 'something else')).toBe('only')
  })

  it('never repeats the sentence already on screen', () => {
    const pool = PHASE_POOLS.working
    for (const prev of pool) expect(draw(pool, prev)).not.toBe(prev)
  })

  it('still answers when the pool is only the previous sentence', () => {
    expect(draw(['a'], 'a')).toBe('a')
  })
})

describe('advanceLabel — phase boundary', () => {
  const state = (phase: StatusPhase, label: string): LabelState => ({ phase, label })

  it('the same phase is a no-op: re-renders must not redraw', () => {
    const speaking = state('working', '正在赋能...')
    expect(advanceLabel(speaking, 'working')).toBe(speaking)

    const wordless = state('idle', '')
    expect(advanceLabel(wordless, 'idle')).toBe(wordless)
  })

  it('a phase switch redraws from the new pool', () => {
    const next = advanceLabel(state('idle', ''), 'working')
    expect(next.phase).toBe('working')
    expect(PHASE_POOLS.working).toContain(next.label)

    const single = advanceLabel(state('idle', ''), 'building')
    expect(single.label).toBe(PHASE_POOLS.building[0])
  })

  it('the switch never reuses the sentence the previous phase was showing', () => {
    for (const prev of PHASE_POOLS.working) {
      expect(advanceLabel(state('requesting', prev), 'working').label).not.toBe(prev)
    }
  })

  it('an empty pool freezes: the sentence survives into writing and idle', () => {
    expect(advanceLabel(state('working', '正在形成闭环...'), 'writing')).toEqual({
      phase: 'writing',
      label: '正在形成闭环...',
    })
    expect(advanceLabel(state('working', '正在形成闭环...'), 'idle')).toEqual({
      phase: 'idle',
      label: '正在形成闭环...',
    })
  })

  it('a frozen pool still moves on once a speaking phase comes back', () => {
    const frozen = advanceLabel(state('working', '正在赋能...'), 'writing')
    const resumed = advanceLabel(frozen, 'requesting')
    expect(resumed.label).toBe(PHASE_POOLS.requesting[0])
  })
})
