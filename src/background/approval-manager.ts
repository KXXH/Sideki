import type { ApprovalPrepareInput, ApprovalPrepareResult, ApprovalReference, ExecutionApproval } from '../shared/approval-types'
import { createReviewShell } from './review-shell'
import { operatingTabOf } from './tab-locks'
import { approvalInput } from '../shared/approval-context'

interface ReviewShell {
  exec(command: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }>
  isCurrent(): Promise<boolean> | boolean
  dispose(): void
}
interface Request {
  input: ApprovalPrepareInput
  tabId: number | null
  url: string
  expiresAt: number
  state: 'review' | 'ready' | 'executing' | 'closed'
  permitId?: string
  shell?: ReviewShell
  abort: AbortController
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}

function callArgs(args: Record<string, unknown>, toolName: string): string {
  const filtered = { ...approvalInput(toolName, args) as Record<string, unknown> }
  if (toolName === 'bash' || toolName === 'screenshot') delete filtered.sessionId
  return canonical(filtered)
}

export class ApprovalManager {
  private requests = new Map<string, Request>()
  private readonly shellFactory: (sessionId: string, tabId: number) => Promise<ReviewShell>
  constructor(shellFactory: (sessionId: string, tabId: number) => Promise<ReviewShell> = createReviewShell) { this.shellFactory = shellFactory }

  private prune(): void {
    for (const [id, request] of this.requests) if (Date.now() >= request.expiresAt) this.finish(id)
  }

  async prepare(input: ApprovalPrepareInput): Promise<ApprovalPrepareResult> {
    this.prune()
    if (!input.sessionId || !input.turnId || !input.toolCallId || !input.toolName || !['ask', 'auto', 'allow'].includes(input.mode)) throw new Error('无效的审批请求')
    if ([...this.requests.values()].filter(r => r.input.sessionId === input.sessionId).length >= 16) throw new Error('待审批调用过多')
    const tabId = operatingTabOf(input.sessionId) ?? input.tabId ?? null
    const tab = tabId == null ? null : await chrome.tabs.get(tabId)
    const environment = { tabId, url: tab?.url ?? '', title: tab?.title ?? '' }
    const requestId = crypto.randomUUID()
    const request: Request = { input: structuredClone(input), tabId, url: environment.url, expiresAt: Date.now() + 120_000, state: 'review', abort: new AbortController() }
    this.requests.set(requestId, request)
    const immediate = input.mode !== 'auto' || ['getPageContent', 'wait', 'useSkill'].includes(input.toolName)
    if (immediate) {
      request.state = 'ready'
      request.permitId = crypto.randomUUID()
      return { requestId, decision: input.mode === 'ask' ? 'manual' : 'allow', permitId: request.permitId, environment }
    }
    if (tabId == null) {
      this.finish(requestId)
      return { requestId, decision: 'deny', reason: '无法确定当前调用的目标页面', environment }
    }
    try {
      request.shell = await this.shellFactory(input.sessionId, tabId)
      if (request.state === 'closed') { request.shell.dispose(); throw new Error('审批已取消') }
      return { requestId, decision: 'review', environment }
    } catch (error) {
      this.finish(requestId)
      return { requestId, decision: 'deny', reason: `无法准备只读调查环境：${error instanceof Error ? error.message : String(error)}`, environment }
    }
  }

  async bash(requestId: string, command: string) {
    this.prune()
    const request = this.requests.get(requestId)
    if (!request || request.state !== 'review' || !request.shell) throw new Error('审批请求已失效')
    return request.shell.exec(command, request.abort.signal)
  }

  async complete(requestId: string, decision: string, reason: string) {
    this.prune()
    const request = this.requests.get(requestId)
    if (!request || request.state !== 'review') return { decision: 'deny' as const, reason: '审批请求已失效' }
    if (decision !== 'allow') { this.finish(requestId); return { decision: 'deny' as const, reason: reason || '自动审批拒绝了此操作' } }
    if (!await request.shell?.isCurrent() || request.state !== 'review') { this.finish(requestId); return { decision: 'deny' as const, reason: '审批期间文件或页面已变化，请重新发起调用' } }
    request.state = 'ready'
    request.permitId = crypto.randomUUID()
    return { decision: 'allow' as const, permitId: request.permitId }
  }

  async claim(reference: ApprovalReference, toolName: string, args: Record<string, unknown>, tabId?: number | null): Promise<ExecutionApproval> {
    this.prune()
    const request = this.requests.get(reference.requestId)
    if (!request || request.state !== 'ready' || reference.permitId !== request.permitId || reference.turnId !== request.input.turnId || toolName !== request.input.toolName || callArgs(args, toolName) !== callArgs(request.input.args, toolName)) throw new Error('调用与获批内容不一致或授权已失效')
    if (tabId != null && tabId !== request.tabId) throw new Error('调用目标与审批页面不一致')
    if (request.tabId != null && (await chrome.tabs.get(request.tabId)).url !== request.url) throw new Error('审批后目标页面已变化')
    if (request.shell && !await request.shell.isCurrent()) throw new Error('审批后文件或页面已变化')
    // Reason: recheck after asynchronous validation so two claims cannot consume one permit.
    if (request.state !== 'ready' || !this.requests.has(reference.requestId)) throw new Error('授权已失效')
    request.state = 'executing'
    request.shell?.dispose()
    request.shell = undefined
    return {
      mode: request.input.mode,
      sessionId: request.input.sessionId,
      toolCallId: request.input.toolCallId,
      signal: request.abort.signal,
      isActive: () => request.state === 'executing' && !request.abort.signal.aborted && Date.now() < request.expiresAt,
    }
  }

  finish(requestId: string): void {
    const request = this.requests.get(requestId)
    if (!request) return
    request.state = 'closed'
    request.abort.abort()
    request.shell?.dispose()
    this.requests.delete(requestId)
  }

  cancelSession(sessionId: string): void {
    for (const [id, request] of this.requests) if (request.input.sessionId === sessionId) this.finish(id)
  }
}

export const approvalManager = new ApprovalManager()
