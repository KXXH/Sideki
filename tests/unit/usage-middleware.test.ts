import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText, streamText, wrapLanguageModel } from 'ai'
import type { LanguageModelV4, LanguageModelV4Usage } from '@ai-sdk/provider'
import { createProvider } from '../../src/shared/ai-provider'
import { normalizeTokenUsage, usageMiddleware } from '../../src/shared/usage-middleware'
import type { ApiConfig } from '../../src/shared/types'

const cfg = { endpoint: 'https://api.example.com/v1', apiKey: 'secret', model: 'model-a', activeProfileId: 'p1',
  profiles: [{ id: 'p1', name: '服务商' }], labBackendCompat: false } as ApiConfig
const standard: LanguageModelV4Usage = {
  inputTokens: { total: 1000, noCache: 200, cacheRead: 800, cacheWrite: undefined },
  outputTokens: { total: 100, text: 70, reasoning: 30 },
}
const chromeMock = chrome

describe('usage normalization', () => {
  it('does not mistake the adapter defaults for reported zeroes', () => {
    expect(normalizeTokenUsage({ ...standard, raw: { prompt_tokens: 1000, completion_tokens: 100 } }))
      .toEqual({ input: 1000, output: 100, read: null, write: null, reasoning: null })
    expect(normalizeTokenUsage({ ...standard, raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } } }).read).toBe(0)
  })
  it('maps standard, DeepSeek and Anthropic-compatible cache fields', () => {
    expect(normalizeTokenUsage(standard).read).toBe(800)
    expect(normalizeTokenUsage({ ...standard, raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 700 } }).read).toBe(700)
    expect(normalizeTokenUsage({ ...standard, raw: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 } }))
      .toEqual({ input: 800, output: 30, read: 500, write: 200, reasoning: null })
  })
})

describe('provider integration', () => {
  beforeEach(() => { vi.stubGlobal('chrome', chromeMock); vi.mocked(chrome.runtime.sendMessage).mockClear() })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('records non-streaming calls with the originating identity and no credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 600, cache_creation_input_tokens: 200 },
    }), { headers: { 'content-type': 'application/json' } })))
    const model = createProvider(cfg, { sessionId: 'session-a' })
    const response = await generateText({ model, prompt: 'hello' })
    expect(response.text).toBe('OK')
    const [message] = vi.mocked(chrome.runtime.sendMessage).mock.calls.at(-1)!
    expect(message).toMatchObject({ type: 'usage:record', event: { session: 'session-a', provider: 'p1', name: '服务商', model: 'model-a', tokens: { input: 1000, output: 100, read: 600, write: 200 } } })
    expect(JSON.stringify(message)).not.toContain('secret')
    expect(JSON.stringify(message)).not.toContain('hello')
  })

  it('keeps approval transport identity separate from its parent chat accounting', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } } }))
    vi.stubGlobal('fetch', fetch)
    const onUsage = vi.fn()
    const model = createProvider(cfg, { sessionId: 'approval:request', usage: { sessionId: 'parent-chat', source: 'approval', onUsage } })
    await generateText({ model, prompt: 'review' })
    expect(new Headers(fetch.mock.calls[0][1].headers).get('x-session-id')).toBe('approval:request')
    const records = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([message]) => message.type === 'usage:record')
    expect(records).toHaveLength(1)
    expect(records[0][0].event).toMatchObject({ session: 'parent-chat', source: 'approval', tokens: { input: 100, output: 10, read: 80 } })
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ input: 100, output: 10, read: 80, write: null, reasoning: null })
  })

  it('requests streaming usage and counts the terminal usage once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":800}}}',
      'data: [DONE]', '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await streamText({ model: createProvider(cfg, { sessionId: 's' }), prompt: 'hello' }).text).toBe('OK')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream_options).toEqual({ include_usage: true })
    const calls = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([m]) => m.type === 'usage:record')
    expect(calls).toHaveLength(1)
    expect(calls[0][0].event.tokens).toMatchObject({ input: 1000, output: 100, read: 800, write: null })
  })

  it('keeps a successful response when persistence fails', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const base = { specificationVersion: 'v4', provider: 'test', modelId: 'm', supportedUrls: {},
      doGenerate: async () => ({ content: [{ type: 'text', text: 'OK' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: standard, warnings: [] }),
    } as unknown as LanguageModelV4
    const model = wrapLanguageModel({ model: base, middleware: usageMiddleware(cfg) })
    expect((await generateText({ model, prompt: 'hello' })).text).toBe('OK')
  })

  it('preserves completed-call usage when a later stream fails before its finish', async () => {
    const base = { specificationVersion: 'v4', provider: 'test', modelId: 'm', supportedUrls: {},
      doGenerate: async () => ({ content: [{ type: 'text', text: 'OK' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: standard, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.error(new Error('interrupted')) } }) }),
    } as unknown as LanguageModelV4
    const model = wrapLanguageModel({ model: base, middleware: usageMiddleware(cfg, 's1') })
    await model.doGenerate({ prompt: [] })
    const result = await model.doStream({ prompt: [] })
    await expect(result.stream.getReader().read()).rejects.toThrow('interrupted')
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([m]) => m.type === 'usage:record')).toHaveLength(1)
  })
})
