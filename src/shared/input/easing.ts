// Reason: trajectory sampling lives apart from the planners so the curve shape
// can be pinned by unit tests independently of event ordering.

import type { Pt, Waypoint } from './types'

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// Reason: a real pointer takes longer for longer travel, but the agent should
// never wait more than half a second on decoration. Floor keeps short hops from
// looking like teleports.
export function pathDuration(dist: number): number {
  return Math.round(clamp(160 + dist * 0.45, 160, 520))
}

// Reason: no terminal overshoot. Overshoot would leave the final move waypoint
// at different coordinates from the subsequent press, which buys nothing
// visually and introduces a real class of "clicked 3px off" bugs.
export function samplePath(
  from: Pt,
  to: Pt,
  n: number,
  totalMs: number,
  ease: (t: number) => number = easeInOutQuad,
): Waypoint[] {
  const steps = Math.max(1, Math.floor(n))
  if (steps === 1 || totalMs <= 0) {
    return [{ at: Math.max(0, totalMs), x: to.x, y: to.y }]
  }
  const out: Waypoint[] = []
  for (let i = 1; i <= steps; i++) {
    const p = i / steps
    const e = ease(p)
    out.push({
      at: Math.round(totalMs * p),
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
    })
  }
  // Reason: rounding the eased position can leave the last sample short of the
  // target; the press must land exactly on the requested point.
  out[out.length - 1] = { at: totalMs, x: to.x, y: to.y }
  return out
}
