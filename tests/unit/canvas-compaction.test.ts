import { describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { compactContext } from '../../src/shared/ai-provider'
import type { ApiConfig } from '../../src/shared/types'

vi.mock('ai', async importOriginal => ({ ...await importOriginal<typeof import('ai')>(), generateText: vi.fn().mockResolvedValue({ text: 'summary' }) }))

describe('canvas state in compaction', () => {
  it('retains the latest three snapshots beyond ordinary text truncation and keeps the latest revision per canvas', async () => {
    const snapshot = (canvasId: string, modelRevision: number, modelContent: string) => ({ canvasId, modelRevision, modelContent, title: canvasId, path: `/viz/${canvasId}.html` })
    const selection = 'x'.repeat(4000)
    await compactContext({ apiKey: 'test', endpoint: 'https://example.com/v1', model: 'test' } as ApiConfig, 's', [
      { role: 'user', content: 'old', canvasContext: [snapshot('a', 1, 'old'), snapshot('b', 1, 'b')] },
      { role: 'user', content: 'long text '.repeat(1000), canvasContext: [snapshot('c', 1, 'c'), snapshot('a', 2, selection), snapshot('d', 1, 'd')] },
    ])
    const args = vi.mocked(generateText).mock.calls[0][0]
    const messages = args.messages as Array<{ content: string }>
    expect(messages[1].content.length).toBeLessThan(2100)
    const states = JSON.parse(messages.at(-1)!.content.split('\n').slice(1).join('\n'))
    expect(states.map((s: { canvasId: string }) => s.canvasId)).toEqual(['c', 'a', 'd'])
    expect(states[1]).toMatchObject({ modelRevision: 2, modelContent: selection })
  })
})
