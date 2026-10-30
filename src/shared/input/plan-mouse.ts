// Reason: the mouse planner. Emits a fully explicit, ordered event timeline so
// the interpreter never has to infer anything — which is what makes the whole
// ordering contract assertable without a DOM.

import { distance, pathDuration, samplePath } from './easing'
import {
  BUTTONS_NONE,
  MAX_PLAN_MS,
  buttonsFor,
  modifiersFrom,
  resolveTiming,
  type InputPlan,
  type MouseButton,
  type MouseState,
  type Modifiers,
  type Pt,
  type RenderCue,
  type Step,
  type Timing,
  type Waypoint,
} from './types'

export interface ClickOptions {
  button?: MouseButton
  doubleClick?: boolean
  // Reason: drives the arrow→hand cue. The planner already knows whether the
  // resolved target is interactive, so the pointer never needs to hit-test per
  // frame — that per-frame inference is exactly what makes Codex's in-app
  // browser cursor flicker between hand and arrow (openai/codex#27268).
  interactive?: boolean
  timing?: Partial<Timing>
  modifiers?: Partial<Modifiers>
}

let planSeq = 0

// Reason: Date.now() would make plans non-deterministic and unsnapshotable. A
// monotonic counter is enough — ids only need to be unique within a session.
function nextPlanId(kind: string): string {
  planSeq += 1
  return `${kind}-${planSeq}`
}

export function resetPlanIds(): void {
  planSeq = 0
}

export function initialMouseState(viewport?: { w: number; h: number }): MouseState {
  return {
    x: viewport ? Math.round(viewport.w / 2) : 0,
    y: viewport ? Math.round(viewport.h / 2) : 0,
    buttons: BUTTONS_NONE,
    modifiers: modifiersFrom(),
    hoverPath: [],
    viewport: viewport ?? null,
    docId: null,
    updatedAt: 0,
  }
}

// Reason: until a session's persisted mouse state exists — or after the service
// worker dropped it — a trajectory still needs a plausible origin. Approaching
// from just up-left of the target reads as a pointer arriving, whereas defaulting
// to 0,0 would sweep across the whole viewport on every action.
export function approachPoint(to: Pt, offset = 64): Pt {
  return { x: Math.max(0, to.x - offset), y: Math.max(0, to.y - offset) }
}

interface Builder {
  steps: Step[]
  cues: RenderCue[]
  seq: number
}

function makeBuilder(): Builder {
  return { steps: [], cues: [], seq: 0 }
}

function push(b: Builder, step: Omit<Step, 'seq'>): void {
  b.steps.push({ ...step, seq: b.seq++ })
}

function moveSteps(
  b: Builder,
  waypoints: Waypoint[],
  buttons: number,
  modifiers: Modifiers,
  button: MouseButton,
): void {
  for (const w of waypoints) {
    push(b, {
      at: w.at,
      op: { kind: 'mouse', type: 'move', button, clickCount: 0 },
      point: { x: w.x, y: w.y },
      buttons,
      modifiers,
      recomputeHover: true,
    })
    b.cues.push({ at: w.at, kind: 'move', point: { x: w.x, y: w.y } })
  }
}

function finish(
  kind: string,
  b: Builder,
  from: Pt,
  to: Pt,
  waypoints: Waypoint[],
  state: MouseState,
  endOverrides: Partial<MouseState>,
  degraded?: InputPlan['degraded'],
): InputPlan {
  const durationMs = Math.min(
    MAX_PLAN_MS,
    b.steps.reduce((m, s) => Math.max(m, s.at), 0),
  )
  return {
    id: nextPlanId(kind),
    from,
    to,
    durationMs,
    waypoints,
    steps: b.steps,
    cues: b.cues,
    endState: {
      ...state,
      x: to.x,
      y: to.y,
      buttons: BUTTONS_NONE,
      updatedAt: state.updatedAt,
      ...endOverrides,
    },
    ...(degraded ? { degraded } : {}),
  }
}

function planTrajectory(
  b: Builder,
  state: MouseState,
  to: Pt,
  t: Timing,
  buttons: number,
  modifiers: Modifiers,
  button: MouseButton,
): { waypoints: Waypoint[]; endsAt: number } {
  const from: Pt = { x: state.x, y: state.y }
  const dist = distance(from, to)
  // Reason: an already-parked pointer still needs one move so the hit-test
  // chain gets sampled and hover fires — but it should not animate.
  if (dist < 1) {
    const at = 0
    push(b, {
      at,
      op: { kind: 'mouse', type: 'move', button, clickCount: 0 },
      point: to,
      buttons,
      modifiers,
      recomputeHover: true,
    })
    b.cues.push({ at, kind: 'move', point: to })
    return { waypoints: [{ at, x: to.x, y: to.y }], endsAt: at }
  }

  const totalMs = t.instant ? 0 : Math.min(t.totalMs, pathDuration(dist))
  const n = t.instant ? 1 : t.maxWaypoints
  const waypoints = samplePath(from, to, n, totalMs)
  moveSteps(b, waypoints, buttons, modifiers, button)
  return { waypoints, endsAt: waypoints[waypoints.length - 1].at }
}

export function planMove(state: MouseState, to: Pt, timing?: Partial<Timing>): InputPlan {
  const t = resolveTiming(timing)
  const b = makeBuilder()
  const modifiers = state.modifiers
  const { waypoints } = planTrajectory(b, state, to, t, state.buttons, modifiers, 0)
  return finish('move', b, { x: state.x, y: state.y }, to, waypoints, state, { buttons: state.buttons }, t.instant ? 'instant' : undefined)
}

export function planHover(state: MouseState, to: Pt, options?: { interactive?: boolean; timing?: Partial<Timing> }): InputPlan {
  const t = resolveTiming(options?.timing)
  const b = makeBuilder()
  const { waypoints, endsAt } = planTrajectory(b, state, to, t, state.buttons, state.modifiers, 0)
  b.cues.push({ at: endsAt, kind: 'shape', shape: options?.interactive ? 'hand' : 'arrow' })
  return finish('hover', b, { x: state.x, y: state.y }, to, waypoints, state, { buttons: state.buttons }, t.instant ? 'instant' : undefined)
}

export function planClick(state: MouseState, to: Pt, options?: ClickOptions): InputPlan {
  const t = resolveTiming(options?.timing)
  const button = options?.button ?? 0
  const modifiers = modifiersFrom({ ...state.modifiers, ...options?.modifiers })
  const held = buttonsFor(button)
  const b = makeBuilder()

  const { waypoints, endsAt } = planTrajectory(b, state, to, t, BUTTONS_NONE, modifiers, button)

  // Reason: switch the pointer shape shortly before the press so the user sees
  // intent, not a post-hoc report. Single deterministic switch, no flicker.
  const shapeAt = Math.max(0, endsAt - 40)
  b.cues.push({ at: shapeAt, kind: 'shape', shape: options?.interactive ? 'hand' : 'arrow' })

  let at = endsAt
  const rounds = options?.doubleClick ? 2 : 1
  for (let i = 1; i <= rounds; i++) {
    push(b, {
      at,
      op: { kind: 'mouse', type: 'down', button, clickCount: i },
      point: to,
      buttons: held,
      modifiers,
    })
    b.cues.push({ at, kind: 'press', point: to })

    // Reason: focus is the default action of mousedown, so it belongs between
    // down and up — not before the press and not after the click.
    if (i === 1) {
      push(b, { at, op: { kind: 'commit', type: 'focus' }, point: to, buttons: held, modifiers })
    }

    at += t.pressHoldMs
    push(b, {
      at,
      op: { kind: 'mouse', type: 'up', button, clickCount: i },
      point: to,
      buttons: BUTTONS_NONE,
      modifiers,
    })
    b.cues.push({ at, kind: 'release', point: to })

    push(b, {
      at,
      op: { kind: 'mouse', type: 'click', button, clickCount: i },
      point: to,
      buttons: BUTTONS_NONE,
      modifiers,
    })

    if (i < rounds) at += t.interClickMs
  }

  if (options?.doubleClick) {
    push(b, {
      at,
      op: { kind: 'mouse', type: 'dblclick', button, clickCount: 2 },
      point: to,
      buttons: BUTTONS_NONE,
      modifiers,
    })
  }

  return finish('click', b, { x: state.x, y: state.y }, to, waypoints, state, { modifiers }, t.instant ? 'instant' : undefined)
}
