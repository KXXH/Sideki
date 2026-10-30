import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateText, streamText } from 'ai'
import { compactContext, sdkReasoningEffort, createProvider, createRetryFetch, generateTitle, relocateToolImages } from '../../src/shared/ai-provider'
import type { ApiConfig } from '../../src/shared/types'

const config = {} as ApiConfig
// Reason: backend compat is default-on; explicit false is the opt-out path.
const noCompatConfig = { labBackendCompat: false } as ApiConfig
const compatConfig = { labBackendCompat: true } as ApiConfig

const DASHSCOPE_ERROR_FRAME =
  'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"abc","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}\n\n'

// Reason: real gateway sample — upstream 429 masked behind HTTP 400
const MASKED_THROTTLING_BODY = JSON.stringify({
  success: false,
  message: '模型提供方限流',
  data: null,
  code: 'MPE-429',
  detailMessage: '{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded","request_id":"36389bea"}, traceId: 0b5182d8',
})

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('session request headers', () => {
  const cfg = { endpoint: 'https://api.test/v1', apiKey: 'test-key', model: 'test' } as ApiConfig
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => Response.json({
      id: 'completion-test', model: 'test', created: 0,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sends native max reasoning without turning auxiliary no-reasoning requests into max', async () => {
    const model = createProvider({ ...cfg, reasoningEffort: 'max' })
    await generateText({ model, prompt: 'hello', reasoning: sdkReasoningEffort('max') })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).reasoning_effort).toBe('max')
    await generateText({ model, prompt: 'title', reasoning: 'none' })
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).reasoning_effort).not.toBe('max')
  })

  it('uses valid thinking fields on the official template endpoints', async () => {
    for (const [endpoint, modelName, effort, enabled] of [
      ['https://api.openai.com/v1', 'gpt-6-luna', 'none', false],
      ['https://api.xiaomimimo.com/v1', 'mimo-v2.6-flash', '', false],
      ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', 'max', true],
    ] as const) {
      const model = createProvider({ ...cfg, endpoint, model: modelName, reasoningEffort: effort }, { enableThinking: enabled })
      await generateText({ model, prompt: 'hello', reasoning: sdkReasoningEffort(effort) })
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body))
      expect(body.enable_thinking).toBeUndefined()
      if (modelName === 'gpt-6-luna') expect(body.reasoning_effort).toBe('none')
      if (modelName === 'mimo-v2.6-flash') { expect(body.thinking).toEqual({ type: 'disabled' }); expect(body.reasoning_effort).toBeUndefined() }
      if (modelName === 'glm-5.3-flash') { expect(body.thinking).toEqual({ type: 'enabled' }); expect(body.reasoning_effort).toBe('max') }
    }
  })

  it('sends the session ID without replacing authentication or content headers', async () => {
    const model = createProvider(cfg, { sessionId: 'session-a' })
    expect((await generateText({ model, prompt: 'hello' })).text).toBe('OK')
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('x-session-id')).toBe('session-a')
    expect(headers.get('authorization')).toBe('Bearer test-key')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('keeps the same session ID when the provider is recreated for another model', async () => {
    for (const modelName of ['test', 'another-model']) {
      const model = createProvider({ ...cfg, model: modelName }, { sessionId: 'session-a' })
      await generateText({ model, prompt: 'hello' })
    }
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-session-id')))
      .toEqual(['session-a', 'session-a'])
  })

  it('keeps the session ID across HTTP retries', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    const model = createProvider(cfg, { sessionId: 'session-a' })
    const pending = generateText({ model, prompt: 'hello' })
    await vi.runAllTimersAsync()
    expect((await pending).text).toBe('OK')
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-session-id')))
      .toEqual(['session-a', 'session-a'])
  })

  it('keeps the session ID across streaming error retries', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(sseResponse(DASHSCOPE_ERROR_FRAME))
      .mockResolvedValueOnce(sseResponse('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
    const model = createProvider(cfg, { sessionId: 'session-a' })
    const pending = streamText({ model, prompt: 'hello' }).text
    await vi.runAllTimersAsync()
    expect(await pending).toBe('OK')
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-session-id')))
      .toEqual(['session-a', 'session-a'])
  })

  it('uses the originating session ID for title generation and compression', async () => {
    await Promise.all([
      generateTitle(cfg, 'session-a', 'hello', 'answer'),
      compactContext(cfg, 'session-a', [{ role: 'user', content: 'hello' }]),
    ])
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-session-id')))
      .toEqual(['session-a', 'session-a'])
  })

  it.each([undefined, ''])('does not invent a session ID for sessionless requests (%s)', async sessionId => {
    const model = createProvider(cfg, { sessionId })
    await generateText({ model, prompt: 'hello' })
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('x-session-id')).toBe(false)
  })
})

describe('createRetryFetch — HTTP status retry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retries on 429 status and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(config)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(config)('https://api.test/v1/chat', {})
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on network error and rethrows after exhaustion', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(config)('https://api.test/v1/chat', {})
    // Reason: attach the rejection handler before advancing timers to avoid
    // an unhandled rejection between retry waits
    const guarded = p.catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    expect(await guarded).toBeInstanceOf(TypeError)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('aborts a retry wait immediately when the signal fires', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    const ac = new AbortController()
    const p = createRetryFetch(config)('https://api.test/v1/chat', { signal: ac.signal })
    const guarded = p.catch((e: unknown) => e)
    // Reason: enter the 1s backoff wait, then abort mid-wait
    await vi.advanceTimersByTimeAsync(100)
    ac.abort()
    const err = await guarded
    expect((err as Error).name).toBe('AbortError')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when fetch itself rejects due to abort', async () => {
    const ac = new AbortController()
    const fetchMock = vi.fn().mockImplementation(async () => {
      ac.abort()
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(config)('https://api.test/v1/chat', { signal: ac.signal })
    const err = await p.catch((e: unknown) => e)
    expect((err as Error).name).toBe('AbortError')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('createRetryFetch — masked throttling behind 4xx (backend compat)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retries HTTP 400 with masked throttling body when compat is on', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(MASKED_THROTTLING_BODY, { status: 400 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry masked throttling when compat is explicitly off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MASKED_THROTTLING_BODY, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(noCompatConfig)('https://api.test/v1/chat', {})
    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Reason: body must remain readable after the logging clone
    expect(await res.text()).toBe(MASKED_THROTTLING_BODY)
  })

  it('does not retry genuine 400 client errors in compat mode', async () => {
    const body = JSON.stringify({ success: false, code: 'InvalidParameter', message: 'bad request' })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe(body)
  })

  it('retries when only detailMessage carries the Throttling code', async () => {
    const body = JSON.stringify({
      code: 'MPE-ERR',
      detailMessage: '{"code":"Throttling","message":"Requests throttled"}',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body, { status: 400 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries when the Throttling code sits inside a flat error envelope', async () => {
    const body = JSON.stringify({
      error: {
        code: 'Throttling.AllocationQuota',
        message: 'Workspace allocated quota exceeded, please increase your quota limit.',
        type: 'upstream_error',
      },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body, { status: 400 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a masked 5xx carried by a nested vendor code', async () => {
    const body = JSON.stringify({
      code: 'MPE-ERR',
      detailMessage: JSON.stringify({ error: { code: 'GW-503', message: 'upstream unavailable' } }),
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body, { status: 400 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the raw masked error after retries are exhausted', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(MASKED_THROTTLING_BODY, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    // Reason: compat mode extends retries to 5 (6 attempts total)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(MASKED_THROTTLING_BODY)
  })
})

describe('createRetryFetch — SSE first-frame sniffing', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retries when first frame is an error event with HTTP_STATUS/429', async () => {
    const normal = 'id:1\ndata:{"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(DASHSCOPE_ERROR_FRAME))
      .mockResolvedValueOnce(sseResponse(normal))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await res.text()).toBe(normal)
  })

  it('does not sniff when backend compat mode is off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(DASHSCOPE_ERROR_FRAME))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(noCompatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe(DASHSCOPE_ERROR_FRAME)
  })

  it('retries when the error frame is wrapped as assistant content in a valid chunk', async () => {
    // Reason: some gateways embed the upstream error frame into delta.content
    // with finish_reason "error_finish", making the chunk structurally valid
    const wrapped = 'data:' + JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: 'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"a54","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}\n\n',
        },
        finish_reason: 'error_finish',
      }],
    }) + '\n\n'
    const normal = 'data:{"choices":[{"delta":{"content":"ok"}}]}\n\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(wrapped))
      .mockResolvedValueOnce(sseResponse(normal))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await res.text()).toBe(normal)
  })

  // Reason: real gateway sample — the upstream frame is wrapped in the gateway's
  // own JSON error envelope before landing in delta.content, one level deeper
  // than the plain wrapped shape above
  const nestedEnvelopeChunk = (frame: string) => 'data:' + JSON.stringify({
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: ' ' + JSON.stringify({
          error: { code: 'upstream_error', message: frame, type: 'upstream_error' },
        }),
      },
      finish_reason: 'error_finish',
    }],
    usage: { completion_tokens: 93, prompt_tokens: 7291 },
  }) + '\n\n'

  it('retries when the error frame is nested inside the gateway error envelope', async () => {
    const nested = nestedEnvelopeChunk(DASHSCOPE_ERROR_FRAME)
    const normal = 'data:{"choices":[{"delta":{"content":"ok"}}]}\n\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(nested))
      .mockResolvedValueOnce(sseResponse(normal))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await res.text()).toBe(normal)
  })

  it('retries when the frame is wrapped in two envelope layers', async () => {
    const doubled = 'data:' + JSON.stringify({
      choices: [{
        delta: {
          content: JSON.stringify({
            error: { message: JSON.stringify({ error: { message: DASHSCOPE_ERROR_FRAME } }) },
          }),
        },
        finish_reason: 'error_finish',
      }],
    }) + '\n\n'
    const normal = 'data:{"choices":[{"delta":{"content":"ok"}}]}\n\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(doubled))
      .mockResolvedValueOnce(sseResponse(normal))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await res.text()).toBe(normal)
  })

  it('does not retry a normally finished chunk whose content opens with a real frame', async () => {
    // Reason: delta.content is model-authored — only an abnormal finish_reason
    // marks a chunk the gateway itself terminated with an upstream error
    const quoted = 'data:' + JSON.stringify({
      choices: [{ delta: { content: DASHSCOPE_ERROR_FRAME }, finish_reason: 'stop' }],
    }) + '\n\n'
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(quoted))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe(quoted)
  })

  it('does not retry a nested envelope carrying a non-retryable status', async () => {
    const nested = nestedEnvelopeChunk(
      'id:1\nevent:error\n:HTTP_STATUS/400\ndata:{"code":"InvalidParameter","message":"bad request"}\n\n',
    )
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(nested))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe(nested)
  })

  it('does not retry JSON-shaped content without an embedded error frame', async () => {
    const jsonish = 'data:' + JSON.stringify({
      choices: [{
        delta: { content: '{"error":{"code":"upstream_error","message":"quota exceeded"}}' },
        finish_reason: 'error_finish',
      }],
    }) + '\n\n'
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(jsonish))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe(jsonish)
  })

  it('does not retry when normal content merely mentions the error markers', async () => {
    // Reason: anchored regex — markers not at content start must not trigger retry
    const chatty = 'data:' + JSON.stringify({
      choices: [{ delta: { content: '限流时会返回 event:error 和 :HTTP_STATUS/429 标记' }, finish_reason: null }],
    }) + '\n\n'
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(chatty))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe(chatty)
  })

  it('passes through normal streams with sniffed bytes replayed', async () => {
    const normal = 'id:1\ndata:{"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(normal))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(normal)
  })

  it('returns the raw error frame after retries are exhausted', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => sseResponse(DASHSCOPE_ERROR_FRAME))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    // Reason: compat mode extends retries to 5 (6 attempts total)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    // Reason: error text must surface unmodified — no translation policy
    expect(await res.text()).toBe(DASHSCOPE_ERROR_FRAME)
  })

  it('does not retry error events without a retryable HTTP_STATUS marker', async () => {
    const frame = 'id:1\nevent:error\n:HTTP_STATUS/400\ndata:{"code":"InvalidParameter","message":"bad request"}\n\n'
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(frame))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe(frame)
  })

  it('does not sniff non-SSE responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('handles frames split across multiple chunks', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id:1\nevent:err'))
        controller.enqueue(encoder.encode('or\n:HTTP_STATUS/429\ndata:{"code":"Throttling.RateQuota","message":"x"}\n\n'))
        controller.close()
      },
    })
    const errRes = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const normal = 'data:{"choices":[]}\n\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errRes)
      .mockResolvedValueOnce(sseResponse(normal))
    vi.stubGlobal('fetch', fetchMock)

    const p = createRetryFetch(compatConfig)('https://api.test/v1/chat', {})
    await vi.runAllTimersAsync()
    const res = await p
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await res.text()).toBe(normal)
  })
})

describe('relocateToolImages', () => {
  const IMG = 'data:image/jpeg;base64,AAAA'
  const shot = (message: string, dataUrl = IMG) => ({
    role: 'tool',
    tool_call_id: 'c1',
    content: JSON.stringify({ message, dataUrl }),
  })

  it('strips the dataUrl from the tool result and appends it as a user message', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'screenshot the page' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      shot('Screenshot captured'),
    ]
    relocateToolImages(messages, true)

    expect(messages).toHaveLength(4)
    expect(messages[2].role).toBe('tool')
    expect(messages[2].content).toBe('Screenshot captured')
    expect(messages[3]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: '[上述工具返回的截图]' },
        { type: 'image_url', image_url: { url: IMG } },
      ],
    })
  })

  it('never splits a consecutive tool run', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
      shot('shot A'),
      { role: 'tool', tool_call_id: 'c2', content: 'plain text result' },
    ]
    relocateToolImages(messages, true)

    expect(messages.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
  })

  it('merges every image of one run into a single user message', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: '' },
      shot('shot A', 'data:image/jpeg;base64,AAA'),
      shot('shot B', 'data:image/jpeg;base64,BBB'),
    ]
    relocateToolImages(messages, true)

    expect(messages).toHaveLength(4)
    const parts = messages[3].content as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ type: 'text', text: '[上述工具返回的 2 张截图]' })
    expect(parts.slice(1).map(p => (p.image_url as { url: string }).url))
      .toEqual(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'])
  })

  it('keeps runs separate and preserves ordering across multiple turns', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: '' },
      shot('shot A', 'data:image/jpeg;base64,AAA'),
      { role: 'assistant', content: 'looking' },
      shot('shot B', 'data:image/jpeg;base64,BBB'),
    ]
    relocateToolImages(messages, true)

    expect(messages.map(m => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant', 'tool', 'user'])
    const first = (messages[2].content as Array<{ image_url?: { url: string } }>)[1]
    const second = (messages[5].content as Array<{ image_url?: { url: string } }>)[1]
    expect(first.image_url!.url).toBe('data:image/jpeg;base64,AAA')
    expect(second.image_url!.url).toBe('data:image/jpeg;base64,BBB')
  })

  it('drops the image but still cleans the tool result when vision is unsupported', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: '' },
      shot('Screenshot captured'),
    ]
    relocateToolImages(messages, false)

    expect(messages).toHaveLength(2)
    expect(messages[1].content).toBe('Screenshot captured')
  })

  it('leaves non-screenshot and archived tool results untouched', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'tool', tool_call_id: 'c1', content: '[archived: /context/tool-c1.txt | head: ...]' },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ message: 'done', dataUrl: '' }) },
      { role: 'tool', tool_call_id: 'c3', content: 'not json at all' },
    ]
    const before = messages.map(m => m.content)
    relocateToolImages(messages, true)

    expect(messages).toHaveLength(3)
    expect(messages.map(m => m.content)).toEqual(before)
  })
})
