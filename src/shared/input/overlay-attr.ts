// Reason: the project has no general mechanism for hiding its own injected
// nodes from its own perception paths. Overlays currently dodge the DOM snapshot
// and getPageContent only because those root at document.body while overlays
// mount on documentElement — an implicit and fragile guarantee. These constants
// make the exclusion explicit and shared by every path that needs it.

export const SK_OVERLAY_ATTR = 'data-sidekick-overlay'

// Reason: the picker predates SK_OVERLAY_ATTR and marks itself differently, and
// the lock indicator identifies by id. Every consumer needs the full set, so it
// lives here rather than being re-listed at each call site.
export const OVERLAY_SELECTORS: readonly string[] = [
  `[${SK_OVERLAY_ATTR}]`,
  '[data-sidekick-picker]',
  '#__sidekick_lock_indicator__',
  '#__sidekick_ai_pointer__',
]

export const OVERLAY_SELECTOR = OVERLAY_SELECTORS.join(', ')

export const AI_POINTER_ID = '__sidekick_ai_pointer__'

// Reason: 2147483647 is taken by the page lock indicator and 2147483646 by the
// consent highlight. The pointer sits below both — being covered by a highlight
// ring is acceptable, covering the consent prompt's text is not.
export const AI_POINTER_Z_INDEX = 2147483645
