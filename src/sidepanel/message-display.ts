import type { UIMessage } from 'ai'
import type { StatusPhase } from './status-phase'

export interface MessageDisplayItem {
  key: string
  message: UIMessage | null
  sourceIndex: number
}

export function projectMessages(messages: readonly UIMessage[], sessionId: string, phase: StatusPhase): MessageDisplayItem[] {
  let replyTo: string | null = null
  const items = messages.map((message, sourceIndex) => {
    let key = JSON.stringify([sessionId, 'message', message.id])
    if (message.role === 'user') {
      replyTo = message.id
    } else if (message.role === 'assistant' && replyTo !== null) {
      // Reason: the first reply keeps its display identity before the model has assigned a message id.
      key = JSON.stringify([sessionId, 'reply', replyTo])
      replyTo = null
    }
    return { key, message, sourceIndex } as MessageDisplayItem
  })

  const lastMessage = messages.at(-1)
  if ((phase === 'building' || phase === 'requesting') && lastMessage?.role === 'user') {
    items.push({
      key: JSON.stringify([sessionId, 'reply', lastMessage.id]),
      message: null,
      sourceIndex: messages.length,
    })
  }
  return items
}
