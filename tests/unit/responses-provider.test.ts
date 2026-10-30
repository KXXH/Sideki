import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText, streamText, stepCountIs, tool, jsonSchema, type ModelMessage } from 'ai'
import { createProvider, compactContext, generateTitle, sdkReasoningEffort } from '../../src/shared/ai-provider'
import { DEFAULT_CONFIG } from '../../src/sidepanel/default-config'
import { responseJson, responseStream, textItem, reasoningItem, plainReasoningItem, callItem, RESPONSES_USAGE, IMAGE, event, responseEvents } from '../fixtures/responses'
import { normalizeTokenUsage } from '../../src/shared/usage-middleware'
import type { LanguageModelV4Usage } from '@ai-sdk/provider'

const config = { ...DEFAULT_CONFIG, endpoint: 'https://api.openai.com/v1', apiKey: 'test-only-key', model: 'gpt-6-luna', apiProtocol: 'responses' as const, reasoningEffort: 'xhigh' as const, labBackendCompat: false }
const fetchMock = vi.fn<typeof fetch>()
const chromeMock = chrome
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('chrome', chromeMock); fetchMock.mockReset().mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).stream ? responseStream() : responseJson()); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const body = (i = 0) => JSON.parse(String(fetchMock.mock.calls[i][1]?.body))

describe('Responses request routing', () => {
  it.each(['https://custom.example/v1', 'https://custom.example/v1/responses', 'https://custom.example/v1/responses/'])('accepts base or complete Responses URLs: %s', async endpoint => {
    await generateText({ model: createProvider({ ...config, endpoint }), prompt: 'hello' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://custom.example/v1/responses')
  })

  it('accepts a complete Chat Completions URL without appending it twice', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: 'c', model: 'm', created: 0, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }))
    await generateText({ model: createProvider({ ...config, apiProtocol: 'chat-completions', endpoint: 'https://custom.example/v1/chat/completions/' }), prompt: 'hello' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://custom.example/v1/chat/completions')
  })
  it('uses /responses, native reasoning and local stateless history, with authentication and session identity', async () => {
    const result = await generateText({ model: createProvider(config, { sessionId: 'session-r' }), prompt: 'hello', reasoning: 'xhigh', maxOutputTokens: 128 })
    expect(result.text).toBe('OK')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-only-key')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-session-id')).toBe('session-r')
    expect(body()).toMatchObject({ model: config.model, store: false, max_output_tokens: 128, reasoning: { effort: 'xhigh', summary: 'auto' } })
    expect(body().include).toContain('reasoning.encrypted_content')
    for (const key of ['messages', 'stream_options', 'enable_thinking', 'reasoning_effort', 'previous_response_id', 'conversation', 'max_tokens']) expect(body()[key]).toBeUndefined()
  })
  it('keeps legacy configs on Chat Completions and serializes parameters independently', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: 'c', model: 'm', created: 0, choices: [{ index: 0, message: { role: 'assistant', content: 'legacy' }, finish_reason: 'stop' }] }))
    const legacy = { ...config, apiProtocol: undefined }
    expect((await generateText({ model: createProvider(legacy), prompt: 'hi' })).text).toBe('legacy')
    expect(fetchMock.mock.calls[0][0]).toContain('/chat/completions')
    expect(body().messages).toBeDefined()
    await generateText({ model: createProvider({ ...config, modelParams: { maxTokens: 512, topK: 10, minP: .1, repetitionPenalty: 1.2 } }), prompt: 'hi' })
    expect(body(1).max_output_tokens).toBe(512)
    expect(body(1).top_k).toBeUndefined()
    expect(body(1).min_p).toBeUndefined()
    expect(body(1).repetition_penalty).toBeUndefined()
  })
  it('keeps max effort native while auxiliary title and compaction calls explicitly use none', async () => {
    await generateText({ model: createProvider({ ...config, reasoningEffort: 'max' }), prompt: 'hi', reasoning: sdkReasoningEffort('max') })
    expect(body().reasoning.effort).toBe('max')
    await generateTitle(config, 's', 'hello', 'answer')
    await compactContext(config, 's', [{ role: 'user', content: 'old message' }])
    expect(body(1).reasoning.effort).toBe('none')
    expect(body(2).reasoning.effort).toBe('none')
    expect(body(1).store).toBe(false)
    expect(body(2).store).toBe(false)
  })
})

describe('Responses multimodal tool loop', () => {
  it('round-trips plain reasoning without encrypted content on an arbitrary endpoint and model', async () => {
    fetchMock.mockResolvedValueOnce(responseJson([plainReasoningItem(), callItem('inspect')])).mockResolvedValueOnce(responseJson([textItem('Done')]))
    const result = await generateText({ model: createProvider({ ...config, endpoint: 'https://custom.example/api', model: 'user-model' }), prompt: 'inspect', tools: { inspect: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => 'inspected' }) }, stopWhen: stepCountIs(3) })
    expect(result.steps[0].reasoningText).toBe('Inspecting the page directly.')
    expect(fetchMock.mock.calls[0][0]).toBe('https://custom.example/api/responses')
    expect(body(1).input.find((item: { type: string }) => item.type === 'reasoning')).toEqual({ type: 'reasoning', id: 'rs_plain', summary: [], content: [{ type: 'reasoning_text', text: 'Inspecting the page directly.' }] })
  })

  it('preserves old encrypted OpenAI history without mislabeling summary text as raw reasoning', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'A summary', providerOptions: { openai: { itemId: 'old-rs', reasoningEncryptedContent: 'old-encrypted' } } }, { type: 'text', text: 'old answer' }] },
      { role: 'user', content: 'continue' },
    ]
    const original = structuredClone(messages)
    await generateText({ model: createProvider(config), messages })
    const item = body().input.find((item: { type: string }) => item.type === 'reasoning')
    expect(item).toMatchObject({ id: 'old-rs', encrypted_content: 'old-encrypted', summary: [{ type: 'summary_text', text: 'A summary' }] })
    expect(item.content).toBeUndefined()
    expect(messages).toEqual(original)
  })

  it('passes tool screenshots as image output and preserves call IDs and encrypted reasoning on the next step', async () => {
    fetchMock.mockResolvedValueOnce(responseJson([reasoningItem(), callItem('screenshot')])).mockResolvedValueOnce(responseJson([textItem('I see the page.')]))
    const screenshot = tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }), execute: async () => JSON.stringify({ message: 'Captured', dataUrl: IMAGE }) })
    const result = await generateText({ model: createProvider(config), prompt: 'Look at the page', tools: { screenshot }, stopWhen: stepCountIs(3), reasoning: 'xhigh' })
    expect(result.text).toBe('I see the page.')
    expect(result.steps).toHaveLength(2)
    const next = body(1)
    expect(next.input.find((p: { type: string }) => p.type === 'function_call')).toMatchObject({ call_id: 'call_1', name: 'screenshot' })
    expect(next.input.find((p: { type: string }) => p.type === 'function_call_output')).toMatchObject({ call_id: 'call_1', output: [{ type: 'input_text', text: 'Captured' }, { type: 'input_image', image_url: IMAGE }] })
    expect(next.input.find((p: { type: string }) => p.type === 'reasoning')).toMatchObject({ encrypted_content: 'encrypted-rs_1' })
    expect(next.input.some((p: { type: string }) => p.type === 'item_reference')).toBe(false)
  })
  it('injects page images without mutating persisted messages or duplicating them across requests', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Summarize page' }]
    const original = structuredClone(messages)
    const model = createProvider(config, { pageImagesRef: { current: [IMAGE] } })
    await generateText({ model, messages }); await generateText({ model, messages })
    expect(messages).toEqual(original)
    for (let i = 0; i < 2; i++) expect(body(i).input[0].content.filter((p: { type: string }) => p.type === 'input_image')).toHaveLength(1)
  })
  it('honors the no-images setting for page images, attachments and screenshot results', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL(IMAGE) } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'screenshot', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'screenshot', output: { type: 'text', value: JSON.stringify({ dataUrl: IMAGE, message: 'Captured' }) } }] },
    ]
    await generateText({ model: createProvider({ ...config, supportsImages: false }, { pageImagesRef: { current: [IMAGE] } }), messages })
    expect(JSON.stringify(body())).not.toContain('input_image')
    expect(JSON.stringify(body())).not.toContain('base64')
  })
  it('keeps image-only user messages valid when switching to a text-only model', async () => {
    await generateText({ model: createProvider({ ...config, supportsImages: false }), messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL(IMAGE) } }] }] })
    expect(body().input[0].content).toEqual([{ type: 'input_text', text: '[image removed]' }])
  })
})

describe('Responses stream, errors and accounting', () => {
  it('ignores unknown notification events without losing plain reasoning or the final reply', async () => {
    const stream = responseEvents([plainReasoningItem(), textItem('OK')])
    fetchMock.mockResolvedValueOnce(new Response(event('response.some_future_notification', { extra: true }) + stream, { headers: { 'content-type': 'text/event-stream' } }))
    const result = streamText({ model: createProvider(config), prompt: 'hi' })
    expect(await result.reasoningText).toBe('Inspecting the page directly.')
    expect(await result.text).toBe('OK')
  })

  it('parses streamed text and reasoning and records cache and reasoning usage exactly once', async () => {
    fetchMock.mockResolvedValueOnce(responseStream([reasoningItem(), textItem('streamed')]))
    const result = streamText({ model: createProvider(config, { sessionId: 's' }), prompt: 'hi', reasoning: 'xhigh' })
    expect(await result.text).toBe('streamed')
    expect(await result.reasoningText).toBe('Checking the page.')
    const events = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([m]) => m.type === 'usage:record')
    expect(events).toHaveLength(1)
    expect(events[0][0].event.tokens).toEqual({ input: 1000, output: 100, read: 800, write: null, reasoning: 30 })
  })
  it('does not double-count cached input and keeps missing fields distinguishable from zero', () => {
    const usage = { inputTokens: {}, outputTokens: {}, raw: RESPONSES_USAGE } as LanguageModelV4Usage
    expect(normalizeTokenUsage(usage, 'responses')).toMatchObject({ input: 1000, read: 800, reasoning: 30 })
    expect(normalizeTokenUsage({ ...usage, raw: { input_tokens: 5, output_tokens: 1 } }, 'responses')).toEqual({ input: 5, output: 1, read: null, write: null, reasoning: null })
  })
  it('surfaces an HTTP authentication failure without retrying or recording a successful call', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 }))
    await expect(generateText({ model: createProvider(config), prompt: 'hi', maxRetries: 0 })).rejects.toThrow('Invalid API key')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([m]) => m.type === 'usage:record')).toHaveLength(0)
  })
  it('surfaces an early Responses error event rather than returning an empty successful reply', async () => {
    fetchMock.mockResolvedValueOnce(new Response(event('error', { sequence_number: 1, code: 'invalid_api_key', message: 'Unauthorized', param: null }), { headers: { 'content-type': 'text/event-stream' } }))
    const result = streamText({ model: createProvider(config), prompt: 'hi', maxRetries: 0 })
    await expect(result.text).rejects.toThrow()
  })
})

describe('Responses optional feature negotiation', () => {
  it('removes only explicitly rejected enhancements and remembers them for subsequent requests', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'unsupported_parameter', param: 'include', message: 'Unsupported parameter' } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: { param: 'reasoning.summary', message: 'reasoning.summary is not supported' } }, { status: 422 }))
    const model = createProvider(config)
    expect((await generateText({ model, prompt: 'hi', maxRetries: 0 })).text).toBe('OK')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(body(1).include).toBeUndefined()
    expect(body(1).reasoning.summary).toBe('auto')
    expect(body(2).reasoning).toEqual({ effort: 'xhigh' })
    await generateText({ model, prompt: 'next', maxRetries: 0 })
    expect(body(3).include).toBeUndefined()
    expect(body(3).reasoning).toEqual({ effort: 'xhigh' })
    for (let i = 0; i < 4; i++) expect(body(i).store).toBe(false)
  })

  it.each(['reasoning.effort', 'store', 'input', undefined])('does not silently remove required or user-selected settings: %s', async param => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'unsupported_parameter', param, message: 'Unsupported parameter' } }, { status: 400 }))
    await expect(generateText({ model: createProvider(config), prompt: 'hi', maxRetries: 0 })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
