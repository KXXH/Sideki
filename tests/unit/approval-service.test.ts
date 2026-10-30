import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ApprovalService, type ApprovalBinding, type ApprovalRunner } from '../../src/shared/approval-service'
import type { ApiConfig, PermissionMode } from '../../src/shared/types'

afterEach(() => vi.useRealTimers())
const call = { toolCallId: 'call', toolName: 'bash', input: { command: 'bash /tmp/task.sh' } }
function setup(mode: PermissionMode = 'auto') {
  let currentMode = mode
  const send = vi.fn(async (message: Record<string, unknown>): Promise<unknown> => {
    if (message.type === 'approval:prepare') return { requestId: 'request', decision: currentMode === 'auto' ? 'review' : currentMode === 'ask' ? 'manual' : 'allow', permitId: 'permit', environment: { tabId: 1 } }
    if (message.type === 'approval:complete') return { decision: message.decision, reason: message.reason, permitId: message.decision === 'allow' ? 'permit' : undefined }
    return undefined
  })
  const binding: ApprovalBinding = {
    getConfig: () => ({ model: 'user-model' } as ApiConfig),
    getSessionId: () => 'session',
    getMessages: () => [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'read the page' }] }] as UIMessage[],
    getMode: () => currentMode,
    sendMessage: send,
  }
  return { binding, send, setMode: (mode: PermissionMode) => { currentMode = mode } }
}

describe('approval service', () => {
  it.each(['cancel', 'timeout'] as const)('keeps reported usage after review %s without counting a nonexistent verdict', async outcome => {
    const { binding } = setup()
    const runner = vi.fn<ApprovalRunner>(async (_config, _prompt, _request, _signal, _send, trace) => {
      trace?.({ type: 'usage', stepNumber: 0, tokens: { input: 40, output: 5, read: 30, write: null, reasoning: 2 }, at: Date.now() })
      return new Promise<never>(() => {})
    })
    const service = new ApprovalService(binding, runner)
    if (outcome === 'timeout') vi.useFakeTimers()
    const pending = service.review(call)
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
    if (outcome === 'cancel') service.cancelAll('任务已停止')
    else await vi.advanceTimersByTimeAsync(30_001)
    expect(await pending).toMatchObject({ type: 'denied' })
    expect(service.state).toMatchObject({ reviews: 1, inputTokens: 40, outputTokens: 5 })
    const record = service.getDebugSnapshot().records[0]
    expect(record.usage).toMatchObject({ inputTokens: 40, outputTokens: 5, cacheReadTokens: 30, reasoningTokens: 2 })
    expect(record.modelDecision).toBeUndefined()
    expect(record.finishedAt).toBeDefined()
  })

  it('does not add aggregate verdict usage on top of per-call usage', async () => {
    const { binding } = setup()
    const service = new ApprovalService(binding, async (_config, _prompt, _request, _signal, _send, trace, sessionId) => {
      expect(sessionId).toBe('session')
      for (const stepNumber of [0, 1]) trace?.({ type: 'usage', stepNumber, tokens: { input: 20, output: 5, read: 10, write: null, reasoning: 1 }, at: Date.now() })
      return { decision: 'allow', reason: '符合请求', inputTokens: 40, outputTokens: 10 }
    })
    expect(await service.review(call)).toMatchObject({ type: 'approved' })
    expect(service.state).toMatchObject({ reviews: 1, inputTokens: 40, outputTokens: 10 })
    expect(service.getDebugSnapshot().records[0].usage).toMatchObject({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 20 })
  })
  it('fails closed if a grant is cancelled between SDK approval and execution', async () => {
    const { binding } = setup('allow')
    const service = new ApprovalService(binding, vi.fn())
    expect(await service.review(call)).toEqual({ type: 'approved' })
    service.cancelAll('权限已变化')
    expect(() => service.beginExecution(call.toolCallId)).toThrow('调用授权已取消或失效')
  })
  it('does not consult a model in manual or full-allow modes and retains execution identity', async () => {
    for (const [mode, expected] of [['ask', 'not-applicable'], ['allow', 'approved']] as const) {
      const { binding, send } = setup(mode)
      const runner = vi.fn()
      const service = new ApprovalService(binding, runner)
      expect(await service.review(call)).toEqual({ type: expected })
      expect(runner).not.toHaveBeenCalled()
      expect(service.getApproval('call')).toEqual({ requestId: 'request', permitId: 'permit', turnId: 'user' })
      await service.finish('call')
      expect(service.getApproval('call')).toBeUndefined()
      expect(send).toHaveBeenCalledWith({ type: 'approval:finish', requestId: 'request' })
    }
  })

  it('only exposes a grant after the backend accepts the exact completed review', async () => {
    const { binding, send } = setup()
    const runner = vi.fn(async () => ({ decision: 'allow' as const, reason: '符合查询要求', inputTokens: 100, outputTokens: 5 }))
    const service = new ApprovalService(binding, runner)
    expect(await service.review(call)).toEqual({ type: 'approved' })
    expect(send).toHaveBeenCalledWith({ type: 'approval:complete', requestId: 'request', decision: 'allow', reason: '符合查询要求' })
    expect(service.state).toMatchObject({ status: 'idle', reviews: 1, inputTokens: 100, outputTokens: 5 })
  })

  it('returns model denials to the main loop without a user-approval fallback', async () => {
    const { binding } = setup()
    const service = new ApprovalService(binding, async () => ({ decision: 'deny', reason: '用户没有授权提交订单' }))
    expect(await service.review(call)).toEqual({ type: 'denied', reason: '用户没有授权提交订单' })
    expect(service.getApproval('call')).toBeUndefined()
  })

  it('cancels in-flight reviews and ignores late allows', async () => {
    const { binding, send } = setup()
    let complete!: (result: { decision: 'allow'; reason: string }) => void
    const runner = vi.fn(() => new Promise<{ decision: 'allow'; reason: string }>(resolve => { complete = resolve }))
    const service = new ApprovalService(binding, runner)
    const review = service.review(call)
    await vi.waitFor(() => expect(runner).toHaveBeenCalled())
    service.cancelAll('任务已停止')
    expect(await review).toMatchObject({ type: 'denied', reason: expect.stringContaining('任务已停止') })
    complete({ decision: 'allow', reason: 'late verdict' })
    await Promise.resolve()
    expect(service.getApproval('call')).toBeUndefined()
    expect(send.mock.calls.some(([message]) => message.type === 'approval:complete')).toBe(false)
  })

  it('fails closed on reviewer failure and timeout', async () => {
    const { binding } = setup()
    const failed = new ApprovalService(binding, async () => { throw new Error('provider unavailable') })
    expect(await failed.review(call)).toMatchObject({ type: 'denied', reason: expect.stringContaining('provider unavailable') })
    vi.useFakeTimers()
    const stalled = new ApprovalService(binding, () => new Promise(() => {}))
    const pending = stalled.review(call)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await pending).toMatchObject({ type: 'denied', reason: expect.stringContaining('超时') })
  })

  it('re-evaluates a pending tool after mode changes and preserves executing grants', async () => {
    const { binding, send, setMode } = setup()
    const runner = vi.fn(() => new Promise<{ decision: 'allow'; reason: string }>(() => {}))
    const service = new ApprovalService(binding, runner)
    const pending = service.review(call)
    await vi.waitFor(() => expect(runner).toHaveBeenCalled())
    service.cancelAll('权限模式已变化', false)
    setMode('allow')
    expect(await pending).toEqual({ type: 'approved' })
    expect(send.mock.calls.filter(([message]) => message.type === 'approval:prepare').map(([message]) => message.mode)).toEqual(['auto', 'allow'])
    service.beginExecution('call')
    const cancelCount = send.mock.calls.filter(([message]) => message.type === 'approval:cancel').length
    service.cancelAll('权限模式已变化', false)
    expect(service.getApproval('call')).toBeDefined()
    expect(send.mock.calls.filter(([message]) => message.type === 'approval:cancel')).toHaveLength(cancelCount)
    await service.finish('call')
  })

  it('revokes a prepare response that arrives after cancellation', async () => {
    const { binding, send } = setup('allow')
    let prepared!: (value: unknown) => void
    send.mockImplementationOnce(() => new Promise(resolve => { prepared = resolve }))
    const service = new ApprovalService(binding, vi.fn())
    const pending = service.review(call)
    service.cancelAll('任务已停止')
    expect(await pending).toMatchObject({ type: 'denied' })
    prepared({ requestId: 'late-request', decision: 'allow', permitId: 'late-permit' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'approval:cancel', requestId: 'late-request' }))
    expect(service.getApproval('call')).toBeUndefined()
  })

  it('distinguishes manual/full/rule routes without attributing a model invocation', async () => {
    for (const mode of ['ask', 'allow', 'auto'] as const) {
      const { binding, send } = setup(mode)
      if (mode === 'auto') send.mockResolvedValueOnce({ requestId: 'rule', decision: 'allow', permitId: 'permit' })
      const service = new ApprovalService(binding, vi.fn())
      await service.review(call)
      const snapshot = service.getDebugSnapshot()
      expect(snapshot.records[0].route).toBe(mode === 'ask' ? 'manual' : mode === 'allow' ? 'full-allow' : 'rule')
      expect(snapshot.state.reviews).toBe(0)
      expect(snapshot.records[0].modelDecision).toBeUndefined()
    }
  })

  it('retains actual model steps, investigation traffic and the allow reason separately from backend rejection', async () => {
    const { binding, send } = setup()
    send.mockImplementation(async message => message.type === 'approval:prepare'
      ? { requestId: 'request', decision: 'review', environment: { tabId: 1 } }
      : { decision: 'deny', reason: '页面已变化' })
    const service = new ApprovalService(binding, async (_config, _prompt, _request, _signal, _send, trace) => {
      trace?.({ type: 'step-start', stepNumber: 0, messages: [{ role: 'user', content: 'exact request' }], model: { model: 'review-model', provider: 'provider' }, at: 1 })
      trace?.({ type: 'investigation-start', id: 'read', command: 'cat /tmp/task.sh', at: 2 })
      trace?.({ type: 'investigation-result', id: 'read', result: { stdout: 'echo safe', exitCode: 0 }, at: 3 })
      trace?.({ type: 'step-end', stepNumber: 0, text: 'public output', toolCalls: [{ toolName: 'bash' }], toolResults: [{ output: 'echo safe' }], finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 2 }, at: 4 })
      return { decision: 'allow', reason: '脚本符合用户请求', inputTokens: 10, outputTokens: 2 }
    })
    expect(await service.review(call)).toMatchObject({ type: 'denied' })
    const record = service.getDebugSnapshot().records[0]
    expect(record.modelDecision).toEqual({ decision: 'allow', reason: '脚本符合用户请求' })
    expect(record.backendDecision).toEqual({ decision: 'deny', reason: '页面已变化' })
    expect(record.steps[0]).toMatchObject({ stepNumber: 0, text: 'public output', messages: [{ role: 'user', content: 'exact request' }] })
    expect(record.investigations[0]).toMatchObject({ command: 'cat /tmp/task.sh', result: { stdout: 'echo safe', exitCode: 0 } })
    expect(JSON.stringify(record)).not.toContain('permit')
  })

  it('marks diagnostic runs and revokes approvals without executing or changing current permissions', async () => {
    const { binding, send } = setup('ask')
    send.mockImplementation(async message => message.type === 'approval:prepare'
      ? { requestId: 'diagnostic-request', decision: 'review', environment: { tabId: 1 } }
      : { decision: 'allow', permitId: 'diagnostic-permit' })
    const service = new ApprovalService(binding, async () => ({ decision: 'allow', reason: '只读查询' }))
    await service.testApproval('cat /tmp/task.sh')
    const snapshot = service.getDebugSnapshot()
    expect(snapshot.permissionMode).toBe('ask')
    expect(snapshot.records[0]).toMatchObject({ diagnostic: true, mode: 'auto', modelDecision: { decision: 'allow', reason: '只读查询' }, execution: { status: 'not-started' } })
    expect(send.mock.calls.find(([message]) => message.type === 'approval:prepare')?.[0]).toMatchObject({ mode: 'auto', diagnostic: true })
    expect(send).toHaveBeenCalledWith({ type: 'approval:cancel', requestId: 'diagnostic-request' })
    expect(send.mock.calls.some(([message]) => message.type === 'tool:bash')).toBe(false)
  })

  it('does not resurrect an active run after debug history is cleared', async () => {
    const { binding } = setup()
    let resolve!: (value: { decision: 'allow'; reason: string }) => void
    const runner = vi.fn(() => new Promise<{ decision: 'allow'; reason: string }>(done => { resolve = done }))
    const service = new ApprovalService(binding, runner)
    const pending = service.review(call)
    await vi.waitFor(() => expect(runner).toHaveBeenCalled())
    expect(service.getDebugSnapshot().records).toHaveLength(1)
    service.clearDebugHistory()
    resolve({ decision: 'allow', reason: '完成调查' })
    await pending
    service.beginExecution('call')
    await service.finish('call', '实际执行失败')
    expect(service.getDebugSnapshot().records).toEqual([])
  })

  it('tracks execution start/end and errors without claiming a successful effect', async () => {
    const { binding } = setup('allow')
    const service = new ApprovalService(binding, vi.fn())
    await service.review(call)
    service.beginExecution('call')
    expect(service.getDebugSnapshot().records[0].execution.status).toBe('running')
    await service.finish('call', '目标已不存在')
    expect(service.getDebugSnapshot().records[0].execution).toMatchObject({ status: 'finished', error: '目标已不存在' })
  })
})
