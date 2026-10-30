import { describe, it, expect, beforeEach } from 'vitest'
import {
  stateKey, getMouseState, setMouseState, resetMouseState,
  resetSessionMouseState, resetTabMouseState,
  STATE_TTL_MS, __resetInputState, __inputStateSize,
} from '../../src/background/input-state'
import { initialMouseState, type MouseState } from '../../src/shared/input'

// Reason: the mouse position is deliberately held in a plain module Map rather
// than chrome.storage — it is aesthetic continuity, not correctness. What that
// buys has to be paid for with disciplined invalidation, which is what these
// tests pin: the key must isolate tabs, and every way a stored position can go
// wrong (age, replaced document, closed tab, released turn, tab switch) must
// drop it rather than animate from coordinates that no longer mean anything.

function state(over: Partial<MouseState> = {}): MouseState {
  return { ...initialMouseState(), x: 100, y: 200, updatedAt: 1_000, ...over }
}

describe('input state keying', () => {
  beforeEach(() => __resetInputState())

  it('separates tabs within one session', () => {
    // Reason: a session can move between tabs and each tab has its own viewport,
    // so sharing a key would carry tab A's coordinates into tab B.
    expect(stateKey('s1', 1)).not.toBe(stateKey('s1', 2))
    setMouseState('s1', 1, state({ x: 10 }))
    setMouseState('s1', 2, state({ x: 20 }))
    expect(getMouseState('s1', 1, null, 1_000)?.x).toBe(10)
    expect(getMouseState('s1', 2, null, 1_000)?.x).toBe(20)
  })

  it('separates sessions within one tab', () => {
    setMouseState('s1', 1, state({ x: 10 }))
    setMouseState('s2', 1, state({ x: 20 }))
    expect(getMouseState('s1', 1, null, 1_000)?.x).toBe(10)
    expect(getMouseState('s2', 1, null, 1_000)?.x).toBe(20)
  })

  it('returns null for a key that was never written', () => {
    expect(getMouseState('nope', 9, null)).toBeNull()
  })
})

describe('input state invalidation', () => {
  beforeEach(() => __resetInputState())

  it('round-trips a fresh position', () => {
    setMouseState('s1', 1, state())
    expect(getMouseState('s1', 1, null, 1_000)).toMatchObject({ x: 100, y: 200 })
  })

  it('drops a position older than the ttl', () => {
    setMouseState('s1', 1, state({ updatedAt: 0 }))
    expect(getMouseState('s1', 1, null, STATE_TTL_MS + 1)).toBeNull()
    expect(__inputStateSize()).toBe(0)
  })

  it('keeps a position exactly at the ttl boundary', () => {
    setMouseState('s1', 1, state({ updatedAt: 0 }))
    expect(getMouseState('s1', 1, null, STATE_TTL_MS)).not.toBeNull()
  })

  it('drops a position when the document fingerprint changed', () => {
    // Reason: an SPA soft navigation replaces the document with no event the
    // service worker sees — the page-side fingerprint is the only witness.
    setMouseState('s1', 1, state({ docId: 'https://a/|A' }))
    expect(getMouseState('s1', 1, 'https://a/|B', 1_000)).toBeNull()
    expect(__inputStateSize()).toBe(0)
  })

  it('keeps a position when the fingerprint matches', () => {
    setMouseState('s1', 1, state({ docId: 'https://a/|A' }))
    expect(getMouseState('s1', 1, 'https://a/|A', 1_000)).not.toBeNull()
  })

  it('keeps a position when either side has no fingerprint', () => {
    // Reason: an unknown fingerprint is not evidence of a change, and discarding
    // on absence would make the fallback the common case.
    setMouseState('s1', 1, state({ docId: null }))
    expect(getMouseState('s1', 1, 'https://a/|A', 1_000)).not.toBeNull()
    setMouseState('s2', 1, state({ docId: 'https://a/|A' }))
    expect(getMouseState('s2', 1, null, 1_000)).not.toBeNull()
  })
})

describe('input state resets', () => {
  beforeEach(() => {
    __resetInputState()
    setMouseState('s1', 1, state())
    setMouseState('s1', 2, state())
    setMouseState('s2', 1, state())
  })

  it('resets one session-tab pair', () => {
    resetMouseState('s1', 1)
    expect(getMouseState('s1', 1, null, 1_000)).toBeNull()
    expect(getMouseState('s1', 2, null, 1_000)).not.toBeNull()
    expect(getMouseState('s2', 1, null, 1_000)).not.toBeNull()
  })

  it('resets every tab of one session on turn release', () => {
    resetSessionMouseState('s1')
    expect(getMouseState('s1', 1, null, 1_000)).toBeNull()
    expect(getMouseState('s1', 2, null, 1_000)).toBeNull()
    expect(getMouseState('s2', 1, null, 1_000)).not.toBeNull()
  })

  it('resets every session of one tab when the tab closes', () => {
    resetTabMouseState(1)
    expect(getMouseState('s1', 1, null, 1_000)).toBeNull()
    expect(getMouseState('s2', 1, null, 1_000)).toBeNull()
    expect(getMouseState('s1', 2, null, 1_000)).not.toBeNull()
  })

  it('does not confuse a tab id that is a suffix of another', () => {
    // Reason: the reset walks keys by suffix, so tab 2 must not match tab 12.
    setMouseState('s1', 12, state())
    resetTabMouseState(2)
    expect(getMouseState('s1', 12, null, 1_000)).not.toBeNull()
    expect(getMouseState('s1', 2, null, 1_000)).toBeNull()
  })

  it('does not confuse a session id that is a prefix of another', () => {
    setMouseState('s1x', 1, state())
    resetSessionMouseState('s1')
    expect(getMouseState('s1x', 1, null, 1_000)).not.toBeNull()
  })
})
