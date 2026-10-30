import { highlightAll } from 'microlighter'

// Reason: highlightAll clears every registered category before rebuilding, so a
// call scoped to one block would strip the colors off all the others. Every call
// must cover the whole document, which makes coalescing mandatory rather than an
// optimization — N blocks finishing in one frame would otherwise mean N full rescans.

const BLOOM_MS = 700

const pending = new Set<HTMLElement>()
const blooming = new Map<HTMLElement, number>()

let scanQueued = false
let bloomRaf: number | null = null

// Reason: ease-in-out, not ease-out. Cubic ease-out finishes half the color change in
// the first fifth of the duration, which reads as an instant jump no matter how long
// the animation nominally is.
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function bloomFrame(now: number) {
  bloomRaf = null

  for (const [el, start] of blooming) {
    const p = Math.min((now - start) / BLOOM_MS, 1)
    if (p >= 1) {
      // Reason: dropping the inline value lets the stylesheet fallback (1) take over,
      // so a later re-render can't resurrect a stale mid-bloom progress value.
      el.style.removeProperty('--code-p')
      blooming.delete(el)
    } else {
      el.style.setProperty('--code-p', ease(p).toFixed(4))
    }
  }

  if (blooming.size) bloomRaf = requestAnimationFrame(bloomFrame)
}

function startBloom(el: HTMLElement) {
  blooming.set(el, performance.now())
  if (bloomRaf === null) bloomRaf = requestAnimationFrame(bloomFrame)
}

async function runScan() {
  scanQueued = false
  const batch = [...pending]
  pending.clear()

  await highlightAll()

  // Reason: bloom only starts once ranges exist. Starting earlier would animate a
  // progress value nothing reads yet, and the colors would pop in at full strength
  // partway through.
  for (const el of batch) startBloom(el)
}

/**
 * Register a completed code block for highlighting.
 *
 * `el` is the block wrapper carrying `--code-p`; it is pinned to 0 immediately so the
 * highlight paints at body-text color on its first frame instead of flashing full
 * color before the bloom starts.
 */
export function requestHighlight(el: HTMLElement) {
  el.style.setProperty('--code-p', '0')
  pending.add(el)

  if (!scanQueued) {
    scanQueued = true
    requestAnimationFrame(() => { void runScan() })
  }
}
