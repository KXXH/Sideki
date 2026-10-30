// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApprovalDebugSnapshot } from '../../src/shared/approval-debug'

const { inspector } = vi.hoisted(() => ({ inspector: { current: null as null | (() => Record<string, unknown>) } }))
vi.mock('../../src/sidepanel/hooks/useSidekickChat', () => ({ sessionSnapshotRef: inspector }))
import ApprovalDebugPanel from '../../src/sidepanel/components/ApprovalDebugPanel'

let root: Root
let container: HTMLDivElement
let snapshot: ApprovalDebugSnapshot
let getDebug: ReturnType<typeof vi.fn>
let clearDebug: ReturnType<typeof vi.fn>
let testApproval: ReturnType<typeof vi.fn>
const now = 1000

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  snapshot = {
    sessionId: 'session', permissionMode: 'auto', model: { model: 'review-model', protocol: 'responses', endpoint: 'https://example.test/v1', reasoning: 'low' },
    instructions: 'Independent reviewer system instructions', state: { status: 'idle', reviews: 1, inputTokens: 90, outputTokens: 20, elapsedMs: 200 },
    limits: { maxRecords: 30, maxChars: 1000000, currentChars: 1000 },
    records: [{
      id: 'run', sessionId: 'session', turnId: 'turn', toolCallId: 'call', toolName: 'bash', mode: 'auto', diagnostic: false, route: 'model',
      model: { model: 'review-model', protocol: 'responses', endpoint: '', reasoning: 'low' }, args: { command: 'bash /tmp/task.sh' },
      startedAt: now, finishedAt: now + 200, elapsedMs: 200, context: '{"userMessages":[{"text":"只读取价格"}]}',
      investigations: [], modelDecision: { decision: 'deny', reason: '用户未授权提交订单' }, backendDecision: { decision: 'deny', reason: '用户未授权提交订单' },
      execution: { status: 'not-started' }, usage: { inputTokens: 90, outputTokens: 20 },
      steps: [{ stepNumber: 0, startedAt: now, finishedAt: now + 100, messages: [{ role: 'user', content: '只读取价格' }],
        tools: { bash: { inputSchema: { command: 'string' } } }, text: '',
        toolCalls: [{ toolName: 'bash', input: { command: 'cat /tmp/task.sh' } }], toolResults: [{ output: 'click 提交订单' }], finishReason: 'tool-calls' },
      { stepNumber: 1, startedAt: now + 100, finishedAt: now + 200,
        messages: [{ role: 'tool', content: 'click 提交订单' }], text: '{"decision":"deny","reason":"用户未授权提交订单"}', finishReason: 'stop' }],
    }],
  }
  getDebug = vi.fn(async () => structuredClone(snapshot))
  clearDebug = vi.fn(async () => { snapshot.records = [] })
  testApproval = vi.fn(async () => {})
  inspector.current = () => ({ sessionId: 'session', getApprovalDebug: getDebug, clearApprovalDebug: clearDebug, testApproval })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})

afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); inspector.current = null })
async function render() { await act(async () => root.render(<ApprovalDebugPanel sessionId="session" />)) }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}

it('shows the actual reviewer model rounds, tool calls, results and context separately', async () => {
  await render()
  expect(container.textContent).toContain('第 1 轮模型调用')
  expect(container.textContent).toContain('第 2 轮模型调用')
  expect(container.textContent).toContain('cat /tmp/task.sh')
  expect(container.textContent).toContain('click 提交订单')
  await click('上下文')
  expect(container.textContent).toContain('Independent reviewer system instructions')
  expect(container.textContent).toContain('只读取价格')
  expect(container.textContent).toContain('inputSchema')
  await click('最终输出')
  expect(container.textContent).toContain('用户未授权提交订单')
  expect(container.textContent).toContain('not-started')
})

it('does not show another conversation\'s context when Dev selection differs', async () => {
  inspector.current = () => ({ sessionId: 'another-session', getApprovalDebug: getDebug })
  await render()
  expect(container.textContent).toContain('请先在 Chat 中打开所选会话')
  expect(getDebug).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('Independent reviewer system instructions')
})

it('clears only inspector records and leaves the approval runner alone', async () => {
  await render(); await click('清空')
  expect(clearDebug).toHaveBeenCalledOnce()
  expect(testApproval).not.toHaveBeenCalled()
  expect(container.textContent).toContain('暂无记录')
})

it('passes diagnostic input to the reviewer test API instead of the Dev executor', async () => {
  const sendMessage = vi.fn()
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
  await render()
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'bash /tmp/task.sh')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('仅审批，不执行')
  expect(testApproval).toHaveBeenCalledWith('bash /tmp/task.sh')
  expect(sendMessage).not.toHaveBeenCalled()
  expect(container.textContent).toContain('待测命令未执行')
})

it('labels non-model routes explicitly rather than fabricating an agent trajectory', async () => {
  snapshot.records[0].route = 'rule'
  snapshot.records[0].steps = []
  snapshot.records[0].modelDecision = undefined
  await render()
  expect(container.textContent).toContain('读取规则放行，未启动审批 Agent')
  expect(container.textContent).not.toContain('第 1 轮模型调用')
})

it('refreshes an active trajectory while the inspector is open', async () => {
  snapshot.records[0].steps = []
  await render()
  expect(container.textContent).toContain('等待第一轮模型调用')
  snapshot.records[0].steps.push({ stepNumber: 0, startedAt: now, messages: [], text: '正在检查脚本引用' })
  await act(async () => vi.advanceTimersByTime(2000))
  expect(container.textContent).toContain('正在检查脚本引用')
})
