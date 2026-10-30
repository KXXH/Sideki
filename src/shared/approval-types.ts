import type { PermissionMode } from './types'

export interface ApprovalReference {
  requestId: string
  permitId: string
  turnId: string
}

export interface ApprovalPrepareInput {
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  mode: PermissionMode
  tabId?: number | null
}

export interface ApprovalPrepareResult {
  requestId: string
  decision: 'review' | 'allow' | 'manual' | 'deny'
  reason?: string
  permitId?: string
  environment: { tabId: number | null; url: string; title: string }
}

// Reason: only the background constructs this capability; it never travels in model arguments.
export interface ExecutionApproval {
  readonly mode: PermissionMode
  readonly sessionId: string
  readonly toolCallId: string
  readonly signal?: AbortSignal
  isActive(): boolean
}
