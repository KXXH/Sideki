// Reason: keyboard shares MouseState with the mouse planner rather than owning
// its own state object — `buttons` and `modifiers` must live together or
// Ctrl+click cannot be expressed at all.

import { clamp } from './easing'
import {
  MAX_PLAN_MS,
  modifiersFrom,
  resolveTiming,
  type InputPlan,
  type Modifiers,
  type MouseState,
  type Step,
  type Timing,
} from './types'

// Reason: legacy libraries still read keyCode/which, so the planner has to
// carry them. Only the keys the keypress tool advertises need entries; anything
// else falls back to a single-character mapping.
const KEY_CODES: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32 },
}

// Reason: beyond this length, per-character fidelity costs more than it buys —
// no UI meaningfully distinguishes the 300th synthetic keystroke, but the user
// waits for every one of them.
export const LONG_TEXT_THRESHOLD = 200

export function keyDescriptor(key: string): { code: string; keyCode: number } {
  const known = KEY_CODES[key]
  if (known) return known
  if (key.length === 1) {
    const upper = key.toUpperCase()
    const isAlpha = upper >= 'A' && upper <= 'Z'
    const isDigit = key >= '0' && key <= '9'
    return {
      code: isAlpha ? `Key${upper}` : isDigit ? `Digit${key}` : '',
      keyCode: isAlpha || isDigit ? upper.charCodeAt(0) : 0,
    }
  }
  return { code: key, keyCode: 0 }
}

export function perCharDelay(len: number, t: Timing): number {
  if (t.instant || len === 0) return 0
  return Math.round(clamp(600 / len, 8, 35))
}

interface Builder {
  steps: Step[]
  seq: number
  at: number
}

function push(b: Builder, op: Step['op'], modifiers: Modifiers): void {
  b.steps.push({ at: b.at, seq: b.seq++, op, buttons: 0, modifiers })
}

function finish(id: string, b: Builder, state: MouseState, modifiers: Modifiers, degraded?: InputPlan['degraded']): InputPlan {
  const durationMs = Math.min(MAX_PLAN_MS, b.steps.reduce((m, s) => Math.max(m, s.at), 0))
  return {
    id,
    from: { x: state.x, y: state.y },
    to: { x: state.x, y: state.y },
    durationMs,
    waypoints: [],
    steps: b.steps,
    cues: [],
    endState: { ...state, modifiers },
    ...(degraded ? { degraded } : {}),
  }
}

// Reason: the deleteAll sequence is deliberately longer than a bare value=''.
// The selection plus the cancelable beforeinput are what let controlled
// components and character counters observe the clear instead of silently
// disagreeing with the DOM afterwards.
function pushDeleteAll(b: Builder, modifiers: Modifiers): void {
  const bs = keyDescriptor('Backspace')
  push(b, { kind: 'key', type: 'down', key: 'Backspace', code: bs.code, keyCode: bs.keyCode }, modifiers)
  push(b, { kind: 'edit', op: 'deleteAll', data: '', inputType: 'deleteContentBackward' }, modifiers)
  push(b, { kind: 'key', type: 'up', key: 'Backspace', code: bs.code, keyCode: bs.keyCode }, modifiers)
}

export interface TypeOptions {
  clear?: boolean
  contentEditable?: boolean
  timing?: Partial<Timing>
  modifiers?: Partial<Modifiers>
}

export function planType(state: MouseState, text: string, options?: TypeOptions): InputPlan {
  const t = resolveTiming(options?.timing)
  const modifiers = modifiersFrom({ ...state.modifiers, ...options?.modifiers })
  const b: Builder = { steps: [], seq: 0, at: 0 }

  push(b, { kind: 'commit', type: 'focus' }, modifiers)
  if (options?.clear) pushDeleteAll(b, modifiers)

  const chars = Array.from(text)
  const long = chars.length > LONG_TEXT_THRESHOLD
  const step = perCharDelay(chars.length, t)

  if (options?.contentEditable) {
    // Reason: execCommand('insertText') is the only synthetic path that enters
    // the real beforeinput pipeline, which Lexical / ProseMirror / Quill all
    // depend on. A textContent write is the fallback, not the primary.
    push(b, { kind: 'edit', op: 'insertText', data: text, inputType: 'insertText' }, modifiers)
  } else if (long) {
    // Reason: keep the first and last characters fully faithful so keydown
    // handlers and blur-time validators still see real keystrokes bracketing
    // the write, then collapse the middle into one setValue.
    emitChar(b, chars[0], modifiers)
    push(b, { kind: 'edit', op: 'setValue', data: text, inputType: 'insertText' }, modifiers)
    emitChar(b, chars[chars.length - 1], modifiers)
  } else {
    for (const ch of chars) {
      b.at += step
      emitChar(b, ch, modifiers)
    }
  }

  push(b, { kind: 'commit', type: 'change' }, modifiers)
  return finish('type', b, state, modifiers, long && !options?.contentEditable ? 'longText' : t.instant ? 'instant' : undefined)
}

function emitChar(b: Builder, ch: string, modifiers: Modifiers): void {
  const d = keyDescriptor(ch)
  push(b, { kind: 'key', type: 'down', key: ch, code: d.code, keyCode: d.keyCode }, modifiers)
  // Reason: insertChar carries the cancelable beforeinput. If the page calls
  // preventDefault the interpreter must skip the write for this character only,
  // exactly as a real keystroke would behave.
  push(b, { kind: 'edit', op: 'insertChar', data: ch, inputType: 'insertText' }, modifiers)
  push(b, { kind: 'key', type: 'up', key: ch, code: d.code, keyCode: d.keyCode }, modifiers)
}

export function planKeypress(state: MouseState, key: string, mods?: Partial<Modifiers>): InputPlan {
  const modifiers = modifiersFrom({ ...state.modifiers, ...mods })
  const b: Builder = { steps: [], seq: 0, at: 0 }
  const d = keyDescriptor(key)
  push(b, { kind: 'key', type: 'down', key, code: d.code, keyCode: d.keyCode }, modifiers)
  push(b, { kind: 'key', type: 'up', key, code: d.code, keyCode: d.keyCode }, modifiers)
  return finish('keypress', b, state, modifiers)
}
