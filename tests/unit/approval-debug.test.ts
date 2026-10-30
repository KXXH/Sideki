import { expect, it } from 'vitest'
import { ApprovalDebugLog, approvalDebugModel, publicReviewMessages, type ApprovalDebugRecord } from '../../src/shared/approval-debug'
import type { ApiConfig } from '../../src/shared/types'

function record(id: string): ApprovalDebugRecord {
  return { id, sessionId: 'session', turnId: 'turn', toolCallId: id, toolName: 'bash', args: {}, mode: 'auto', diagnostic: false, route: 'model', model: { model: 'test', endpoint: '', protocol: 'chat-completions', reasoning: 'low' }, startedAt: 1, investigations: [], steps: [], execution: { status: 'not-started' } }
}

it('never exposes credentials in endpoint metadata or private reasoning in step inputs', () => {
  const model = approvalDebugModel({ endpoint: 'https://user:secret@example.com/v1?api_key=secret#token', model: 'user-model' } as ApiConfig)
  expect(model.endpoint).toBe('https://example.com/v1')
  const messages = publicReviewMessages([{ role: 'assistant', providerOptions: { token: 'private' }, content: [{ type: 'reasoning', text: 'private thought' }, { type: 'text', text: 'public output' }, { type: 'tool-call', toolCallId: 'call', toolName: 'bash', input: { command: 'cat /tmp/task.sh' } }] }])
  expect(JSON.stringify(messages)).not.toMatch(/private thought|secret|token/)
  expect(JSON.stringify(messages)).toContain('public output')
  expect(JSON.stringify(messages)).toContain('"omitted":true')
})

it('bounds record count and serialized size while keeping the newest run', () => {
  const log = new ApprovalDebugLog()
  for (let i = 0; i < 40; i++) log.add(record(String(i)))
  expect(log.snapshot('session').records).toHaveLength(30)
  for (let i = 40; i < 50; i++) {
    const value = record(String(i))
    value.context = 'x'.repeat(48_000)
    value.steps = Array.from({ length: 5 }, (_, stepNumber) => ({ stepNumber, startedAt: 1, messages: 'm'.repeat(80_000) }))
    log.add(value)
  }
  const snapshot = log.snapshot('session')
  expect(snapshot.limits.currentChars).toBeLessThanOrEqual(snapshot.limits.maxChars)
  expect(snapshot.records.at(-1)?.id).toBe('49')
  expect(snapshot.records.at(-1)?.steps).toHaveLength(5)
})

it('clear is session scoped and late active events cannot resurrect removed history', () => {
  const log = new ApprovalDebugLog()
  log.add(record('active'))
  log.add({ ...record('other'), sessionId: 'other-session' })
  log.clear('session')
  log.update('active', item => { item.finishedAt = 100 })
  expect(log.snapshot('session').records).toEqual([])
  expect(log.snapshot('other-session').records).toHaveLength(1)
})

it.each(['none', 'low', 'high', 'max', ''] as const)('reports the configured reviewer effort %s', reasoningEffort => {
  expect(approvalDebugModel({ model: 'review', reasoningEffort } as ApiConfig).reasoning).toBe(reasoningEffort)
})
