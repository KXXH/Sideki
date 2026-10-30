import { useCallback, useEffect, useState } from 'react'

// Reason: key the announcement to its content, so ordinary patch updates do not
// repeatedly interrupt users with an unchanged walkthrough.
export const UPDATE_INTRO_ID = '2026-10-chat-refresh-palette'
export const UPDATE_INTRO_SEEN_KEY = 'sidekick_update_intro_seen'

export const ONBOARDING_SEEN_KEY = 'sidekick_onboarding_seen'
export type IntroKind = 'onboarding' | 'update'

export function introKind(stored: Record<string, unknown>): IntroKind {
  return stored.sidekick_config || stored[UPDATE_INTRO_SEEN_KEY] || stored[ONBOARDING_SEEN_KEY] || (Array.isArray(stored.sidekick_session_index) && stored.sidekick_session_index.length) || (Array.isArray(stored.sidekick_sessions) && stored.sidekick_sessions.length) ? 'update' : 'onboarding'
}

export function useUpdateIntro() {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<IntroKind>('update')
  useEffect(() => {
    let active = true
    chrome.storage.local.get([UPDATE_INTRO_SEEN_KEY, ONBOARDING_SEEN_KEY, 'sidekick_config', 'sidekick_session_index']).then(async value => {
      // Reason: legacy message bodies can be large; inspect them only when config and index cannot identify an existing installation.
      if (introKind(value) === 'onboarding') Object.assign(value, await chrome.storage.local.get('sidekick_sessions'))
      if (active) { setKind(introKind(value)); if (value[UPDATE_INTRO_SEEN_KEY] !== UPDATE_INTRO_ID) setOpen(true) }
    }).catch(() => {})
    return () => { active = false }
  }, [])

  const dismiss = useCallback(() => {
    setOpen(false)
    void chrome.storage.local.set({ [UPDATE_INTRO_SEEN_KEY]: UPDATE_INTRO_ID, ...(kind === 'onboarding' ? { [ONBOARDING_SEEN_KEY]: true } : {}) }).catch(() => {})
  }, [kind])
  const replay = useCallback(() => { setKind('update'); setOpen(true) }, [])
  const replayOnboarding = useCallback(() => { setKind('onboarding'); setOpen(true) }, [])
  return { open, kind, dismiss, replay, replayOnboarding }
}
