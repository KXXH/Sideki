import type { UIMessage } from 'ai'

const BUILTIN_TOOLS = new Set(['click', 'hover', 'type', 'select', 'keypress', 'scroll', 'screenshot', 'wait', 'navigate', 'getPageContent', 'bash', 'visualize', 'useSkill', 'schedule', 'monitor'])
const MAX_CONTEXT_CHARS = 48_000
const MAX_PENDING_CHARS = 24_000
const MAX_ENTRY_CHARS = 2_000

export interface ApprovalCall {
  toolCallId: string
  toolName: string
  input: unknown
}

export function approvalInput(toolName: string, input: unknown): unknown {
  if (!BUILTIN_TOOLS.has(toolName) || !input || typeof input !== 'object' || Array.isArray(input)) return input
  // Reason: model-authored presentation prose must not influence authorization.
  const args = { ...input as Record<string, unknown> }
  delete args.description
  return args
}

function bounded(text: string, limit = MAX_ENTRY_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text
}

function publicText(message: UIMessage): string {
  return message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

export function approvalTurnId(messages: UIMessage[]): string {
  return [...messages].reverse().find(message => message.role === 'user')?.id ?? 'startup'
}

export function buildApprovalContext(messages: UIMessage[], pending: ApprovalCall, environment: unknown): string {
  const pendingCall = { toolCallId: pending.toolCallId, toolName: pending.toolName, args: approvalInput(pending.toolName, pending.input) }
  if (JSON.stringify(pendingCall).length > MAX_PENDING_CHARS) throw new Error('待审批调用超过完整审查的输入预算')
  const users = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'user' && message.id !== '__context_summary__')
  const assistantStart = users.at(-2)?.index ?? 0
  const userMessages = users.slice(-5).map(({ message }) => {
    const metadata = message.metadata as Record<string, unknown> | undefined
    return {
      id: message.id,
      role: 'user',
      source: metadata?.source === 'claude-code' || metadata?.fromBridge ? 'bridge' : metadata?.source === 'timer' || metadata?.timer ? 'automation' : 'user',
      text: bounded(publicText(message), 4_000),
      attachments: message.parts.flatMap(part => part.type === 'data-file' ? [(part as unknown as { data: unknown }).data] : []),
    }
  })
  const assistantMessages = messages.slice(assistantStart).filter(message => message.role === 'assistant' && message.id !== '__context_summary__')
    .map(message => ({ id: message.id, role: 'assistant', isAuthorization: false, text: bounded(publicText(message)) }))
    .filter(message => message.text)
  const calls = new Map<string, Record<string, unknown>>()
  for (const message of messages) {
    for (const raw of message.parts) {
      const part = raw as unknown as Record<string, unknown>
      if (typeof part.toolCallId !== 'string' || part.toolCallId === pending.toolCallId) continue
      if (!(String(part.type).startsWith('tool-') || part.type === 'dynamic-tool') || part.state === 'input-streaming') continue
      const toolName = part.type === 'dynamic-tool' ? String(part.toolName) : String(part.type).slice(5)
      const state = String(part.state)
      calls.set(part.toolCallId, {
        toolCallId: part.toolCallId,
        toolName,
        args: bounded(JSON.stringify(approvalInput(toolName, part.input)) ?? 'null'),
        status: state === 'output-denied' ? 'denied' : state === 'output-error' ? 'failed' : state === 'output-available' ? 'succeeded' : 'pending',
        ...(typeof part.errorText === 'string' ? { error: bounded(part.errorText, 500) } : {}),
      })
    }
  }
  const context = {
    userMessages,
    assistantMessages,
    recentActions: [...calls.values()].slice(-10),
    environment,
    // Reason: the current action changes on every review; keep it after the reusable authorization history.
    pendingCall,
  }
  // Reason: fixed recency windows avoid another model selecting or paraphrasing consent.
  // Never trim the pending payload; older supporting entries yield first.
  while (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
    if (context.recentActions.length) context.recentActions.shift()
    else if (context.assistantMessages.length) context.assistantMessages.shift()
    else if (context.userMessages.length > 1) context.userMessages.shift()
    else throw new Error('完整调用和必要用户上下文超过审批输入预算')
  }
  return JSON.stringify(context)
}
