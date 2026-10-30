import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildSystemPrompt, createAgent, cratonRef } from '../../src/shared/agent'
import { HTML_ARTIFACT_CAPABILITIES } from '../../src/shared/html-artifact'
import * as memoryStorage from '../../src/shared/memory-storage'
import type { ApiConfig, PageContent } from '../../src/shared/types'

const baseConfig: ApiConfig = {
  endpoint: '', apiKey: '', model: '', contextWindow: 100000,
  systemPrompt: '', reasoningEffort: '', securityLevel: 'strict',
  maxToolRounds: 10, yoloMode: false, devMode: false,
  accentColor: 'indigo', fontFamily: 'sans', fontSize: 'default',
  activeProfileId: '', profiles: [],
}
const page: PageContent = { title: 'Test', url: 'https://example.com', content: 'Hello' }

describe('buildSystemPrompt', () => {
  it.each(['chat', 'pro'] as const)('separates Sideki identity from the configured model in %s mode', mode => {
    const p = buildSystemPrompt(page, { ...baseConfig, model: 'user-selected-model' }, mode)
    expect(p).toContain('You are Sideki, an AI assistant built into the browser sidebar.')
    expect(p).toContain('The user-configured model name is "user-selected-model".')
    expect(p).not.toContain('You are user-selected-model')
    expect(p).toContain(HTML_ARTIFACT_CAPABILITIES)
  })

  it('includes page content in chat mode', () => {
    const p = buildSystemPrompt(page, baseConfig)
    expect(p).toContain('Hello')
    expect(p).toContain('Test')
    expect(p).toContain('https://example.com')
  })

  it('does NOT include page content in pro mode', () => {
    const p = buildSystemPrompt(page, baseConfig, 'pro')
    expect(p).not.toContain('Hello')
    expect(p).toContain('Test')
    expect(p).toContain('debug elements')
  })

  it('includes custom prompt at the end', () => {
    const p = buildSystemPrompt(page, { ...baseConfig, systemPrompt: 'Custom rule' })
    expect(p).toContain('Custom rule')
    // Custom should come AFTER page content
    const contentIdx = p.indexOf('Hello')
    const customIdx = p.indexOf('Custom rule')
    expect(customIdx).toBeGreaterThan(contentIdx)
  })

  it('includes shared command docs', () => {
    const p = buildSystemPrompt(page, baseConfig)
    expect(p).toContain('dom [--root=SEL]')
    expect(p).toContain('chrome tabs')
  })
})

describe('createAgent session identity', () => {
  afterEach(() => vi.restoreAllMocks())

  it('isolates concurrent sessions and retains the ID across turns and agent rebuilds', async () => {
    vi.spyOn(memoryStorage, 'getGlobalMemory').mockResolvedValue('')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ))
    const cfg = { ...baseConfig, endpoint: 'https://api.test/v1', apiKey: 'test-key', model: 'test' }
    const sessionIdRef = { current: 'session-a' }
    const first = await createAgent(cfg, { current: null }, { current: [] }, undefined, sessionIdRef)
    sessionIdRef.current = 'session-b'
    const second = await createAgent(cfg, { current: null }, { current: [] }, undefined, sessionIdRef)
    const restored = await createAgent(
      { ...cfg, model: 'another-model' }, { current: null }, { current: [] }, undefined, { current: 'session-a' },
    )

    for (const agent of [first, first]) {
      const result = await agent.stream({ prompt: 'hello' })
      expect(await result.text).toBe('OK')
    }
    await Promise.all([second, restored].map(async agent => {
      const result = await agent.stream({ prompt: 'hello' })
      expect(await result.text).toBe('OK')
    }))

    const requests = fetchMock.mock.calls.map(([, init]) => ({
      sessionId: new Headers(init?.headers).get('x-session-id'),
      model: JSON.parse(init?.body as string).model,
    }))
    expect(requests.slice(0, 2)).toEqual([
      { sessionId: 'session-a', model: 'test' },
      { sessionId: 'session-a', model: 'test' },
    ])
    expect(requests.slice(2)).toEqual(expect.arrayContaining([
      { sessionId: 'session-b', model: 'test' },
      { sessionId: 'session-a', model: 'another-model' },
    ]))
    expect(requests).toHaveLength(4)
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init?.body as string)
      const system = body.messages.filter((message: { role: string }) => message.role === 'system')
        .map((message: { content: string }) => message.content).join('\n')
      expect(system).toContain('You are Sideki, an AI assistant built into the browser sidebar.')
      expect(system).toContain(`The user-configured model name is ${JSON.stringify(body.model)}.`)
      expect(system).toContain(HTML_ARTIFACT_CAPABILITIES)
    }
  })
})

describe('craton inline math preference', () => {
  afterEach(() => vi.restoreAllMocks())

  const cfg = { ...baseConfig, endpoint: 'https://api.test/v1', apiKey: 'test-key', model: 'test' }
  const notice = 'Avoid inline math in your replies'

  it.each([
    { mode: 'chat' as const, context: page },
    { mode: 'pro' as const, context: page },
    { mode: 'chat' as const, context: null },
    { mode: 'pro' as const, context: null },
  ])('adds guidance only when disabled, including legacy defaults ($mode, $context)', async ({ mode, context }) => {
    vi.spyOn(memoryStorage, 'getGlobalMemory').mockResolvedValue('')

    for (const enabled of [undefined, false, true]) {
      await createAgent(
        { ...cfg, labSingleDollarMath: enabled }, { current: context }, { current: [] },
        undefined, undefined, undefined, undefined, undefined, undefined, mode,
      )
      const instructions = cratonRef.current!.instructions
      if (enabled) {
        expect(instructions).not.toContain(notice)
        expect(instructions).not.toMatch(/inline math|\$\.\.\.\$/i)
      } else {
        expect(instructions).toContain(notice)
        expect(instructions).toContain('plain text instead')
      }
    }
  })

  it.each([false, true])('freezes the initial value %s across turns and resamples on rebuild', async initial => {
    vi.spyOn(memoryStorage, 'getGlobalMemory').mockResolvedValue('')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ))
    const config = { ...cfg, labSingleDollarMath: initial }
    const agent = await createAgent(config, { current: page }, { current: [] })
    expect(await (await agent.stream({ prompt: 'first turn' })).text).toBe('OK')

    config.labSingleDollarMath = !initial
    expect(await (await agent.stream({ prompt: 'next turn' })).text).toBe('OK')
    const rebuilt = await createAgent(config, { current: page }, { current: [] })
    expect(await (await rebuilt.stream({ prompt: 'after rebuild' })).text).toBe('OK')

    const instructions = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(init?.body as string)
      return body.messages.filter((message: { role: string }) => message.role === 'system')
        .map((message: { content: string }) => message.content).join('\n') as string
    })
    expect(instructions).toHaveLength(3)
    expect(instructions[0]).toBe(instructions[1])
    expect(instructions.map(text => text.includes(notice))).toEqual([!initial, !initial, initial])
  })
})


describe('monitor turn budget', () => {
  afterEach(() => vi.restoreAllMocks())
  it('bounds a repetitive tool loop and reads the limit again for the next turn', async () => {
    vi.spyOn(memoryStorage, 'getGlobalMemory').mockResolvedValue('')
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true })
    let calls = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const chunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${++calls}`, type: 'function', function: { name: 'wait', arguments: '{"duration":1}' } }] }, finish_reason: 'tool_calls' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    let limit: number | undefined = 2
    const agent = await createAgent(
      { ...baseConfig, maxToolRounds: 3, endpoint: 'https://api.test/v1', apiKey: 'test', model: 'test' },
      { current: null }, { current: [] }, undefined, undefined, undefined, undefined, undefined,
      { getStepLimit: () => limit },
    )
    const first = await agent.stream({ prompt: 'monitor wake' })
    await first.text
    expect(fetchMock).toHaveBeenCalledTimes(2)
    limit = undefined
    const next = await agent.stream({ prompt: 'normal turn' })
    await next.text
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
})
