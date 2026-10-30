import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectChatTransport, type UIMessage } from 'ai'
import { createAgent } from '../../src/shared/agent'
import { KernelChat, SidekickKernel } from '../../src/shared/kernel/chat-kernel'
import { sessionMessages } from '../../src/shared/kernel/kernel-runtime'
import { loadSession, saveSession } from '../../src/shared/storage'
import * as memoryStorage from '../../src/shared/memory-storage'
import { DEFAULT_CONFIG } from '../../src/sidepanel/default-config'
import { callItem, event, IMAGE, reasoningItem, plainReasoningItem, responseJson, responseStream, textItem } from '../fixtures/responses'
import type { ChatSession } from '../../src/shared/types'

const config = { ...DEFAULT_CONFIG, endpoint: 'https://api.openai.com/v1', apiKey: 'test-only-key', model: 'gpt-6-luna', apiProtocol: 'responses' as const, reasoningEffort: 'xhigh' as const, labBackendCompat: false }
const fetchMock = vi.fn<typeof fetch>()
const chromeMock = chrome
const body = (index: number) => JSON.parse(String(fetchMock.mock.calls[index][1]?.body))
const savedSession = (messages: UIMessage[]): ChatSession => ({ id: 's', title: 'Test', createdAt: 1, updatedAt: 1, messages } as unknown as ChatSession)

async function chat(messages: UIMessage[] = []) {
  const agent = await createAgent(config, { current: null }, { current: [] }, undefined, { current: 's' })
  return new KernelChat<UIMessage>({ messages, transport: new DirectChatTransport({ agent, sendReasoning: true }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('chrome', chromeMock)
  vi.spyOn(memoryStorage, 'getGlobalMemory').mockResolvedValue('')
  const stored: Record<string, unknown> = { sidekick_session_index: [] }
  vi.mocked(chrome.storage.local.get).mockImplementation(async keys => {
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(stored)
    return Object.fromEntries(names.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]))
  })
  vi.mocked(chrome.storage.local.set).mockImplementation(async values => { Object.assign(stored, JSON.parse(JSON.stringify(values))) })
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => message.type === 'tool:screenshot' ? { success: true, message: 'Captured', dataUrl: IMAGE } : { success: true })
  fetchMock.mockReset().mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).stream ? responseStream() : responseJson())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Responses through the production agent and kernel transport', () => {
  it('streams a real screenshot tool loop, then restores encrypted reasoning and call pairs from session storage', async () => {
    fetchMock.mockResolvedValueOnce(responseStream([reasoningItem(), callItem('screenshot')])).mockResolvedValueOnce(responseStream([textItem('Screenshot understood')]))
    const first = await chat()
    await first.sendMessage({ text: 'Look at the page' })
    expect(first.error).toBeUndefined()
    expect(first.status).toBe('ready')
    expect(first.messages[1].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', providerMetadata: { responses: expect.objectContaining({ reasoningEncryptedContent: 'encrypted-rs_1' }) } }),
      expect.objectContaining({ type: 'tool-screenshot', state: 'output-available', toolCallId: 'call_1' }),
      expect.objectContaining({ type: 'text', text: 'Screenshot understood' }),
    ]))
    expect(body(0).tools.every((tool: { strict?: boolean }) => tool.strict === false)).toBe(true)
    expect(body(1).input.find((item: { type: string }) => item.type === 'function_call_output')).toMatchObject({ call_id: 'call_1', output: expect.arrayContaining([expect.objectContaining({ type: 'input_image', image_url: IMAGE })]) })

    await saveSession(savedSession(first.messages))
    const loaded = await loadSession('s')
    expect(loaded).not.toBeNull()
    const restored = await chat(sessionMessages(loaded!))
    await restored.sendMessage({ text: 'What next?' })
    expect(restored.error).toBeUndefined()
    expect(body(2).input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-rs_1' }),
      expect.objectContaining({ type: 'function_call', call_id: 'call_1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ]))
    expect(body(2).store).toBe(false)
    expect(body(2).previous_response_id).toBeUndefined()
    expect(body(2).input.some((item: { type: string }) => item.type === 'item_reference')).toBe(false)
  })

  it('streams and restores plain reasoning with a screenshot tool result using the same adapter', async () => {
    fetchMock.mockResolvedValueOnce(responseStream([plainReasoningItem(), callItem('screenshot')])).mockResolvedValueOnce(responseStream([textItem('Plain reasoning completed')]))
    const first = await chat()
    await first.sendMessage({ text: 'Inspect' })
    expect(first.error).toBeUndefined()
    expect(first.messages[1].parts).toContainEqual(expect.objectContaining({ type: 'reasoning', text: 'Inspecting the page directly.' }))
    await saveSession(savedSession(first.messages))
    const restored = await chat(sessionMessages((await loadSession('s'))!))
    await restored.sendMessage({ text: 'Continue' })
    expect(restored.error).toBeUndefined()
    const reasoning = body(2).input.find((item: { type: string }) => item.type === 'reasoning')
    expect(reasoning).toMatchObject({ content: [{ type: 'reasoning_text', text: 'Inspecting the page directly.' }], summary: [] })
    expect(reasoning.encrypted_content).toBeUndefined()
    expect(body(2).input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }))
  })

  it('retains an encrypted reasoning item even when the endpoint provides no visible summary', async () => {
    fetchMock.mockResolvedValueOnce(responseStream([{ ...reasoningItem(), summary: [] }, textItem('Only the answer is visible')]))
    const first = await chat()
    await first.sendMessage({ text: 'Hi' })
    expect(first.error).toBeUndefined()
    await saveSession(savedSession(first.messages))
    const restored = await chat(sessionMessages((await loadSession('s'))!))
    await restored.sendMessage({ text: 'Continue' })
    expect(restored.error).toBeUndefined()
    const reasoning = body(1).input.find((item: { type: string }) => item.type === 'reasoning')
    expect(reasoning).toMatchObject({ summary: [], encrypted_content: 'encrypted-rs_1' })
    expect(reasoning.content).toBeUndefined()
  })

  it('compacts old turns while preserving recent encrypted reasoning and complete tool pairs', async () => {
    fetchMock.mockResolvedValueOnce(responseStream([reasoningItem(), callItem('screenshot')])).mockResolvedValueOnce(responseStream([textItem('Captured')]))
    const active = await chat()
    await active.sendMessage({ text: 'Take a screenshot' })
    await active.sendMessage({ text: 'Follow up' })
    await active.sendMessage({ text: 'Another follow up' })
    const kernel = new SidekickKernel({ getConfig: () => config, getSessionId: () => 's' })
    kernel.kstate.messages = [
      { id: 'old-u', role: 'user', parts: [{ type: 'text', text: 'old' }] },
      { id: 'old-a', role: 'assistant', parts: [{ type: 'text', text: 'old answer' }] },
      ...active.messages,
    ]
    const before = structuredClone(active.messages)
    await kernel.compactNow()
    expect(kernel.kstate.messages.slice(1)).toEqual(before)
    expect(body(4).reasoning.effort).toBe('none')
    const resumed = await chat(kernel.kstate.messages)
    await resumed.sendMessage({ text: 'Continue' })
    expect(resumed.error).toBeUndefined()
    expect(body(5).input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-rs_1' }), expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' })]))
  })

  it('stops a pending stream immediately and allows a new turn without retrying the stopped request', async () => {
    const encoder = new TextEncoder()
    let aborted = false
    fetchMock.mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(event('response.created', { response: { id: 'resp_wait', created_at: 1, model: config.model, status: 'in_progress' } })))
        init!.signal!.addEventListener('abort', () => { aborted = true; controller.error(init!.signal!.reason) }, { once: true })
      },
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const active = await chat()
    const pending = active.sendMessage({ text: 'Start' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await active.stop()
    await pending
    expect(aborted).toBe(true)
    expect(active.status).toBe('ready')
    expect(active.error).toBeUndefined()
    await active.sendMessage({ text: 'Try again' })
    expect(active.error).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(active.messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'OK' }))
  })

  it('exposes response.failed without silently replaying a started response', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async () => new Response(event('response.failed', { sequence_number: 1, response: { id: 'resp_failed', created_at: 1, model: config.model, status: 'failed', error: { code: 'server_error', message: 'Generation failed' } } }), { headers: { 'content-type': 'text/event-stream' } }))
    const active = await chat()
    const pending = active.sendMessage({ text: 'Hi' })
    await vi.runAllTimersAsync()
    await pending
    expect(active.status).toBe('error')
    expect(active.error).toBeDefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
