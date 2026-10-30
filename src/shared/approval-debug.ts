import type { ApiConfig, PermissionMode } from './types'
import type { ApprovalState } from './approval-service'
import type { TokenCounts } from './token-usage'

export interface ApprovalDebugUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
  partial?: boolean
}

export interface ApprovalDebugModel {
  model: string
  endpoint: string
  protocol: string
  reasoning: 'low'
  provider?: string
}
export interface ApprovalDebugStep {
  stepNumber: number
  startedAt: number
  finishedAt?: number
  messages: unknown
  system?: unknown
  tools?: unknown
  model?: { model: string; provider: string }
  text?: string
  toolCalls?: unknown
  toolResults?: unknown
  finishReason?: string
  usage?: ApprovalDebugUsage
  error?: string
}
export interface ApprovalInvestigation {
  id: string
  command: string
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
}
export interface ApprovalDebugRecord {
  id: string
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  args: unknown
  mode: PermissionMode
  diagnostic: boolean
  requestId?: string
  route: 'manual' | 'full-allow' | 'rule' | 'model' | 'setup-failure'
  model: ApprovalDebugModel
  startedAt: number
  finishedAt?: number
  elapsedMs?: number
  environment?: unknown
  context?: string
  investigations: ApprovalInvestigation[]
  steps: ApprovalDebugStep[]
  truncated?: boolean
  modelDecision?: { decision: 'allow' | 'deny'; reason: string }
  backendDecision?: { decision: 'allow' | 'deny' | 'manual'; reason: string }
  error?: string
  execution: { status: 'not-started' | 'running' | 'finished' | 'cancelled'; startedAt?: number; finishedAt?: number; error?: string }
  usage?: ApprovalDebugUsage
}
export interface ApprovalDebugSnapshot {
  sessionId: string
  permissionMode: PermissionMode
  model: ApprovalDebugModel
  state: ApprovalState
  instructions: string
  tools?: unknown
  records: ApprovalDebugRecord[]
  limits: { maxRecords: number; maxChars: number; currentChars: number }
}
export type ApprovalTraceEvent =
  | { type: 'usage'; stepNumber: number; tokens: TokenCounts; at: number }
  | { type: 'investigation-start'; id: string; command: string; at: number }
  | { type: 'investigation-result'; id: string; result?: unknown; error?: string; at: number }
  | { type: 'step-start'; stepNumber: number; messages: unknown; system?: unknown; tools?: unknown; model: { model: string; provider: string }; at: number }
  | { type: 'step-end'; stepNumber: number; text: string; toolCalls: unknown; toolResults: unknown; finishReason: string; usage: { inputTokens: number; outputTokens: number }; at: number }
  | { type: 'step-error'; stepNumber: number; error: string; text?: string; finishReason?: string; at: number }
export type ApprovalTrace = (event: ApprovalTraceEvent) => void

export function approvalDebugModel(config: ApiConfig | null): ApprovalDebugModel {
  let endpoint = ''
  try {
    const url = new URL(config?.endpoint ?? '')
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    endpoint = url.toString()
  } catch { /* Reason: malformed endpoint text could contain credentials. */ }
  return { model: config?.model ?? '', endpoint, protocol: config?.apiProtocol ?? 'chat-completions', reasoning: 'low' }
}

export function boundedDebugValue(value: unknown, maxChars = 12_000): unknown {
  const json = JSON.stringify(value) ?? 'null'
  return json.length <= maxChars ? JSON.parse(json) : { truncated: true, text: `${json.slice(0, maxChars)}\n[truncated]` }
}

export function publicReviewMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  return messages.map(message => {
    if (!message || typeof message !== 'object') return message
    const { role, content } = message as { role?: string; content?: unknown }
    if (!Array.isArray(content)) return { role, content }
    return { role, content: content.flatMap(part => {
      if (!part || typeof part !== 'object') return [part]
      const data = part as Record<string, unknown>
      // Reason: debugger captures public agent traffic, never reasoning or provider secrets.
      if (data.type === 'reasoning' || data.type === 'reasoning-file') return [{ type: data.type, omitted: true }]
      if (data.type === 'text') return [{ type: data.type, text: data.text }]
      if (data.type === 'tool-call') return [{ type: data.type, toolCallId: data.toolCallId, toolName: data.toolName, input: data.input }]
      if (data.type === 'tool-result') return [{ type: data.type, toolCallId: data.toolCallId, toolName: data.toolName, output: data.output }]
      return [{ type: data.type, omitted: true }]
    }) }
  })
}

export class ApprovalDebugLog {
  private records: ApprovalDebugRecord[] = []
  private readonly maxRecords = 30
  private readonly maxChars = 1_048_576

  add(record: ApprovalDebugRecord): void {
    this.records.push(record)
    this.prune()
  }
  update(id: string, update: (record: ApprovalDebugRecord) => void): void {
    const record = this.records.find(record => record.id === id)
    if (!record) return
    update(record)
    this.prune()
  }
  private prune(): void {
    // Reason: logs must remain bounded even while multiple reviews are active.
    // Removed or explicitly cleared records are never re-created by late events.
    while (this.records.length > 1 && (this.records.length > this.maxRecords || JSON.stringify(this.records).length > this.maxChars)) this.records.shift()
    const latest = this.records[0]
    if (latest && JSON.stringify(latest).length > this.maxChars) {
      latest.truncated = true
      latest.investigations = latest.investigations.slice(-2)
      for (const step of latest.steps) {
        step.messages = boundedDebugValue(step.messages, 12_000)
        step.toolCalls = boundedDebugValue(step.toolCalls, 4_000)
        step.toolResults = boundedDebugValue(step.toolResults, 4_000)
      }
    }
  }
  clear(sessionId: string): void { this.records = this.records.filter(record => record.sessionId !== sessionId) }
  snapshot(sessionId: string): Pick<ApprovalDebugSnapshot, 'records' | 'limits'> {
    const records = structuredClone(this.records.filter(record => record.sessionId === sessionId))
    return { records, limits: { maxRecords: this.maxRecords, maxChars: this.maxChars, currentChars: JSON.stringify(records).length } }
  }
}
