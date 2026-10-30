export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Reason: find the cutoff index for context compression.
// Keep last 3 user turns; if fewer than 3 exist, keep last 1.
// Returns -1 if nothing worth compressing.
export function findCompactionCutoff(roles: string[]): number {
  let userCount = 0
  let cutoff = roles.length
  for (let i = roles.length - 1; i >= 0; i--) {
    if (roles[i] === 'user') {
      userCount++
      if (userCount === 3) { cutoff = i; break }
    }
  }
  if (userCount < 3) {
    for (let i = roles.length - 1; i >= 0; i--) {
      if (roles[i] === 'user') { cutoff = i; break }
    }
  }
  return cutoff <= 1 ? -1 : cutoff
}

// Reason: find the cutoff index for tool result archiving.
// Strict: requires at least keepTurns user turns — never archives the current
// turn's fresh tool results (unlike findCompactionCutoff there is no fallback).
// Returns -1 when fewer than keepTurns user turns exist or nothing precedes them.
export function findArchiveCutoff(roles: string[], keepTurns: number): number {
  let userCount = 0
  for (let i = roles.length - 1; i >= 0; i--) {
    if (roles[i] === 'user') {
      userCount++
      if (userCount === keepTurns) return i > 0 ? i : -1
    }
  }
  return -1
}

// Reason: unpack a data URL's base64 payload into a latin1 byte string —
// the VFS convention for binary content. Returns null for non-base64 or
// malformed input instead of throwing.
export function dataUrlToLatin1(dataUrl: string): string | null {
  const m = /^data:[^;,]*;base64,/.exec(dataUrl)
  if (!m) return null
  try {
    return atob(dataUrl.slice(m[0].length))
  } catch {
    return null
  }
}

// Reason: step budget reminder stages. Equality crossing is naturally
// idempotent — each threshold fires exactly once per turn, no message
// scanning needed. stepNumber is 0-based (= steps completed so far).
export function stepBudgetStage(stepNumber: number, maxSteps: number): 'warn' | 'final' | null {
  const warnAt = Math.ceil(maxSteps * 0.8)
  const finalAt = Math.ceil(maxSteps * 0.95)
  if (stepNumber === finalAt && finalAt > warnAt) return 'final'
  if (stepNumber === warnAt) return 'warn'
  return null
}
