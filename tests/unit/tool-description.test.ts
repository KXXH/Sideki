import { describe, expect, it } from 'vitest'
import { cleanToolDescription, streamedDescription, toolDescription } from '../../src/shared/tool-description'
import { collectToolActivities, publishToolActivities } from '../../src/shared/kernel/tool-activity'
import { createAgentTools } from '../../src/shared/tools'
import type { UIMessage } from 'ai'
import { vi } from 'vitest'

describe('streamed tool descriptions', () => {
  it('waits for the closing quote, without waiting for the command or object', () => {
    const raw = '{"description":"提取商品价格","command":"js document.'
    const end = raw.indexOf('","command"')
    for (let i = 0; i <= end; i++) expect(streamedDescription(raw.slice(0, i))).toBeNull()
    expect(streamedDescription(raw.slice(0, end + 1))).toBe('提取商品价格')
    expect(streamedDescription(raw)).toBe('提取商品价格')
    expect(toolDescription({ state: 'input-streaming', input: { description: '提取商品' } })).toBeNull()
  })

  it('handles escapes, nested fields, command-first order, and literal JSON in scripts', () => {
    const description = '读取"价格"和\\库存'
    const prefix = JSON.stringify({ command: 'js "description: fake"', nested: { description: 'wrong' }, description }).slice(0, -1)
    expect(streamedDescription(prefix)).toBe(description)
    expect(streamedDescription('{"command":"description: \\"not a title')).toBeNull()
    expect(streamedDescription('{"nested":{"description":"wrong"},"description":"right"')).toBe('right')
    expect(streamedDescription('{"description":"broken\\u0"')).toBeNull()
    expect(toolDescription({ state: 'output-available', input: { description } })).toBe(description)
  })

  it('bounds and normalizes text without interpreting markup', () => {
    expect(cleanToolDescription('  读取\n 页面\t内容  ')).toBe('读取 页面 内容')
    expect(cleanToolDescription('x'.repeat(200))?.length).toBe(80)
    expect(cleanToolDescription(' ')).toBeNull()
    expect(cleanToolDescription({ text: 'bad' })).toBeNull()
  })

  it('offers description first on every built-in schema while accepting legacy arguments', async () => {
    const tools = createAgentTools()
    expect(Object.keys(tools)).toHaveLength(15)
    for (const t of Object.values(tools)) {
      const schema = t.inputSchema as unknown as { shape: Record<string, unknown> }
      expect(Object.keys(schema.shape)[0]).toBe('description')
    }
    const schema = tools.bash.inputSchema as unknown as { parse(input: unknown): unknown }
    expect(schema.parse({ command: 'pwd' })).toEqual({ command: 'pwd' })
    // Reason: an overlong display label must not reject an otherwise valid action.
    expect(() => schema.parse({ command: 'pwd', description: 'x'.repeat(200) })).not.toThrow()
  })
})

function messages(state: string, rawInput?: string): UIMessage[] {
  return [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'read' }] }, {
    id: 'assistant', role: 'assistant', parts: [{
      type: 'dynamic-tool', toolName: 'bash', toolCallId: 'call', state,
      input: { description: '读取标题', command: 'js document.title' }, rawInput,
    } as UIMessage['parts'][number]],
  }]
}

describe('kernel activity publication', () => {
  it('only publishes live calls from this turn, including preparation after its description closes', () => {
    expect(collectToolActivities({ status: 'streaming', messages: messages('input-streaming', '{"description":"读取') })).toEqual([])
    expect(collectToolActivities({ status: 'streaming', messages: messages('input-streaming', '{"description":"读取标题",') })).toEqual([
      { id: 'assistant:call', description: '读取标题', phase: 'preparing' },
    ])
    expect(collectToolActivities({ status: 'streaming', messages: messages('input-available') })[0]?.phase).toBe('executing')
    expect(collectToolActivities({ status: 'ready', messages: messages('input-available') })).toEqual([])
    expect(collectToolActivities({ status: 'streaming', messages: messages('output-error') })).toEqual([])
    expect(collectToolActivities({ status: 'streaming', messages: [...messages('input-available'), { id: 'next', role: 'user', parts: [] }] })).toEqual([])
  })

  it('deduplicates command tokens, publishes completion and detaches without relying on a panel', () => {
    let listener = () => {}
    const detach = vi.fn()
    const state = { status: 'streaming', messages: messages('input-available'), subscribe: (cb: () => void) => { listener = cb; return detach } }
    const send = vi.fn().mockResolvedValue({ ok: true })
    const unsubscribe = publishToolActivities(state, () => 'session', send)
    listener()
    state.messages = messages('input-available')
    listener()
    expect(send).toHaveBeenCalledTimes(1)
    state.status = 'ready'
    listener()
    expect(send).toHaveBeenLastCalledWith({ type: 'tab-lock:activity', sessionId: 'session', activities: [] })
    unsubscribe()
    expect(detach).toHaveBeenCalledOnce()
  })
})
