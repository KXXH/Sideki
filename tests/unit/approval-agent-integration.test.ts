import { afterEach, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { createAgent } from '../../src/shared/agent'
import { ApprovalService } from '../../src/shared/approval-service'
import * as memoryStorage from '../../src/shared/memory-storage'
import type { ApiConfig } from '../../src/shared/types'
import { callItem, responseJson, textItem } from '../fixtures/responses'

afterEach(() => vi.restoreAllMocks())

function streamReply(delta: unknown, finishReason: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}

it.each(['allow', 'deny'] as const)('gates actual SDK execution on %s and returns denials to the main model', async decision => {
  vi.spyOn(memoryStorage, 'getGlobalMemory').mockResolvedValue('')
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(streamReply({ tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: 'test_action', arguments: '{"value":"target"}' } }] }, 'tool_calls'))
    .mockResolvedValueOnce(streamReply({ content: 'Finished' }, 'stop'))
  const cfg = {
    endpoint: 'https://api.test/v1', apiKey: 'test-key', model: 'test', contextWindow: 100_000,
    systemPrompt: '', reasoningEffort: '', securityLevel: 'strict', maxToolRounds: 5,
    yoloMode: false, devMode: false, accentColor: 'indigo', fontFamily: 'sans', fontSize: 'default', activeProfileId: '', profiles: [],
  } as ApiConfig
  const send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === 'approval:prepare') return { requestId: 'review', decision: 'review', environment: { tabId: 1 } }
    if (message.type === 'approval:complete') return { decision: message.decision, reason: message.reason, permitId: 'permit' }
    return undefined
  })
  const service = new ApprovalService({
    getConfig: () => cfg, getSessionId: () => 'session', getMode: () => 'auto',
    getMessages: () => [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'check the target' }] }],
    sendMessage: send,
  }, async () => ({ decision, reason: decision === 'deny' ? '用户未授权这次操作' : '符合请求' }))
  const execute = vi.fn(async () => 'done')
  const agent = await createAgent(cfg, { current: null }, { current: [] }, undefined, { current: 'session' }, undefined, {
    test_action: tool({ description: 'test operation', inputSchema: z.object({ value: z.string() }), execute }),
  }, undefined, undefined, 'chat', undefined, service)
  const result = await agent.stream({ prompt: 'check the target' })
  expect(await result.text).toBe('Finished')
  expect(execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0)
  const followup = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
  if (decision === 'deny') expect(JSON.stringify(followup.messages)).toContain('用户未授权这次操作')
  else expect(send).toHaveBeenCalledWith({ type: 'approval:finish', requestId: 'review' })
})

it('records investigation and ends immediately on the terminal approval tool without a summary call', async () => {
  const jsonReply = (message: unknown, finishReason: string) => new Response(JSON.stringify({
    id: 'response', created: 1, model: 'review-test', choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), { headers: { 'content-type': 'application/json' } })
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonReply({ role: 'assistant', content: '先检查脚本。', tool_calls: [{ id: 'read-script', type: 'function', function: { name: 'bash', arguments: '{"command":"cat /tmp/task.sh"}' } }] }, 'tool_calls'))
    .mockResolvedValueOnce(jsonReply({ role: 'assistant', content: null, tool_calls: [{ id: 'final-decision', type: 'function', function: { name: 'submitApproval', arguments: '{"decision":"allow","reason":"符合查询任务"}' } }] }, 'tool_calls'))
  const cfg = { endpoint: 'https://api.test/v1', apiKey: 'private-key', model: 'review-test', contextWindow: 100_000, reasoningEffort: 'high' } as ApiConfig
  const send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === 'approval:prepare') return { requestId: 'review-request', decision: 'review', environment: { tabId: 1 } }
    if (message.type === 'approval:bash') return { stdout: 'echo safe', stderr: '', exitCode: 0 }
    if (message.type === 'approval:complete') return { decision: 'allow', permitId: 'opaque-permit' }
    return undefined
  })
  const service = new ApprovalService({ getConfig: () => cfg, getSessionId: () => 'session', getMode: () => 'auto', getMessages: () => [{ id: 'user', role: 'user', parts: [{ type: 'text', text: '检查脚本，不要修改文件' }] }], sendMessage: send })
  expect(await service.review({ toolCallId: 'main-call', toolName: 'bash', input: { command: 'bash /tmp/task.sh' } })).toEqual({ type: 'approved' })
  const snapshot = service.getDebugSnapshot()
  const record = snapshot.records[0]
  expect(record.steps).toHaveLength(2)
  expect(record.steps[0].messages).toEqual([{ role: 'user', content: record.context }])
  expect(record.steps[0].system).toBe(snapshot.instructions)
  expect(record.steps[0].toolCalls).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'bash', input: { command: 'cat /tmp/task.sh' } })]))
  expect(JSON.stringify(record.steps[1].messages)).toContain('echo safe')
  expect(record.steps[1]).toMatchObject({ finishReason: 'tool-calls' })
  expect(record.steps[1].toolCalls).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'submitApproval', input: { decision: 'allow', reason: '符合查询任务' } })]))
  expect(record.investigations[0]).toMatchObject({ command: 'cat /tmp/task.sh', result: { stdout: 'echo safe', stderr: '', exitCode: 0 } })
  expect(record.modelDecision).toEqual({ decision: 'allow', reason: '符合查询任务' })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
  expect(body.response_format).toBeUndefined()
  expect(body.tool_choice).toBe('required')
  expect(body.tools.map((entry: { function: { name: string } }) => entry.function.name)).toContain('submitApproval')
  expect(JSON.stringify(snapshot)).not.toMatch(/private-key|opaque-permit/)
})

function approvalReply(message: unknown, finishReason = 'tool_calls') {
  return new Response(JSON.stringify({ id: 'review', created: 1, model: 'review-test', choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'content-type': 'application/json' } })
}
function finalCall(input: unknown, id = 'decision') {
  return { id, type: 'function', function: { name: 'submitApproval', arguments: JSON.stringify(input) } }
}
function reviewerService(apiProtocol: ApiConfig['apiProtocol'] = 'chat-completions') {
  const cfg = { endpoint: 'https://api.test/v1', apiKey: 'test', model: 'review-test', contextWindow: 100_000, apiProtocol } as ApiConfig
  const send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === 'approval:prepare') return { requestId: 'review-request', decision: 'review', environment: { tabId: 1 } }
    if (message.type === 'approval:bash') return { stdout: 'allow\n', stderr: '', exitCode: 0 }
    if (message.type === 'approval:complete') return { decision: message.decision, reason: message.reason, permitId: 'permit' }
    return undefined
  })
  const service = new ApprovalService({ getConfig: () => cfg, getSessionId: () => 'session', getMode: () => 'auto', getMessages: () => [{ id: 'u', role: 'user', parts: [{ type: 'text', text: '点击个人中心' }] }], sendMessage: send })
  return { service, send, call: { toolCallId: 'main', toolName: 'click', input: { target: '[5]' } } }
}

function reviewerReply(protocol: ApiConfig['apiProtocol'], calls: ReturnType<typeof finalCall>[]) {
  return protocol === 'responses'
    ? responseJson(calls.map(call => callItem(call.function.name, JSON.parse(call.function.arguments), call.id)))
    : approvalReply({ role: 'assistant', content: null, tool_calls: calls })
}

it.each(['chat-completions', 'responses'] as const)('retains %s approval usage when the final response violates the decision protocol', async protocol => {
  vi.mocked(chrome.runtime.sendMessage).mockClear()
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reviewerReply(protocol, [{ id: 'inspect', type: 'function', function: { name: 'bash', arguments: '{"command":"page-content"}' } }]))
    .mockResolvedValueOnce(protocol === 'responses' ? responseJson([textItem('允许')]) : approvalReply({ role: 'assistant', content: '允许' }, 'stop'))
  const { service, call } = reviewerService(protocol)
  expect(await service.review(call)).toMatchObject({ type: 'denied' })
  const expected = protocol === 'responses' ? { inputTokens: 2000, outputTokens: 200 } : { inputTokens: 20, outputTokens: 20 }
  expect(service.state).toMatchObject({ reviews: 1, ...expected })
  const record = service.getDebugSnapshot().records[0]
  expect(record.usage).toMatchObject(expected)
  expect(record.steps[1].usage).toMatchObject(protocol === 'responses' ? { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, reasoningTokens: 30 } : { inputTokens: 10, outputTokens: 10 })
  expect(record.steps[1].error).toBeTruthy()
  const usage = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([message]) => message.type === 'usage:record').map(([message]) => message.event)
  expect(usage).toHaveLength(2)
  expect(usage.every(event => event.session === 'session' && event.source === 'approval')).toBe(true)
  expect(usage.reduce((sum, event) => sum + event.tokens.input, 0)).toBe(expected.inputTokens)
  expect(service.getApproval(call.toolCallId)).toBeUndefined()
})

it.each(['chat-completions', 'responses'] as const)('keeps the %s approval prefix identical across different pending calls', async protocol => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reviewerReply(protocol, [finalCall({ decision: 'allow', reason: '符合用户请求' })]))
  const { service, call } = reviewerService(protocol)
  expect(await service.review(call)).toEqual({ type: 'approved' })
  expect(await service.review({ ...call, toolCallId: 'next', input: { target: '#another' } })).toEqual({ type: 'approved' })
  expect(fetch).toHaveBeenCalledTimes(2)
  const [first, second] = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
  expect(second.tools).toEqual(first.tools)
  expect(first.tools.map((entry: { name?: string; function?: { name: string } }) => entry.function?.name ?? entry.name)).toEqual(['bash', 'submitApproval'])
  const messages = (body: typeof first) => protocol === 'responses' ? body.input : body.messages
  const firstMessages = messages(first), secondMessages = messages(second)
  const userIndex = firstMessages.findIndex((entry: { role: string }) => entry.role === 'user')
  expect(userIndex).toBeGreaterThanOrEqual(0)
  expect(second.instructions).toEqual(first.instructions)
  expect(secondMessages.slice(0, userIndex)).toEqual(firstMessages.slice(0, userIndex))
  expect(JSON.stringify({ instructions: first.instructions, messages: firstMessages.slice(0, userIndex) })).toContain("Sideki's independent operation approval reviewer")
  const firstMaterial = JSON.stringify(firstMessages[userIndex]), secondMaterial = JSON.stringify(secondMessages[userIndex])
  expect(firstMaterial).toContain('[5]')
  expect(secondMaterial).toContain('#another')
  expect(secondMaterial).not.toContain('[5]')
  expect(firstMaterial.slice(0, firstMaterial.indexOf('pendingCall'))).toBe(secondMaterial.slice(0, secondMaterial.indexOf('pendingCall')))
})

it.each(['allow', 'deny'] as const)('accepts a single terminal %s decision in one model call', async decision => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(approvalReply({ role: 'assistant', content: null, tool_calls: [finalCall({ decision, reason: '审批说明' })] }))
  const { service, send, call } = reviewerService()
  expect(await service.review(call)).toMatchObject({ type: decision === 'allow' ? 'approved' : 'denied' })
  expect(fetch).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith({ type: 'approval:complete', requestId: 'review-request', decision, reason: '审批说明' })
})

it.each(['**允许**，用户已授权。', '{"decision":"allow","reason":"符合请求"}'])('does not interpret prose or JSON text as a decision: %s', async text => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(approvalReply({ role: 'assistant', content: text }, 'stop'))
  const { service, send, call } = reviewerService()
  expect(await service.review(call)).toMatchObject({ type: 'denied', reason: expect.stringContaining('审批未完成：') })
  expect(send.mock.calls.some(([message]) => message.type === 'approval:complete')).toBe(false)
  expect(service.getApproval('main')).toBeUndefined()
  expect(service.getDebugSnapshot().records[0].steps[0].text).toBe(text)
})

it('does not mistake echo allow and a natural-language conclusion for a submitted decision', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(approvalReply({ role: 'assistant', content: null, tool_calls: [{ id: 'echo', type: 'function', function: { name: 'bash', arguments: '{"command":"echo allow"}' } }] }))
    .mockResolvedValueOnce(approvalReply({ role: 'assistant', content: '**允许**，点击目标与用户要求一致。' }, 'stop'))
  const { service, send, call } = reviewerService()
  expect(await service.review(call)).toMatchObject({ type: 'denied', reason: expect.stringContaining('submitApproval') })
  expect(send.mock.calls.some(([message]) => message.type === 'approval:complete')).toBe(false)
  expect(service.getDebugSnapshot().records[0].investigations[0].result).toMatchObject({ stdout: 'allow\n' })
})

it.each([
  [finalCall({ decision: 'maybe', reason: '不确定' })],
  [finalCall({ decision: 'allow', reason: ' ' })],
  [finalCall({ decision: 'allow', reason: '通过' }, 'first'), finalCall({ decision: 'deny', reason: '拒绝' }, 'second')],
])('rejects malformed or conflicting terminal submissions', async (...toolCalls) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(approvalReply({ role: 'assistant', content: null, tool_calls: toolCalls }))
  const { service, send, call } = reviewerService()
  expect(await service.review(call)).toMatchObject({ type: 'denied' })
  expect(service.getApproval('main')).toBeUndefined()
  expect(send.mock.calls.some(([message]) => message.type === 'approval:complete')).toBe(false)
})

it.each(['chat-completions', 'responses'] as const)('preserves %s tool schemas while forcing the final decision after four investigations', async protocol => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  for (let i = 0; i < 4; i++) fetch.mockResolvedValueOnce(reviewerReply(protocol, [{ id: `read-${i}`, type: 'function', function: { name: 'bash', arguments: '{"command":"page-content"}' } }]))
  fetch.mockResolvedValueOnce(reviewerReply(protocol, [finalCall({ decision: 'allow', reason: '目标已核实' })]))
  const { service, call } = reviewerService(protocol)
  expect(await service.review(call)).toEqual({ type: 'approved' })
  expect(fetch).toHaveBeenCalledTimes(5)
  const last = JSON.parse(fetch.mock.calls[4][1]?.body as string)
  expect(last.tool_choice).toEqual(protocol === 'responses' ? { type: 'function', name: 'submitApproval' } : { type: 'function', function: { name: 'submitApproval' } })
  const first = JSON.parse(String(fetch.mock.calls[0][1]?.body))
  for (const [, init] of fetch.mock.calls) expect(JSON.parse(String(init?.body)).tools).toEqual(first.tools)
  const steps = service.getDebugSnapshot().records[0].steps
  expect(steps[4].tools).toEqual(steps[0].tools)
  expect(steps[4].system).toEqual(steps[0].system)
})

it('blocks further Bash investigation when a provider mixes it into the forced final decision', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  const investigation = (id: string) => ({ id, type: 'function', function: { name: 'bash', arguments: '{"command":"page-content"}' } })
  for (let i = 0; i < 4; i++) fetch.mockResolvedValueOnce(reviewerReply('chat-completions', [investigation(`read-${i}`)]))
  fetch.mockResolvedValueOnce(reviewerReply('chat-completions', [investigation('forbidden-read'), finalCall({ decision: 'allow', reason: '通过' })]))
  const { service, send, call } = reviewerService()
  expect(await service.review(call)).toMatchObject({ type: 'denied' })
  expect(send.mock.calls.filter(([message]) => message.type === 'approval:bash')).toHaveLength(4)
  expect(send.mock.calls.some(([message]) => message.type === 'approval:complete')).toBe(false)
  expect(service.getApproval(call.toolCallId)).toBeUndefined()
})
