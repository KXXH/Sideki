// Reason: this module is the contract between the SW-side pure planner and the
// in-page interpreter. Everything here must be structured-clone safe (plain
// objects, no class instances, no functions) because plans cross the
// chrome.scripting.executeScript args boundary. Nothing in src/shared/input may
// import chrome or DOM types — that is what keeps the planner unit-testable in
// the project's `environment: 'node'` vitest setup.

export interface Pt { x: number; y: number }

export interface Modifiers {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, shift: false, alt: false, meta: false }

// Reason: MouseEvent.buttons bitmask, which CDP Input.dispatchMouseEvent also
// consumes verbatim — one representation serves both backends.
export const BUTTONS_NONE = 0
export const BUTTONS_LEFT = 1
export const BUTTONS_RIGHT = 2
export const BUTTONS_MIDDLE = 4

export type MouseButton = 0 | 1 | 2

export interface Waypoint {
  at: number
  x: number
  y: number
}

export type EditOp = 'setValue' | 'insertChar' | 'insertText' | 'deleteAll'

export type StepOp =
  // Reason: click/dblclick are explicit rather than derived by the interpreter.
  // A dumb interpreter means the entire event ordering lives in pure planner
  // output, so it can be asserted without a DOM.
  | { kind: 'mouse'; type: 'move' | 'down' | 'up' | 'click' | 'dblclick'; button: MouseButton; clickCount: number }
  | { kind: 'key'; type: 'down' | 'up'; key: string; code: string; keyCode: number }
  | { kind: 'edit'; op: EditOp; data: string; inputType: string }
  | { kind: 'commit'; type: 'focus' | 'blur' | 'change' }

export interface Step {
  at: number
  seq: number
  op: StepOp
  // Reason: frame-local viewport coordinates. Absent for key/edit/commit steps.
  point?: Pt
  buttons: number
  modifiers: Modifiers
  // Reason: tells the interpreter to re-hit-test at this point and emit the
  // out/leave/over/enter diff. Only the planner knows when the chain can change.
  recomputeHover?: true
}

export type CueKind = 'move' | 'press' | 'release' | 'shape'
export type CueShape = 'arrow' | 'hand'

export interface RenderCue {
  at: number
  kind: CueKind
  point?: Pt
  shape?: CueShape
}

export interface MouseState {
  x: number
  y: number
  buttons: number
  modifiers: Modifiers
  // Reason: diagnostic replay only. The authoritative hover chain is always
  // re-sampled in-page via elementsFromPoint — a persisted chain goes stale the
  // moment the DOM changes.
  hoverPath: string[]
  viewport: { w: number; h: number } | null
  // Reason: lets the interpreter detect an SPA soft navigation the SW never saw
  // and discard a stale start position instead of animating from nowhere.
  docId: string | null
  updatedAt: number
}

export type DegradeReason = 'longText' | 'instant' | 'noPath'

export interface InputPlan {
  id: string
  from: Pt
  to: Pt
  durationMs: number
  waypoints: Waypoint[]
  steps: Step[]
  cues: RenderCue[]
  endState: MouseState
  degraded?: DegradeReason
}

export interface Timing {
  totalMs: number
  maxWaypoints: number
  pressHoldMs: number
  interClickMs: number
  perCharMs: number
  instant: boolean
}

export const DEFAULT_TIMING: Timing = {
  totalMs: 320,
  maxWaypoints: 12,
  pressHoldMs: 60,
  interClickMs: 90,
  perCharMs: 18,
  instant: false,
}

// Reason: hard ceiling asserted by unit tests. execScript's deadline is 30s;
// staying an order of magnitude below it means a plan can never be the reason a
// tool call times out.
export const MAX_PLAN_MS = 3_000

export interface Observation {
  defaultPrevented: boolean
  focusChanged: boolean
  valueChanged: boolean
  domMutated: boolean
  urlChanged: boolean
}

export function resolveTiming(over?: Partial<Timing>): Timing {
  const t = { ...DEFAULT_TIMING, ...over }
  if (t.instant) {
    return { ...t, totalMs: 0, maxWaypoints: 1, pressHoldMs: 0, interClickMs: 0, perCharMs: 0 }
  }
  return t
}

export function modifiersFrom(over?: Partial<Modifiers>): Modifiers {
  return { ...NO_MODIFIERS, ...over }
}

// Reason: CDP encodes modifiers as a bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8),
// unrelated to MouseEvent.buttons. Keeping the conversion here means both
// backends read the same Modifiers object.
export function cdpModifiers(m: Modifiers): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0)
}

export function buttonsFor(button: MouseButton): number {
  if (button === 1) return BUTTONS_MIDDLE
  if (button === 2) return BUTTONS_RIGHT
  return BUTTONS_LEFT
}
