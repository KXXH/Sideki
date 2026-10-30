// Reason: generic over the node type so the enter/leave ordering rules can be
// unit-tested with plain strings in the project's DOM-less vitest environment.
// This is the executable spec, not the production path — the interpreter is an
// injected function and cannot import it, so it reimplements the same diff
// inline over Elements. Changing the ordering means changing both.

export interface HoverDiff<T> {
  // Reason: innermost → outermost. mouseleave fires on the deepest element first.
  left: T[]
  // Reason: outermost → innermost. mouseenter fires from the shallowest new
  // ancestor down to the target, which is the reverse of hit-test order.
  entered: T[]
  common: T[]
}

// Reason: `prev` and `next` are hit-test chains ordered innermost → outermost,
// matching document.elementsFromPoint. Everything from the shared ancestor
// upwards is untouched, which is exactly what the spec means by "not crossing
// the boundary".
export function diffHoverChain<T>(
  prev: readonly T[],
  next: readonly T[],
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
): HoverDiff<T> {
  const inNext = (v: T) => next.some(n => eq(n, v))
  const inPrev = (v: T) => prev.some(p => eq(p, v))

  const left = prev.filter(v => !inNext(v))
  const entered = next.filter(v => !inPrev(v)).reverse()
  const common = prev.filter(inNext)

  return { left, entered, common }
}

export function chainChanged<T>(
  prev: readonly T[],
  next: readonly T[],
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
): boolean {
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) {
    if (!eq(prev[i], next[i])) return true
  }
  return false
}
