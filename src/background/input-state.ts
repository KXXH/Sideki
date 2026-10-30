import type { MouseState } from '../shared/input'

// Reason: the pointer's position has to survive between tool calls or every
// action would animate from the same synthetic origin, which reads as a teleport
// rather than a continuous hand. This is a module-level Map on purpose — the
// state is aesthetic continuity, not correctness, so it is not worth two
// chrome.storage round trips per action. If the service worker is suspended the
// map is lost and the next action falls back to an approach origin: the pointer
// jumps once. Same lifetime and shape as tab-locks' own stacks Map.

const states = new Map<string, MouseState>()

// Reason: a session can move between tabs and each tab has its own viewport, so
// keying on sessionId alone would carry tab A's coordinates into tab B.
export function stateKey(sessionId: string, tabId: number): string {
  return `${sessionId}:${tabId}`
}

// Reason: a position from ten minutes ago describes a page the user has almost
// certainly changed. Treat it as absent rather than animating from it.
export const STATE_TTL_MS = 5 * 60_000

export function getMouseState(
  sessionId: string,
  tabId: number,
  docId: string | null,
  now = Date.now(),
): MouseState | null {
  const state = states.get(stateKey(sessionId, tabId))
  if (!state) return null
  if (now - state.updatedAt > STATE_TTL_MS) {
    states.delete(stateKey(sessionId, tabId))
    return null
  }
  // Reason: an SPA soft navigation replaces the document without any event the
  // service worker sees. The page-side fingerprint is the only witness, so a
  // mismatch discards the position rather than pointing at stale geometry.
  if (docId && state.docId && state.docId !== docId) {
    states.delete(stateKey(sessionId, tabId))
    return null
  }
  return state
}

export function setMouseState(sessionId: string, tabId: number, state: MouseState): void {
  states.set(stateKey(sessionId, tabId), state)
}

export function resetMouseState(sessionId: string, tabId: number): void {
  states.delete(stateKey(sessionId, tabId))
}

export function resetSessionMouseState(sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const key of states.keys()) {
    if (key.startsWith(prefix)) states.delete(key)
  }
}

export function resetTabMouseState(tabId: number): void {
  const suffix = `:${tabId}`
  for (const key of states.keys()) {
    if (key.endsWith(suffix)) states.delete(key)
  }
}

export function __resetInputState(): void {
  states.clear()
}

export function __inputStateSize(): number {
  return states.size
}
