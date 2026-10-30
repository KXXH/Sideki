import { describe, it, expect } from 'vitest'
import { samplePath, pathDuration, easeInOutQuad, clamp, distance } from '../../src/shared/input/easing'
import { reduceCues, applyCue, initialVisual, pointerTransform } from '../../src/shared/input/cues'
import { describeObservation, shouldRetryAllFrames, noElementError, NOTHING_OBSERVED } from '../../src/shared/input/observe'
import { OVERLAY_SELECTOR, SK_OVERLAY_ATTR, AI_POINTER_Z_INDEX } from '../../src/shared/input/overlay-attr'
import type { Observation } from '../../src/shared/input/types'

describe('samplePath', () => {
  it('always terminates exactly on the target', () => {
    const wp = samplePath({ x: 0, y: 0 }, { x: 333, y: 177 }, 12, 320)
    expect(wp.at(-1)).toEqual({ at: 320, x: 333, y: 177 })
  })

  it('produces one waypoint at the target for a zero duration', () => {
    expect(samplePath({ x: 0, y: 0 }, { x: 9, y: 9 }, 12, 0)).toEqual([{ at: 0, x: 9, y: 9 }])
  })

  it('produces the requested number of samples', () => {
    expect(samplePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 8, 200)).toHaveLength(8)
  })

  it('advances monotonically in time and never overshoots the axis', () => {
    const wp = samplePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 300)
    for (let i = 1; i < wp.length; i++) {
      expect(wp[i].at).toBeGreaterThan(wp[i - 1].at)
      expect(wp[i].x).toBeGreaterThanOrEqual(wp[i - 1].x)
      // Reason: no terminal overshoot — the eased curve must stay inside the span.
      expect(wp[i].x).toBeLessThanOrEqual(100)
    }
  })

  it('eases in and out rather than moving linearly', () => {
    const wp = samplePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 100)
    // Reason: ease-in-out lags a linear ramp early and leads it late. Sample i
    // sits at p = i/10, so index 1 is p=0.2 (linear would be 20) and index 7 is
    // p=0.8 (linear would be 80).
    expect(wp[1].x).toBeLessThan(20)
    expect(wp[7].x).toBeGreaterThan(80)
    // the curve is symmetric, so the midpoint lands exactly halfway
    expect(wp[4].x).toBe(50)
  })
})

describe('easeInOutQuad', () => {
  it('is pinned at both ends and symmetric at the middle', () => {
    expect(easeInOutQuad(0)).toBe(0)
    expect(easeInOutQuad(1)).toBe(1)
    expect(easeInOutQuad(0.5)).toBeCloseTo(0.5)
  })
})

describe('pathDuration', () => {
  it('floors at 160ms so short hops do not look like teleports', () => {
    expect(pathDuration(0)).toBe(160)
    expect(pathDuration(5)).toBe(162)
  })

  it('caps at 520ms so the agent never waits on decoration', () => {
    expect(pathDuration(10_000)).toBe(520)
  })

  it('scales with distance in between', () => {
    expect(pathDuration(400)).toBe(340)
  })
})

describe('clamp / distance', () => {
  it('clamps to both bounds', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(15, 0, 10)).toBe(10)
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('measures euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })
})

describe('cues', () => {
  it('uses translate3d so the pointer stays on the compositor', () => {
    expect(pointerTransform({ x: 12, y: 34 })).toBe('translate3d(12px, 34px, 0)')
  })

  it('starts as an unpressed arrow', () => {
    expect(initialVisual({ x: 0, y: 0 })).toEqual({
      transform: 'translate3d(0px, 0px, 0)', shape: 'arrow', pressed: false,
    })
  })

  it('moves, presses and releases in sequence', () => {
    const v = reduceCues({ x: 0, y: 0 }, [
      { at: 0, kind: 'move', point: { x: 50, y: 50 } },
      { at: 10, kind: 'shape', shape: 'hand' },
      { at: 20, kind: 'press', point: { x: 50, y: 50 } },
    ])
    expect(v).toEqual({ transform: 'translate3d(50px, 50px, 0)', shape: 'hand', pressed: true })
  })

  it('clears the pressed state on release', () => {
    const pressed = applyCue(initialVisual({ x: 0, y: 0 }), { at: 0, kind: 'press', point: { x: 1, y: 1 } })
    expect(applyCue(pressed, { at: 1, kind: 'release' }).pressed).toBe(false)
  })

  it('ignores a move cue with no point rather than jumping to the origin', () => {
    const start = initialVisual({ x: 7, y: 7 })
    expect(applyCue(start, { at: 0, kind: 'move' })).toEqual(start)
  })
})

describe('describeObservation', () => {
  const none: Observation = {
    defaultPrevented: false, focusChanged: false, valueChanged: false, domMutated: false, urlChanged: false,
  }

  it('says so when nothing happened', () => {
    expect(describeObservation(none)).toBe(NOTHING_OBSERVED)
  })

  it('leads with the strongest signal', () => {
    expect(describeObservation({ ...none, urlChanged: true, focusChanged: true })).toBe('url changed, focus moved')
  })

  it('reports a prevented default so the model can reconsider', () => {
    expect(describeObservation({ ...none, defaultPrevented: true })).toBe('default prevented')
  })
})

describe('shouldRetryAllFrames', () => {
  it('matches the wording resolveAndExecInner produces', () => {
    // Reason: resolveAndExecWithFrame keys its allFrames retry off this
    // substring, so the plan path must stay byte-compatible.
    expect(shouldRetryAllFrames(noElementError('Submit'))).toBe(true)
  })

  it('does not retry unrelated failures', () => {
    expect(shouldRetryAllFrames('Element is <div>, not a <select>')).toBe(false)
    expect(shouldRetryAllFrames('executeScript failed: frame removed')).toBe(false)
  })

  it('is false for a missing error', () => {
    expect(shouldRetryAllFrames(undefined)).toBe(false)
  })
})

describe('overlay exclusion constants', () => {
  it('covers every overlay the project injects', () => {
    expect(OVERLAY_SELECTOR).toContain(`[${SK_OVERLAY_ATTR}]`)
    expect(OVERLAY_SELECTOR).toContain('[data-sidekick-picker]')
    expect(OVERLAY_SELECTOR).toContain('#__sidekick_lock_indicator__')
    expect(OVERLAY_SELECTOR).toContain('#__sidekick_ai_pointer__')
  })

  it('sits below the lock indicator and the consent highlight', () => {
    expect(AI_POINTER_Z_INDEX).toBeLessThan(2147483646)
  })
})
