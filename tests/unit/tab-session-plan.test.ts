import { describe, it, expect } from 'vitest'
import { planTabSessionSwitch } from '../../src/sidepanel/utils/tab-session-plan'

const always = () => true

describe('planTabSessionSwitch', () => {
  it('same-tab re-fire never remembers or switches (new-session regression)', () => {
    // Mirror mode: creating a session changes the session list and re-fires
    // the effect while the user stays on the same tab. The remembered session
    // for that tab must NOT re-activate and revert the fresh session.
    const plan = planTabSessionSwitch({
      prevTabId: 7,
      nextTabId: 7,
      currentSessionId: 'new-session',
      rememberedSessionId: 'old-session',
      contextLocked: false,
      idle: true,
      hasSession: always,
    })
    expect(plan).toBeNull()
  })

  it('tab change remembers the left tab and switches to the remembered session', () => {
    const plan = planTabSessionSwitch({
      prevTabId: 1,
      nextTabId: 2,
      currentSessionId: 'a',
      rememberedSessionId: 'b',
      contextLocked: false,
      idle: true,
      hasSession: always,
    })
    expect(plan).toEqual({
      remember: { tabId: 1, sessionId: 'a' },
      switchTo: 'b',
    })
  })

  it('busy turn defers the switch but still remembers the left tab', () => {
    const plan = planTabSessionSwitch({
      prevTabId: 1,
      nextTabId: 2,
      currentSessionId: 'a',
      rememberedSessionId: 'b',
      contextLocked: false,
      idle: false,
      hasSession: always,
    })
    expect(plan).toEqual({ remember: { tabId: 1, sessionId: 'a' }, switchTo: null })
  })

  it('context lock disables both remembering and switching', () => {
    const plan = planTabSessionSwitch({
      prevTabId: 1,
      nextTabId: 2,
      currentSessionId: 'a',
      rememberedSessionId: 'b',
      contextLocked: true,
      idle: true,
      hasSession: always,
    })
    expect(plan).toEqual({ remember: null, switchTo: null })
  })

  it('remembered session outside the selectable set is not activated', () => {
    const plan = planTabSessionSwitch({
      prevTabId: 1,
      nextTabId: 2,
      currentSessionId: 'a',
      rememberedSessionId: 'deleted-or-cross-mode',
      contextLocked: false,
      idle: true,
      hasSession: () => false,
    })
    expect(plan?.switchTo).toBeNull()
    expect(plan?.remember).toEqual({ tabId: 1, sessionId: 'a' })
  })

  it('remembered session equal to current is a no-op switch', () => {
    const plan = planTabSessionSwitch({
      prevTabId: 1,
      nextTabId: 2,
      currentSessionId: 'a',
      rememberedSessionId: 'a',
      contextLocked: false,
      idle: true,
      hasSession: always,
    })
    expect(plan?.switchTo).toBeNull()
  })

  it('first tab sighting (no prev) skips remembering', () => {
    const plan = planTabSessionSwitch({
      prevTabId: null,
      nextTabId: 2,
      currentSessionId: 'a',
      rememberedSessionId: 'b',
      contextLocked: false,
      idle: true,
      hasSession: always,
    })
    expect(plan).toEqual({ remember: null, switchTo: 'b' })
  })

  it('no remembered session for the entered tab means stay', () => {
    const plan = planTabSessionSwitch({
      prevTabId: 1,
      nextTabId: 2,
      currentSessionId: 'a',
      rememberedSessionId: undefined,
      contextLocked: false,
      idle: true,
      hasSession: always,
    })
    expect(plan?.switchTo).toBeNull()
  })
})
