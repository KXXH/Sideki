import type { UIMessage } from 'ai'
import { supportsToolDescription, toolDescription, type ToolActivity } from '../tool-description'

interface ActivityState {
  readonly status: string
  readonly messages: UIMessage[]
  subscribe(listener: () => void): () => void
}

export function collectToolActivities(state: Pick<ActivityState, 'status' | 'messages'>): ToolActivity[] {
  if (state.status !== 'submitted' && state.status !== 'streaming') return []
  const start = state.messages.findLastIndex(m => m.role === 'user') + 1
  return state.messages.slice(start).flatMap(message => message.role !== 'assistant' ? [] : message.parts.flatMap(part => {
    if (part.type !== 'dynamic-tool' && !part.type.startsWith('tool-')) return []
    const p = part as unknown as Record<string, unknown>
    const name = part.type === 'dynamic-tool' ? String(p.toolName) : part.type.slice(5)
    if (!supportsToolDescription(name)) return []
    if (p.state !== 'input-streaming' && p.state !== 'input-available') return []
    const description = toolDescription({ state: p.state, input: p.input, rawInput: p.rawInput })
    return description ? [{ id: `${message.id}:${p.toolCallId}`, description, phase: p.state === 'input-streaming' ? 'preparing' as const : 'executing' as const }] : []
  }))
}

// Reason: both hosts publish directly from kernel state, independent of panel
// visibility. Only meaningful changes cross runtime messaging, never each token.
export function publishToolActivities(
  state: ActivityState,
  getSessionId: () => string,
  send: (message: { type: string; sessionId: string; activities: ToolActivity[] }) => Promise<unknown>,
): () => void {
  let last = ''
  const update = () => {
    const sessionId = getSessionId()
    if (!sessionId) return
    const activities = collectToolActivities(state)
    const key = JSON.stringify([sessionId, activities])
    if (key === last) return
    last = key
    void send({ type: 'tab-lock:activity', sessionId, activities }).catch(() => {})
  }
  const unsubscribe = state.subscribe(update)
  update()
  return unsubscribe
}
