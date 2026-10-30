// Reason: the CDP projection of a plan. Pure, so the entire wire sequence for a
// click can be asserted in a unit test instead of only spot-checking a single
// sendCommand call.

import { cdpModifiers, type InputPlan, type MouseButton, type Step } from './types'

export interface CdpCommand {
  method: string
  params: Record<string, unknown>
  delayBeforeMs: number
}

const BUTTON_NAMES: Record<MouseButton, string> = { 0: 'left', 1: 'middle', 2: 'right' }

function mouseCommand(step: Step, type: string, pressed: boolean): CdpCommand | null {
  if (!step.point) return null
  const op = step.op
  if (op.kind !== 'mouse') return null
  return {
    method: 'Input.dispatchMouseEvent',
    params: {
      type,
      x: step.point.x,
      y: step.point.y,
      // Reason: CDP wants 'none' for a bare move; naming a button on a move
      // makes Chrome treat it as a drag.
      button: pressed ? BUTTON_NAMES[op.button] : type === 'mouseMoved' && step.buttons === 0 ? 'none' : BUTTON_NAMES[op.button],
      buttons: step.buttons,
      clickCount: op.clickCount,
      modifiers: cdpModifiers(step.modifiers),
      pointerType: 'mouse',
    },
    delayBeforeMs: 0,
  }
}

function commandFor(step: Step): CdpCommand | null {
  const op = step.op
  if (op.kind === 'mouse') {
    // Reason: CDP derives click and dblclick from the press/release pair. Sending
    // them explicitly would double-fire, so the projection drops them.
    if (op.type === 'click' || op.type === 'dblclick') return null
    if (op.type === 'move') return mouseCommand(step, 'mouseMoved', false)
    if (op.type === 'down') return mouseCommand(step, 'mousePressed', true)
    return mouseCommand(step, 'mouseReleased', true)
  }

  if (op.kind === 'key') {
    return {
      method: 'Input.dispatchKeyEvent',
      params: {
        type: op.type === 'down' ? 'keyDown' : 'keyUp',
        key: op.key,
        code: op.code,
        windowsVirtualKeyCode: op.keyCode,
        nativeVirtualKeyCode: op.keyCode,
        text: op.key.length === 1 ? op.key : undefined,
        modifiers: cdpModifiers(step.modifiers),
      },
      delayBeforeMs: 0,
    }
  }

  if (op.kind === 'edit') {
    // Reason: the browser's own key handling already produced the text for
    // insertChar, so only the collapsed writes need an explicit insert.
    if (op.op === 'insertChar') return null
    if (op.op === 'deleteAll') return null
    return {
      method: 'Input.insertText',
      params: { text: op.data },
      delayBeforeMs: 0,
    }
  }

  // Reason: focus/blur/change are default actions of real input events, so the
  // CDP path gets them for free and must not synthesize them.
  return null
}

export function toCdpCommands(plan: InputPlan): CdpCommand[] {
  const out: CdpCommand[] = []
  let prevAt = 0
  for (const step of plan.steps) {
    const cmd = commandFor(step)
    if (!cmd) continue
    out.push({ ...cmd, delayBeforeMs: Math.max(0, step.at - prevAt) })
    prevAt = step.at
  }
  return out
}
