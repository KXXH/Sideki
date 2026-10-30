import type { UIMessage } from 'ai'

// Reason: turn-completion notifications are a kernel → SW contract — the
// kernel observes the turn boundary and whether a visible panel is showing
// that session, the SW owns chrome.notifications and the window-focus state.
// Everything decision-shaped lives here as pure functions so the calibration
// rules are testable without a browser.

export interface TurnDoneMessage {
  type: 'turn:done'
  sessionId: string
  title: string
  snippet: string
  // Reason: "a visible panel is showing this session" — the panel that ran
  // the turn being the same one that would show the answer is the only case
  // where nothing has to be announced.
  foreground: boolean
  // Reason: travels with the notice so the click can tell whether the panel
  // it lands in is even able to host the session — a Chat panel cannot open a
  // Pro session, and the session list of the other mode never contains it.
  mode: 'chat' | 'pro'
}

export interface TurnNotifyInput {
  foreground: boolean
  anyWindowFocused: boolean
  enabled: boolean
}

// Reason: never interrupt a turn the user is already watching, and never
// fire while any browser window holds focus — an unfocused window can sit on
// a second screen unseen just as easily as a closed one.
export function shouldNotifyTurn(input: TurnNotifyInput): boolean {
  if (!input.enabled) return false
  return !input.foreground || !input.anyWindowFocused
}

const ID_PREFIX = 'turn-done:'

// Reason: mode, window id and session id all ride in the notification id
// because the click handler needs them synchronously — sidePanel.open() must
// be the first async call in that handler, so there is no budget for a
// windows.query() or a storage read before it, and the SW may have been
// evicted since the notification was created (in-memory maps do not survive).
export function turnNotificationId(mode: 'chat' | 'pro', windowId: number | null, sessionId: string): string {
  return `${ID_PREFIX}${mode}:${windowId ?? ''}:${sessionId}`
}

export function parseTurnNotificationId(id: string): { mode: 'chat' | 'pro'; windowId: number | null; sessionId: string } | null {
  if (!id.startsWith(ID_PREFIX)) return null
  const parts = id.slice(ID_PREFIX.length).split(':')
  if (parts.length < 3) return null
  const [mode, win, ...rest] = parts
  const sessionId = rest.join(':')
  if (mode !== 'chat' && mode !== 'pro') return null
  if (!sessionId) return null
  return { mode, windowId: win ? Number(win) : null, sessionId }
}

// Reason: the placeholder a session carries until its first title is
// generated — if the notice is built before that lands (title generation
// timed out, or a turn that produced no text to title from), the reader must
// not be shown the placeholder as if it were a name.
const PLACEHOLDER_TITLE = 'New Chat'

export function turnNotificationText(input: { title: string; snippet: string }): { title: string; message: string } {
  const title = input.title.trim()
  return {
    title: !title || title === PLACEHOLDER_TITLE ? 'Sideki' : title,
    message: input.snippet.trim() || '已完成',
  }
}

// Reason: the notification is read at a glance on a locked phone or a second
// monitor — markdown furniture (fences, headings, table pipes) costs the
// reader more than it conveys at that size.
export function extractTurnSnippet(messages: readonly UIMessage[], max = 120): string {
  const text = lastAssistantText(messages)
  const flat = flatten(text)
  if (flat.length <= max) return flat
  return flat.slice(0, max).trimEnd() + '…'
}

function lastAssistantText(messages: readonly UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const parts = (m.parts ?? []) as { type?: string; text?: string }[]
    const text = parts
      .filter(p => p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
      .join('')
    if (text.trim()) return text
  }
  return ''
}

function flatten(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*$/, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
