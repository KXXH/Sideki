// Reason: v1 deliberately does not auto-escalate to CDP. A silent debugger
// attach would pop Chrome's "is debugging this browser" banner as a side effect
// the user never approved, and the signals below are too weak to justify it —
// a correct click on an inert element also produces no observable change. So
// the observation is reported to the model and the escalation decision is left
// to it.

import type { Observation } from './types'

export const NOTHING_OBSERVED = 'no observable change'

export function describeObservation(o: Observation): string {
  const parts: string[] = []
  if (o.urlChanged) parts.push('url changed')
  if (o.domMutated) parts.push('dom mutated')
  if (o.valueChanged) parts.push('value changed')
  if (o.focusChanged) parts.push('focus moved')
  if (o.defaultPrevented) parts.push('default prevented')
  return parts.length ? parts.join(', ') : NOTHING_OBSERVED
}

// Reason: mirrors the exact wording resolveAndExecInner produces, because
// resolveAndExecWithFrame keys its allFrames retry off this substring. The
// plan path must stay byte-compatible with that implicit contract or iframe
// targets silently stop being retried.
export const NO_ELEMENT_PREFIX = 'No element found'

export function noElementError(target: string): string {
  return `No element found matching "${target}". Try a CSS selector or different text.`
}

export function shouldRetryAllFrames(error: string | undefined): boolean {
  return !!error && error.includes(NO_ELEMENT_PREFIX)
}
