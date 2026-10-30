// Reason: pure decision core for the tab→session auto-switch effect in
// useSidekickChat. The hook owns side effects (flushSave / clearQueue /
// select-session cmd); the rules live here so the guard logic is unit-testable.

export interface TabSessionPlan {
  // Remember this session for the tab being left.
  remember: { tabId: number; sessionId: string } | null
  // Activate this session for the entered tab; null = stay on current.
  switchTo: string | null
}

export function planTabSessionSwitch(args: {
  prevTabId: number | null
  nextTabId: number
  currentSessionId: string
  rememberedSessionId: string | undefined
  contextLocked: boolean
  idle: boolean
  hasSession: (id: string) => boolean
}): TabSessionPlan | null {
  // Reason: the effect also re-fires without a tab change (session-list
  // updates after new-session, lock toggles, mode flips). Only a real tab
  // change may remember or switch — otherwise the remembered session for the
  // tab the user is STILL on immediately re-activates and reverts whatever
  // session they just selected or created.
  if (args.prevTabId === args.nextTabId) return null

  const remember = !args.contextLocked && args.prevTabId !== null && args.currentSessionId
    ? { tabId: args.prevTabId, sessionId: args.currentSessionId }
    : null

  let switchTo: string | null = null
  if (
    !args.contextLocked
    && args.idle
    && args.rememberedSessionId
    && args.rememberedSessionId !== args.currentSessionId
    && args.hasSession(args.rememberedSessionId)
  ) {
    switchTo = args.rememberedSessionId
  }
  return { remember, switchTo }
}
