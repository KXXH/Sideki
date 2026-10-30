import { describe, it, expect } from 'vitest'
import { formatSize, findCompactionCutoff, findArchiveCutoff, stepBudgetStage, dataUrlToLatin1 } from '../../src/shared/format'

describe('formatSize', () => {
  it('formats zero', () => expect(formatSize(0)).toBe('0 B'))
  it('formats bytes', () => expect(formatSize(512)).toBe('512 B'))
  it('formats KB', () => expect(formatSize(2048)).toBe('2.0 KB'))
  it('formats MB', () => expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB'))
})

describe('findCompactionCutoff', () => {
  it('returns -1 for empty array', () => {
    expect(findCompactionCutoff([])).toBe(-1)
  })

  it('returns -1 for single message', () => {
    expect(findCompactionCutoff(['user'])).toBe(-1)
  })

  it('returns -1 for one user turn (user + assistant)', () => {
    expect(findCompactionCutoff(['user', 'assistant'])).toBe(-1)
  })

  it('keeps last 1 turn when only 2 user turns exist', () => {
    // u a u a → cutoff at index 2 (last user), compress [0..2), keep [2..]
    const roles = ['user', 'assistant', 'user', 'assistant']
    expect(findCompactionCutoff(roles)).toBe(2)
  })

  it('returns -1 when only 1 message before last user turn', () => {
    // summary u a → cutoff=1, only 1 msg to compress → -1
    expect(findCompactionCutoff(['assistant', 'user', 'assistant'])).toBe(-1)
  })

  it('keeps last 3 turns when >= 4 user turns exist', () => {
    // u a u a u a u a → 4 user turns, cutoff at 3rd-from-end = index 2
    const roles = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']
    expect(findCompactionCutoff(roles)).toBe(2)
  })

  it('returns -1 with exactly 3 user turns (nothing before 3rd to compress)', () => {
    // u a u a u a → 3rd user from end is index 0 → cutoff=0 ≤ 1 → -1
    expect(findCompactionCutoff(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])).toBe(-1)
  })

  it('compresses when 4+ user turns with preceding content', () => {
    // a u a u a u a u a → summary + 4 user turns
    const roles = ['assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']
    // 3rd user from end is at index 3
    expect(findCompactionCutoff(roles)).toBe(3)
  })

  it('handles consecutive user messages', () => {
    // u u u a → 3 user msgs, 3rd from end is index 0 → -1
    expect(findCompactionCutoff(['user', 'user', 'user', 'assistant'])).toBe(-1)
  })

  it('handles tool messages between user turns', () => {
    // u a tool a u a tool a u a → 3 user turns
    const roles = ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant']
    // 3rd user from end is index 0 → -1
    expect(findCompactionCutoff(roles)).toBe(-1)
  })

  it('compresses prefix when many turns exist', () => {
    // a u a u a u a u a u a → summary + 5 user turns
    const roles = ['assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']
    // 3rd user from end is index 5
    expect(findCompactionCutoff(roles)).toBe(5)
  })
})

describe('findArchiveCutoff', () => {
  it('returns -1 for empty array', () => {
    expect(findArchiveCutoff([], 2)).toBe(-1)
  })

  it('returns -1 with fewer user turns than keepTurns — never archives the current turn', () => {
    // Single tool-heavy turn: the old prepareStep logic would have archived
    // the fresh results here; strict cutoff must refuse.
    expect(findArchiveCutoff(['user', 'assistant', 'assistant', 'assistant'], 2)).toBe(-1)
    expect(findArchiveCutoff(['user', 'assistant'], 2)).toBe(-1)
  })

  it('returns -1 when the keepTurns-th user turn is at index 0 (nothing precedes it)', () => {
    // u a u a → 2nd user from end is index 0
    expect(findArchiveCutoff(['user', 'assistant', 'user', 'assistant'], 2)).toBe(-1)
  })

  it('protects the last keepTurns user turns', () => {
    // u a a u a u a → 2nd user from end is index 3; archive [0..3)
    expect(findArchiveCutoff(['user', 'assistant', 'assistant', 'user', 'assistant', 'user', 'assistant'], 2)).toBe(3)
  })

  it('respects a different keepTurns value', () => {
    const roles = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']
    expect(findArchiveCutoff(roles, 3)).toBe(2)
    expect(findArchiveCutoff(roles, 1)).toBe(6)
  })

  it('ignores a leading summary message', () => {
    // summary(a) u a u a → 2nd user from end at index 1; archive [0..1)
    // (summary has no tool parts so archiving is a no-op there anyway)
    expect(findArchiveCutoff(['assistant', 'user', 'assistant', 'user', 'assistant'], 2)).toBe(1)
  })
})

describe('stepBudgetStage', () => {
  it('fires warn exactly at the 80% crossing', () => {
    expect(stepBudgetStage(80, 100)).toBe('warn')
    expect(stepBudgetStage(79, 100)).toBeNull()
    expect(stepBudgetStage(81, 100)).toBeNull()
  })

  it('fires final exactly at the 95% crossing', () => {
    expect(stepBudgetStage(95, 100)).toBe('final')
    expect(stepBudgetStage(94, 100)).toBeNull()
    expect(stepBudgetStage(96, 100)).toBeNull()
  })

  it('each stage fires exactly once across a full run', () => {
    const fired: string[] = []
    for (let s = 0; s < 100; s++) {
      const stage = stepBudgetStage(s, 100)
      if (stage) fired.push(`${s}:${stage}`)
    }
    expect(fired).toEqual(['80:warn', '95:final'])
  })

  it('uses ceil for non-round limits', () => {
    // maxSteps=30 → warn at ceil(24)=24, final at ceil(28.5)=29
    expect(stepBudgetStage(24, 30)).toBe('warn')
    expect(stepBudgetStage(29, 30)).toBe('final')
  })

  it('collapses to a single warn when thresholds coincide (tiny limits)', () => {
    // maxSteps=2 → warnAt=2, finalAt=2 → only warn fires
    expect(stepBudgetStage(2, 2)).toBe('warn')
    // maxSteps=5 → warnAt=4, finalAt=5; step 5 never runs (stopWhen), warn still fires at 4
    expect(stepBudgetStage(4, 5)).toBe('warn')
    expect(stepBudgetStage(5, 5)).toBe('final')
  })
})

describe('dataUrlToLatin1', () => {
  it('unpacks base64 payload to latin1 bytes', () => {
    // bytes: 0x89 0x00 0xff 0xe4 — full-range sample
    const b64 = btoa(String.fromCharCode(0x89, 0x00, 0xff, 0xe4))
    const out = dataUrlToLatin1(`data:image/jpeg;base64,${b64}`)
    expect(out).not.toBeNull()
    expect([...out!].map(c => c.charCodeAt(0))).toEqual([0x89, 0x00, 0xff, 0xe4])
  })

  it('returns null for non-base64 data URLs', () => {
    expect(dataUrlToLatin1('data:text/plain,hello')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(dataUrlToLatin1('not a data url')).toBeNull()
    expect(dataUrlToLatin1('data:image/png;base64,@@invalid@@')).toBeNull()
    expect(dataUrlToLatin1('')).toBeNull()
  })
})
