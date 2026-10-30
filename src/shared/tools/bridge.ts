const TOOL_PREFIX = 'tool:'
import type { ApprovalReference } from '../approval-types'

export interface ToolResult {
  success: boolean
  error?: string
  [key: string]: unknown
}

// Reason: the active chat session ID is injected here so bash commands
// operate on the correct per-session filesystem without relying on the AI to pass it
let _activeSessionId = ''
export function setActiveSessionId(id: string) { _activeSessionId = id }
// Reason: panel-mode tools without a per-call ctx still need the owning session
// (visualize reads/writes its VFS snapshot there) — the setter had no getter.
export function getActiveSessionId(): string { return _activeSessionId }

// Reason: per-call context for session multiplexing — several kernels run
// concurrently in the offscreen host, so tab/session identity must travel
// with each tool call. Module-level state remains the panel-mode fallback.
export interface ToolCallCtx {
  getApproval?: (toolCallId: string) => ApprovalReference | undefined
  getSessionId?: () => string
  getTabId?: () => number | null
  isPinned?: () => boolean
  getTurnPage?: () => { title: string; url: string } | null
  getStepLimit?: () => number | undefined
}

let _lockedTabId: number | null = null
export function setLockedTabId(id: number | null) { _lockedTabId = id }

// Reason: offscreen documents only expose chrome.runtime — chrome.tabs is
// undefined there. Tab resolution order: locked id → per-call ctx →
// chrome.tabs (panel) → host-injected provider → SW env proxy (cold path).
let _fallbackTabProvider: (() => number | null) | null = null
export function setFallbackTabProvider(fn: (() => number | null) | null) { _fallbackTabProvider = fn }

async function resolveTabId(ctx?: ToolCallCtx): Promise<number> {
  const sessionId = ctx?.getSessionId?.() || _activeSessionId
  // Reason: a pinned anchor is an exact tab the caller already resolved (the
  // user's context lock, or panel mode querying its own window) — the SW must
  // not re-resolve it against a window. An unpinned anchor is a window anchor.
  let anchor: number | null = ctx?.isPinned?.() ? ctx.getTabId?.() ?? null : _lockedTabId ?? ctx?.getTabId?.() ?? null
  let pinned = _lockedTabId != null || !!ctx?.isPinned?.()
  if (anchor == null && chrome.tabs?.query) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id != null) { anchor = tab.id; pinned = true }
  }
  if (anchor == null) {
    const provided = _fallbackTabProvider?.()
    if (provided != null) { anchor = provided; pinned = true }
  }
  // Reason: the operating tab is the top of THIS turn's tab stack, not the
  // active tab of a window — concurrent turns would otherwise steer each other
  // by merely opening or activating tabs. The anchor only seeds the stack at
  // turn start; afterwards the stack follows navigations this turn triggered.
  if (sessionId) {
    const resp = await chrome.runtime.sendMessage({
      type: 'env:operating-tab', sessionId, anchorTabId: anchor, pinned, strict: !!ctx?.isPinned?.(),
    }).catch(() => null)
    // Reason: another session holds this tab — surface it as a tool failure so
    // the model can stop or route around it instead of silently acting on a
    // page someone else is mutating.
    if (resp?.blocked) throw new Error(resp.message as string)
    if (ctx?.isPinned?.() && resp?.tabId == null) throw new Error('定时任务的目标页面不可用')
    if (resp?.tabId != null) return resp.tabId as number
  }
  if (anchor != null) return anchor
  const resp = await chrome.runtime.sendMessage({ type: 'env:active-tab' })
  if (resp?.tabId == null) throw new Error('No active tab found')
  return resp.tabId
}

// Reason: seed the turn's tab stack before its first token, so the whole turn
// holds one stable tab reference regardless of what the user activates midway.
// Deliberately swallows failures — a contested seed tab or a missing tab must
// not abort the turn; the first tool call then surfaces the busy error to the
// model, which is the only place that can act on it.
export async function acquireTurnTab(ctx?: ToolCallCtx): Promise<void> {
  try {
    await resolveTabId(ctx)
  } catch {
    /* seeding is best-effort */
  }
}

// Reason: read-only view of the turn's operating tab — deliberately NOT
// resolveTabId, which would seed the stack and take the lock. Callers that only
// need tab identity for side concerns (consent routing / site attribution) must
// not turn a lock-free turn (pure MCP) into a lock holder. Falls back to the
// anchor when no turn owns a tab yet.
export async function peekOperatingTabId(ctx?: ToolCallCtx): Promise<number | null> {
  const sessionId = ctx?.getSessionId?.() || _activeSessionId
  if (sessionId) {
    const resp = await chrome.runtime.sendMessage({ type: 'tab-lock:query', sessionId }).catch(() => null)
    if (resp?.tabId != null) return resp.tabId as number
  }
  return ctx?.getTabId?.() ?? null
}

export async function sendToolMessage<T extends ToolResult = ToolResult>(
  toolType: string,
  params: Record<string, unknown>,
  abortSignal?: AbortSignal,
  ctx?: ToolCallCtx,
  toolCallId?: string,
): Promise<T> {
  const tabId = await resolveTabId(ctx)

  const enriched = { ...params }
  // Reason: bash needs the per-session FS; screenshot needs it for the
  // labImageFs VFS mirror.
  if (toolType === 'bash' || toolType === 'screenshot') {
    const sid = ctx?.getSessionId?.() || _activeSessionId
    if (sid) enriched.sessionId = sid
  }

  const responsePromise = chrome.runtime.sendMessage({
    type: `${TOOL_PREFIX}${toolType}`,
    tabId,
    params: enriched,
    approval: toolCallId ? ctx?.getApproval?.(toolCallId) : undefined,
  })

  if (!abortSignal) {
    const response = await responsePromise
    if (!response) throw new Error('No response from background script')
    return response as T
  }

  // Reason: race the SW call against the abort signal so Stop responds instantly
  // instead of waiting for tool execution to finish
  const response = await Promise.race([
    responsePromise,
    new Promise<never>((_, reject) => {
      if (abortSignal.aborted) { reject(abortSignal.reason); return }
      abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
    }),
  ])

  if (!response) throw new Error('No response from background script')
  return response as T
}
