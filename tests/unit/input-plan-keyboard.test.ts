import { describe, it, expect } from 'vitest'
import { planType, planKeypress, keyDescriptor, perCharDelay, LONG_TEXT_THRESHOLD } from '../../src/shared/input/plan-keyboard'
import { initialMouseState } from '../../src/shared/input/plan-mouse'
import { DEFAULT_TIMING, resolveTiming, type InputPlan } from '../../src/shared/input/types'

// Reason: the old type implementation did `el.value += text` and fired input +
// change. That bypasses React's value tracker, so controlled inputs never saw
// an onChange, and no keydown/beforeinput meant autocomplete and IME-adjacent
// components stayed inert. These tests pin the sequence that replaces it.

const st = () => initialMouseState({ w: 800, h: 600 })

function ops(plan: InputPlan): string[] {
  return plan.steps.map(s => {
    const op = s.op
    if (op.kind === 'key') return `key:${op.type}:${op.key}`
    if (op.kind === 'edit') return `edit:${op.op}`
    return `commit:${op.type}`
  })
}

describe('planType per-character fidelity', () => {
  it('brackets every character write with keydown and keyup', () => {
    const plan = planType(st(), 'ab')
    expect(ops(plan)).toEqual([
      'commit:focus',
      'key:down:a', 'edit:insertChar', 'key:up:a',
      'key:down:b', 'edit:insertChar', 'key:up:b',
      'commit:change',
    ])
  })

  it('focuses before typing and commits change at the end', () => {
    const plan = planType(st(), 'x')
    expect(ops(plan)[0]).toBe('commit:focus')
    expect(ops(plan).at(-1)).toBe('commit:change')
  })

  it('carries insertText as the inputType so beforeinput is meaningful', () => {
    const plan = planType(st(), 'q')
    const edit = plan.steps.find(s => s.op.kind === 'edit')!
    expect(edit.op).toMatchObject({ op: 'insertChar', data: 'q', inputType: 'insertText' })
  })

  it('splits astral characters by code point, not by UTF-16 unit', () => {
    const plan = planType(st(), '😀中')
    const chars = plan.steps.filter(s => s.op.kind === 'edit').map(s => (s.op as { data: string }).data)
    expect(chars).toEqual(['😀', '中'])
  })

  it('advances timestamps between characters', () => {
    const plan = planType(st(), 'abc')
    const downs = plan.steps.filter(s => s.op.kind === 'key' && s.op.type === 'down')
    expect(downs[1].at).toBeGreaterThan(downs[0].at)
    expect(downs[2].at).toBeGreaterThan(downs[1].at)
  })
})

describe('planType clear', () => {
  it('deletes with a real Backspace and a cancelable delete intent', () => {
    const plan = planType(st(), 'z', { clear: true })
    expect(ops(plan).slice(0, 5)).toEqual([
      'commit:focus',
      'key:down:Backspace', 'edit:deleteAll', 'key:up:Backspace',
      'key:down:z',
    ])
  })

  it('tags the delete with deleteContentBackward', () => {
    const plan = planType(st(), 'z', { clear: true })
    const del = plan.steps.find(s => s.op.kind === 'edit' && s.op.op === 'deleteAll')!
    expect(del.op).toMatchObject({ inputType: 'deleteContentBackward' })
  })

  it('skips the delete sequence when clear is not requested', () => {
    expect(ops(planType(st(), 'z'))).not.toContain('edit:deleteAll')
  })
})

describe('planType long-text degradation', () => {
  it('stays per-character at the threshold', () => {
    const plan = planType(st(), 'a'.repeat(LONG_TEXT_THRESHOLD))
    expect(plan.degraded).toBeUndefined()
    expect(plan.steps.filter(s => s.op.kind === 'edit')).toHaveLength(LONG_TEXT_THRESHOLD)
  })

  it('collapses the middle past the threshold but keeps the ends faithful', () => {
    const text = 'a'.repeat(LONG_TEXT_THRESHOLD) + 'Z'
    const plan = planType(st(), text)
    expect(plan.degraded).toBe('longText')
    expect(ops(plan)).toEqual([
      'commit:focus',
      'key:down:a', 'edit:insertChar', 'key:up:a',
      'edit:setValue',
      'key:down:Z', 'edit:insertChar', 'key:up:Z',
      'commit:change',
    ])
  })

  it('writes the whole string in the collapsed setValue', () => {
    const text = 'b'.repeat(LONG_TEXT_THRESHOLD + 5)
    const plan = planType(st(), text)
    const set = plan.steps.find(s => s.op.kind === 'edit' && s.op.op === 'setValue')!
    expect((set.op as { data: string }).data).toBe(text)
  })
})

describe('planType contenteditable', () => {
  it('uses a single insertText so the beforeinput pipeline is entered once', () => {
    const plan = planType(st(), 'hello world', { contentEditable: true })
    expect(ops(plan)).toEqual(['commit:focus', 'edit:insertText', 'commit:change'])
  })

  it('does not degrade on long text because it never went per-character', () => {
    const plan = planType(st(), 'c'.repeat(500), { contentEditable: true })
    expect(plan.degraded).toBeUndefined()
  })
})

describe('planKeypress', () => {
  it('emits only keydown and keyup', () => {
    expect(ops(planKeypress(st(), 'Enter'))).toEqual(['key:down:Enter', 'key:up:Enter'])
  })

  it('carries modifiers so Ctrl+Enter is expressible', () => {
    const plan = planKeypress(st(), 'Enter', { ctrl: true, shift: true })
    expect(plan.steps.every(s => s.modifiers.ctrl && s.modifiers.shift)).toBe(true)
    expect(plan.endState.modifiers).toMatchObject({ ctrl: true, shift: true, alt: false, meta: false })
  })
})

describe('keyDescriptor', () => {
  it('maps the named keys the keypress tool advertises', () => {
    expect(keyDescriptor('Enter')).toEqual({ code: 'Enter', keyCode: 13 })
    expect(keyDescriptor('Escape')).toEqual({ code: 'Escape', keyCode: 27 })
    expect(keyDescriptor('ArrowDown')).toEqual({ code: 'ArrowDown', keyCode: 40 })
    expect(keyDescriptor('Backspace')).toEqual({ code: 'Backspace', keyCode: 8 })
  })

  it('derives codes for letters and digits so legacy keyCode readers work', () => {
    expect(keyDescriptor('a')).toEqual({ code: 'KeyA', keyCode: 65 })
    expect(keyDescriptor('7')).toEqual({ code: 'Digit7', keyCode: 55 })
  })

  it('maps space to its physical code', () => {
    expect(keyDescriptor(' ')).toEqual({ code: 'Space', keyCode: 32 })
  })

  it('degrades gracefully for characters with no physical key', () => {
    expect(keyDescriptor('中')).toEqual({ code: '', keyCode: 0 })
  })
})

describe('perCharDelay', () => {
  it('is zero in instant mode', () => {
    expect(perCharDelay(10, resolveTiming({ instant: true }))).toBe(0)
  })

  it('slows for short strings and speeds up for long ones, within bounds', () => {
    expect(perCharDelay(5, DEFAULT_TIMING)).toBe(35)
    expect(perCharDelay(200, DEFAULT_TIMING)).toBe(8)
    expect(perCharDelay(40, DEFAULT_TIMING)).toBe(15)
  })
})
