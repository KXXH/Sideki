import { hidePageLockIndicator, setPageLockIndicatorEnabled, showPageLockIndicator, syncPageLockIndicator } from './page-lock-indicator'
import { resetMouseState, resetSessionMouseState, resetTabMouseState } from './input-state'
import { hideAiPointer } from './ai-pointer'

// Reason: turn-scoped tab ownership. A turn's operating tab is the top of its
// OWN stack, never "the active tab of some window" — that is a shared mutable
// signal which any other concurrent turn (or the user) can change underneath
// it, silently redirecting tools to the wrong page. The stack grows only via
// navigations the turn itself triggered, so concurrent turns never cross.
//
// Lives in the service worker because it is the single chokepoint every
// tab-touching path already goes through (DOM tools, bash page/chrome
// commands, CDP), and it is the only singleton shared by both kernel hosts
// (panel and offscreen).

// Reason: a host can die mid-turn (offscreen document killed, panel closed
// while streaming) without ever sending a release. Hosts heartbeat while the
// turn runs, so a live turn never goes stale; a leaked stack expiring is
// strictly better than deadlocking every other session on that tab.
const STALE_MS = 120_000

interface TurnStack {
  stack: number[]
  touchedAt: number
}

const stacks = new Map<string, TurnStack>()

// Reason: the panel's page strip must show the page the CONTEXT points at, not
// whichever tab the user just switched to — mid-turn those diverge. Broadcast
// only on actual top changes so per-tool-call resolution stays silent.
const lastNotifiedTop = new Map<string, number | null>()

function notifyTop(sessionId: string): void {
  const top = operatingTabOf(sessionId)
  const prev = lastNotifiedTop.get(sessionId)
  if (prev === top) return
  lastNotifiedTop.set(sessionId, top)
  if (top == null) lastNotifiedTop.delete(sessionId)
  syncPageLockIndicator(prev, top)
  // Reason: coordinates from the tab we just left describe a different viewport,
  // and its pointer now depicts nothing.
  if (prev != null && prev !== top) {
    resetMouseState(sessionId, prev)
    hideAiPointer(prev)
  }
  chrome.runtime.sendMessage({ type: 'tab-lock:changed', sessionId, tabId: top }).catch(() => {
    /* no panel listening */
  })
}

// Reason: a panel opening (or switching to) a session mid-turn must be able to
// pull the current operating tab — it missed the broadcast.
export function operatingTabOf(sessionId: string, now = Date.now()): number | null {
  prune(now)
  const entry = stacks.get(sessionId)
  if (!entry || entry.stack.length === 0) return null
  return entry.stack[entry.stack.length - 1]
}

function sessionOperatingOn(tabId: number, now = Date.now()): string | null {
  prune(now)
  for (const [sessionId, entry] of stacks) {
    if (entry.stack[entry.stack.length - 1] === tabId) return sessionId
  }
  return null
}

function prune(now: number): void {
  for (const [sessionId, entry] of stacks) {
    if (now - entry.touchedAt <= STALE_MS) continue
    const top = entry.stack[entry.stack.length - 1]
    stacks.delete(sessionId)
    // Reason: eviction IS a release whose message never arrived, so it must do
    // the same cleanup. Skipping it orphaned the injected island and the
    // pointer: once the stack entry is gone no later call can reference that
    // tab to hide them. Inline rather than via notifyTop, which reads
    // operatingTabOf and would re-enter prune.
    lastNotifiedTop.delete(sessionId)
    resetSessionMouseState(sessionId)
    if (top != null) {
      hideAiPointer(top)
      hidePageLockIndicator(top)
    }
    chrome.runtime.sendMessage({ type: 'tab-lock:changed', sessionId, tabId: null }).catch(() => {
      /* no panel listening */
    })
  }
}

// Reason: ownership covers the whole stack, not just the top. The lock only
// arbitrates between sessions (it never blocks the user), and a turn that
// pushed a tab may pop back to it — releasing intermediate tabs would let
// another session claim a tab this turn still holds.
export function ownerOf(tabId: number, now = Date.now()): string | null {
  prune(now)
  for (const [sessionId, entry] of stacks) {
    if (entry.stack.includes(tabId)) return sessionId
  }
  return null
}

// Reason: `pinned` means the caller already resolved an exact tab (user's
// context lock, or panel mode resolving its own window) — take it verbatim.
// An unpinned anchor is a WINDOW anchor: seed from that window's active tab so
// turn start still follows the user's intent at send time.
async function seedTab(anchorTabId: number | null, pinned: boolean): Promise<number | null> {
  if (anchorTabId != null && pinned) return anchorTabId
  if (anchorTabId != null) {
    try {
      const anchor = await chrome.tabs.get(anchorTabId)
      const [active] = await chrome.tabs.query({ active: true, windowId: anchor.windowId })
      return active?.id ?? anchorTabId
    } catch { /* anchor tab closed — fall through to focused window */ }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id ?? null
}

export interface OperatingTab {
  tabId: number | null
  blocked?: true
  message?: string
}

// Reason: the model has no tab addressing, so it cannot route around a busy
// page — it must be told retrying is pointless and the decision belongs to
// the user.
const BUSY_CURRENT_PAGE = [
  'Error: the current page is being operated by another background task, so actions here are blocked right now.',
  'Retrying will keep failing until it finishes, and you cannot switch to a different tab.',
  'Stop and let the user decide whether to wait or take over.',
].join('\n')

// Reason: an explicitly referenced tab CAN be routed around — offer both the
// skip branch and the stop-and-ask branch instead of dictating one.
function busyExplicitTab(tabId: number, title: string): string {
  const label = title ? ` ("${title}")` : ''
  return [
    `Error: tab #${tabId}${label} is being operated by another background task and cannot be changed right now.`,
    'Retrying the same tab will keep failing until that task finishes.',
    'If this tab is not essential, target a different tab or skip this step.',
    'If it is essential to your goal, stop and ask the user how to proceed.',
    '',
  ].join('\n')
}

// Reason: lazy acquisition — a turn that never touches a tab (pure
// computation, MCP-only) must not hold a lock. The first tab-touching tool
// call seeds the stack; every later call in the same turn just reads the top.
export async function resolveOperatingTab(
  sessionId: string,
  anchorTabId: number | null,
  pinned = false,
): Promise<OperatingTab> {
  const now = Date.now()
  prune(now)
  const mine = stacks.get(sessionId)
  if (mine && mine.stack.length > 0) {
    mine.touchedAt = now
    return { tabId: mine.stack[mine.stack.length - 1] }
  }
  const seed = await seedTab(anchorTabId, pinned)
  if (seed == null) return { tabId: null }
  const owner = ownerOf(seed, now)
  if (owner && owner !== sessionId) {
    return { tabId: null, blocked: true, message: BUSY_CURRENT_PAGE }
  }
  stacks.set(sessionId, { stack: [seed], touchedAt: now })
  notifyTop(sessionId)
  return { tabId: seed }
}

// Reason: turn end (status → ready), stop, dispose. Releasing is idempotent —
// several of those boundaries can fire for one turn.
export function releaseTurn(sessionId: string): void {
  const top = operatingTabOf(sessionId)
  stacks.delete(sessionId)
  resetSessionMouseState(sessionId)
  if (top != null) hideAiPointer(top)
  notifyTop(sessionId)
}

// Reason: liveness means "the turn is alive", not "the turn touched a tab" — a
// long reasoning stretch or a run of MCP calls would otherwise expire the lock
// and, worse, drop the stack (losing tabs the turn already followed into).
// Pruning first is deliberate: an already-expired stack must never be revived,
// since another session may have claimed its tab in the meantime.
export function touchTurn(sessionId: string): void {
  const now = Date.now()
  prune(now)
  const entry = stacks.get(sessionId)
  if (!entry) return
  entry.touchedAt = now
  // Reason: the injected island only holds a lease (see page-lock-indicator) —
  // the heartbeat is what renews it. Riding this channel means no timer in the
  // service worker, which cannot be trusted to survive suspension. A released or
  // pruned session has no entry, so a dead turn never renews.
  const top = entry.stack[entry.stack.length - 1]
  if (top != null) showPageLockIndicator(top)
}

// Reason: the only signal that says "this new tab came from THAT tab" —
// webNavigation.onCreatedNavigationTarget. Matching on the stack top attributes
// the tab to the turn that actually opened it. Programmatic tabs.create fires
// no such event; a tab a command creates or switches to is declared by that
// command itself, through noteExplicitOperatingTab.
export function noteNavigationTarget(sourceTabId: number, tabId: number): void {
  const now = Date.now()
  prune(now)
  for (const [sessionId, entry] of stacks) {
    if (entry.stack[entry.stack.length - 1] !== sourceTabId) continue
    entry.stack.push(tabId)
    entry.touchedAt = now
    notifyTop(sessionId)
    return
  }
}

// Reason: `chrome tabs --switch/--new` is the agent pointing itself at a tab.
// Moving the top is what makes that declaration real — the activation alone
// changes only the user's view, while every later tool keeps acting on the page
// the agent left. Moves instead of pushes when the tab is already in the stack:
// switching back and forth must not pile up duplicates, and the tab left behind
// stays owned in case the agent returns to it.
export function noteExplicitOperatingTab(sessionId: string, tabId: number): void {
  const now = Date.now()
  prune(now)
  const entry = stacks.get(sessionId)
  if (!entry) {
    stacks.set(sessionId, { stack: [tabId], touchedAt: now })
    notifyTop(sessionId)
    return
  }
  const idx = entry.stack.indexOf(tabId)
  entry.touchedAt = now
  if (idx === entry.stack.length - 1) return
  if (idx >= 0) entry.stack.splice(idx, 1)
  entry.stack.push(tabId)
  notifyTop(sessionId)
}

// Reason: a closed tab must never stay locked, and the turn falls back to the
// tab it came from. An emptied stack is dropped so the next call re-seeds.
export function noteTabRemoved(tabId: number): void {
  resetTabMouseState(tabId)
  for (const [sessionId, entry] of stacks) {
    const idx = entry.stack.indexOf(tabId)
    if (idx < 0) continue
    entry.stack.splice(idx, 1)
    if (entry.stack.length === 0) stacks.delete(sessionId)
    notifyTop(sessionId)
  }
}

// Reason: explicit tab references (`chrome tabs --close/--switch #id`) can
// destroy or steal a tab another turn is driving — they must pass the same
// gate as implicit targets. Own tabs are always allowed: closing the page it
// just finished with is legitimate, and removal releases the lock.
export async function gateExplicitTab(sessionId: string, tabId: number): Promise<string | null> {
  const owner = ownerOf(tabId)
  if (!owner || owner === sessionId) return null
  let title = ''
  try {
    const tab = await chrome.tabs.get(tabId)
    title = tab.title ?? ''
  } catch { /* tab vanished — report without a label */ }
  return busyExplicitTab(tabId, title)
}

// Reason: lock state is the same state the UI must project ("this tab has a
// turn running on it") — exposed as one snapshot so page badges, title
// prefixes and the panel indicator can never disagree with the registry.
export function lockedTabsSnapshot(now = Date.now()): { sessionId: string; tabs: number[] }[] {
  prune(now)
  return [...stacks].map(([sessionId, entry]) => ({ sessionId, tabs: [...entry.stack] }))
}

export function setPageLockIndicatorPreference(enabled: boolean): void {
  setPageLockIndicatorEnabled(enabled)
  for (const entry of stacks.values()) {
    const top = entry.stack[entry.stack.length - 1]
    if (top == null) continue
    if (enabled) showPageLockIndicator(top)
    else hidePageLockIndicator(top)
  }
}

export function registerTabLockListeners(): void {
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    noteNavigationTarget(details.sourceTabId, details.tabId)
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    noteTabRemoved(tabId)
  })
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Reason: same-tab navigations rebuild the page document and drop the
    // injected island; if this tab is still the stack top, restore it.
    if (!changeInfo.url && changeInfo.status !== 'complete') return
    const owner = sessionOperatingOn(tabId)
    if (owner) showPageLockIndicator(tabId)
  })
}

// Reason: tests drive the registry directly and must not inherit state.
export function __resetTabLocks(): void {
  stacks.clear()
  lastNotifiedTop.clear()
}

// Reason: scheduled work retains page identity while releasing ownership between turns.
export function snapshotTurnTabs(sessionId: string): number[] {
  prune(Date.now())
  return [...(stacks.get(sessionId)?.stack ?? [])]
}

export async function restoreTurnTabs(sessionId: string, tabs: number[]): Promise<void> {
  const live = await Promise.all(tabs.map(id => chrome.tabs.get(id).catch(() => null)))
  if (!live.at(-1)) throw new Error('目标页面已关闭')
  const ids = tabs.filter((_, index) => live[index] != null)
  for (const id of ids) {
    const owner = ownerOf(id)
    if (owner && owner !== sessionId) throw new Error('目标页面正由其他会话操作，请稍后恢复任务')
  }
  releaseTurn(sessionId)
  stacks.set(sessionId, { stack: ids, touchedAt: Date.now() })
  notifyTop(sessionId)
}
