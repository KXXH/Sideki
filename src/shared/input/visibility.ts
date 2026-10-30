// Reason: the line drawn here is "can a real input event physically reach this
// element", not "would a human notice it". Those diverge, and conflating them
// breaks real pages: an opacity:0 input still hit-tests normally, and the
// sr-only pattern (a real checkbox at opacity 0 over a styled span, or a 1x1
// clipped box) is exactly the thing you are supposed to click. So opacity and
// tiny-but-nonzero geometry are reported and never blocked.

export type HiddenReason =
  | 'detached'
  | 'display'
  | 'visibility'
  | 'render'
  | 'size'
  | 'offscreen'

export interface RenderProbe {
  connected: boolean
  /** Element.checkVisibility with visibilityProperty + contentVisibilityAuto. */
  rendered: boolean
  display: string
  visibility: string
  opacity: number
  /** Measured after scrollIntoView, so an off-viewport rect means unreachable. */
  rect: { x: number; y: number; width: number; height: number }
  viewport: { w: number; h: number }
  /**
   * Whether rect was taken after a scrollIntoView. Without it, "outside the
   * viewport" only means below the fold, which is reachable and must not block.
   */
  scrolled: boolean
}

export function hiddenReason(p: RenderProbe): HiddenReason | null {
  if (!p.connected) return 'detached'
  // Reason: checkVisibility is the authority because it walks ancestors — an
  // element under a display:none parent still computes its own display as
  // specified, so computed style alone misses the most common case. The style
  // fields only attribute a cause to the answer.
  if (!p.rendered) {
    if (p.display === 'none') return 'display'
    if (p.visibility === 'hidden' || p.visibility === 'collapse') return 'visibility'
    return 'render'
  }
  if (p.rect.width <= 0 || p.rect.height <= 0) return 'size'
  if (!p.scrolled) return null
  const outside = p.rect.x + p.rect.width <= 0
    || p.rect.y + p.rect.height <= 0
    || p.rect.x >= p.viewport.w
    || p.rect.y >= p.viewport.h
  // Reason: the rect was taken after scrollIntoView, so this is not "below the
  // fold" — it is off-page for good, the left:-9999px school of hiding.
  return outside ? 'offscreen' : null
}

export function describeHidden(p: RenderProbe, reason: HiddenReason, target: string): string {
  const head = `Target "${target}" cannot receive input`
  // Reason: without the last resort this reads as a closed choice of two, and a
  // model that follows instructions will not invent a third path. el.click()
  // does no hit testing, so it still fires handlers on an unrendered element —
  // that is the whole reason the pre-engine implementation appeared to work
  // here. Deliberately framed as a last resort and conditioned on certainty:
  // revealing the element is almost always correct, and `js` costs a consent
  // prompt, so it cannot quietly become the first thing tried.
  const tail = 'Reveal it first (hover or click whatever opens it), then retry — or pick a different target.'
    + ' Last resort, if you are certain the handler is bound directly: `js` can call el.click() on it, which fires handlers without needing a real event.'
  switch (reason) {
    case 'detached':
      // Reason: no escape hint here — an event on a detached node never reaches
      // a connected root, so frameworks that delegate (React) would not see it.
      return `${head}: it is no longer attached to the document. Re-read the page and try again.`
    case 'display':
      return `${head}: display:none. ${tail}`
    case 'visibility':
      return `${head}: visibility:${p.visibility}. ${tail}`
    case 'render':
      return `${head}: it is not rendered — an ancestor is hidden, or its content-visibility subtree is skipped. ${tail}`
    case 'size':
      return `${head}: its box is ${p.rect.width}x${p.rect.height}, so there is no coordinate to dispatch at. ${tail}`
    case 'offscreen':
      return `${head}: after scrolling it into view its box is still outside the ${p.viewport.w}x${p.viewport.h} viewport (at ${Math.round(p.rect.x)},${Math.round(p.rect.y)}) — it is positioned off-page. ${tail}`
  }
}
