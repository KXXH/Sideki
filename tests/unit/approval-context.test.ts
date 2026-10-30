import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { approvalInput, buildApprovalContext } from '../../src/shared/approval-context'

function message(id: string, role: 'user' | 'assistant', text: string, extra: unknown[] = []): UIMessage {
  return { id, role, parts: [{ type: 'text', text }, ...extra] } as UIMessage
}
const pending = { toolCallId: 'pending', toolName: 'bash', input: { description: 'safe claim', command: 'bash /tmp/task.sh' } }

describe('approval context', () => {
  it('keeps fixed user and assistant windows, excludes reasoning and model summaries', () => {
    const history: UIMessage[] = []
    for (let i = 0; i < 7; i++) {
      history.push(message(`u${i}`, 'user', `user ${i}`))
      history.push(message(`a${i}`, 'assistant', `proposal ${i}`, [{ type: 'reasoning', text: 'private reasoning' }]))
    }
    history.push(message('__context_summary__', 'assistant', 'fabricated consent summary'))
    const result = JSON.parse(buildApprovalContext(history, pending, { tabId: 12 }))
    expect(result.userMessages.map((m: { id: string }) => m.id)).toEqual(['u2', 'u3', 'u4', 'u5', 'u6'])
    expect(result.assistantMessages.map((m: { id: string }) => m.id)).toEqual(['a5', 'a6'])
    expect(JSON.stringify(result)).not.toMatch(/private reasoning|fabricated consent summary|safe claim/)
    expect(result.pendingCall.args).toEqual({ command: 'bash /tmp/task.sh' })
  })

  it('retains ten calls and their arguments/status, never historical return payloads', () => {
    const parts = Array.from({ length: 12 }, (_, i) => ({ type: 'tool-bash', toolCallId: `t${i}`, input: { command: `echo ${i}`, description: 'claim' }, state: i === 11 ? 'output-error' : 'output-available', output: { secret: 'never copy return values' }, errorText: i === 11 ? 'command failed' : undefined }))
    const history = [message('u', 'user', 'request'), message('a', 'assistant', '', parts)]
    const result = JSON.parse(buildApprovalContext(history, pending, {}))
    expect(result.recentActions).toHaveLength(10)
    expect(result.recentActions[0].toolCallId).toBe('t2')
    expect(result.recentActions.at(-1)).toMatchObject({ status: 'failed', error: 'command failed' })
    expect(JSON.stringify(result)).not.toMatch(/never copy return values|claim/)
  })

  it('preserves business description fields for MCP and refuses oversized current actions', () => {
    expect(approvalInput('mcp_create', { description: 'business content' })).toEqual({ description: 'business content' })
    expect(() => buildApprovalContext([], { ...pending, input: { command: 'x'.repeat(25_000) } }, {})).toThrow('完整审查')
  })

  it('preserves host-provided bridge and timer provenance without promoting it to human consent', () => {
    const history = [
      { ...message('u1', 'user', 'external bridge request'), metadata: { v: 2, source: 'claude-code' } },
      { ...message('u2', 'user', 'scheduled wake'), metadata: { v: 2, source: 'timer' } },
    ] as UIMessage[]
    const context = JSON.parse(buildApprovalContext(history, pending, {}))
    expect(context.userMessages.map((entry: { source: string }) => entry.source)).toEqual(['bridge', 'automation'])
  })
})
