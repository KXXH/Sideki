// Reason: cue → CSS mapping kept pure so the pointer's visual behaviour is
// assertable without a DOM. This is the executable spec, not the production
// path: the interpreter and the iframe animator are injected functions and
// cannot import it, so each reimplements the same mapping inline. Changing the
// mapping means changing all three — the tests over this module are what pin
// the intended behaviour.

import type { CueShape, Pt, RenderCue } from './types'

export interface PointerVisual {
  transform: string
  shape: CueShape
  pressed: boolean
}

export const POINTER_SHAPES: readonly CueShape[] = ['arrow', 'hand']

export function pointerTransform(p: Pt): string {
  // Reason: translate3d keeps the pointer on the compositor instead of forcing
  // layout on every waypoint.
  return `translate3d(${p.x}px, ${p.y}px, 0)`
}

export function applyCue(prev: PointerVisual, cue: RenderCue): PointerVisual {
  switch (cue.kind) {
    case 'move':
      return cue.point ? { ...prev, transform: pointerTransform(cue.point) } : prev
    case 'shape':
      return cue.shape ? { ...prev, shape: cue.shape } : prev
    case 'press':
      return { ...prev, pressed: true, ...(cue.point ? { transform: pointerTransform(cue.point) } : {}) }
    case 'release':
      return { ...prev, pressed: false }
  }
}

export function initialVisual(at: Pt): PointerVisual {
  return { transform: pointerTransform(at), shape: 'arrow', pressed: false }
}

// Reason: replaying the whole cue list is how a test pins the end state without
// stepping a timeline.
export function reduceCues(start: Pt, cues: readonly RenderCue[]): PointerVisual {
  return cues.reduce(applyCue, initialVisual(start))
}
