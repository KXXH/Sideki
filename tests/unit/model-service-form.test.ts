// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import ModelServiceForm from '../../src/sidepanel/components/ModelServiceForm'
import ModelServices from '../../src/sidepanel/components/ModelServices'
import { DEFAULT_CONFIG } from '../../src/sidepanel/default-config'
import { addServiceModel } from '../../src/shared/model-services'
import { generateText } from 'ai'
import { createProvider } from '../../src/shared/ai-provider'
import type { ProviderProfile } from '../../src/shared/types'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('ai', async original => ({ ...await original<typeof import('ai')>(), generateText: vi.fn() }))
vi.mock('../../src/shared/ai-provider', () => ({ createProvider: vi.fn(() => 'mock-model'), sdkReasoningEffort: (v: string) => v === 'max' ? 'high' : v || undefined }))
let root: Root, container: HTMLDivElement
beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false } })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true } })
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => { vi.clearAllMocks(); vi.mocked(generateText).mockResolvedValue({ text: 'OK' } as Awaited<ReturnType<typeof generateText>>); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
async function click(el: HTMLElement) { await act(async () => el.click()) }
async function input(selector: string, value: string) { const el = document.querySelector<HTMLInputElement>(selector)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function submit() { await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))) }

it('applies template defaults and preserves a custom 272K budget when editing', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  await act(async () => root.render(React.createElement(ModelServiceForm, { onSave })))
  await click(document.querySelector('[data-template="kimi"]')!)
  await click(button('高级参数'))
  expect((document.querySelector('[aria-label="推理强度"]') as HTMLSelectElement).value).toBe('low')
  await click(document.querySelector('[data-template="zhipu"]')!)
  expect((document.querySelector('[aria-label="推理强度"]') as HTMLSelectElement).value).toBe('max')
  await click(document.querySelector('[data-template="openai"]')!)
  expect((document.querySelector('[aria-label="自定义上下文预算"]') as HTMLInputElement).value).toBe('272000')
  await click(button('400K'))
  expect(document.querySelector('[aria-label="自定义上下文预算"]')).toBeNull()
  await input('[aria-label="API Key"]', 'demo-key')
  await submit()
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-luna', contextWindow: 400000, reasoningEffort: 'xhigh', apiProtocol: 'responses' }))
  expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 128, tools: expect.objectContaining({ sidekick_connection_check: expect.anything() }) }))
})

it('requires a name for custom services and keeps the entered key after a failed verification', async () => {
  const onSave = vi.fn()
  await act(async () => root.render(React.createElement(ModelServiceForm, { onSave })))
  await click(document.querySelector('[data-template="custom"]')!)
  await submit()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('API 地址')
  await input('[aria-label="API 地址"]', 'https://my.test/v1')
  await submit()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('服务名称')
  await input('input[placeholder="例如：公司模型服务"]', '公司模型服务')
  await input('[aria-label="模型 ID"]', 'my-model')
  await input('[aria-label="API Key"]', 'secret-do-not-log')
  vi.mocked(generateText).mockRejectedValueOnce(new Error('401 unauthorized'))
  await submit()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Key 无效')
  expect((document.querySelector('[aria-label="API Key"]') as HTMLInputElement).value).toBe('secret-do-not-log')
  expect(onSave).not.toHaveBeenCalled()
  await submit()
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ serviceName: '公司模型服务', model: 'my-model' }))
})

it('normalizes a pasted inference URL before verifying and saving it', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  await act(async () => root.render(React.createElement(ModelServiceForm, { onSave })))
  await click(document.querySelector('[data-template="openai"]')!)
  await click(button('高级参数'))
  await input('[aria-label="API 地址"]', 'https://custom.example/v1/responses/')
  await input('[aria-label="API Key"]', 'test-key')
  await submit()
  expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://custom.example/v1', apiProtocol: 'responses' }), expect.anything())
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://custom.example/v1' }))
})

it('identifies an empty-message HTTP 404 as a verification failure, preserving the key for retry', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  await act(async () => root.render(React.createElement(ModelServiceForm, { onSave })))
  await input('[aria-label="API Key"]', 'test-key')
  vi.mocked(generateText).mockRejectedValueOnce(Object.assign(new Error(''), { statusCode: 404, responseBody: '' }))
  await submit()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('接口地址不存在（HTTP 404）')
  expect(onSave).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('[aria-label="API Key"]')?.value).toBe('test-key')
  await submit()
  expect(onSave).toHaveBeenCalledOnce()
})

it('distinguishes verification and persistence errors even when both have empty messages', async () => {
  const onSave = vi.fn().mockRejectedValue(new Error(''))
  await act(async () => root.render(React.createElement(ModelServiceForm, { onSave })))
  await input('[aria-label="API Key"]', 'test-key')
  vi.mocked(generateText).mockRejectedValueOnce(new Error(''))
  await submit()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('连接验证失败：服务未返回错误详情，请检查 API 地址、接口格式和模型 ID。')
  expect(onSave).not.toHaveBeenCalled()
  await submit()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('保存配置失败：请重试。')
})

it('extracts structured API error details and masks the key', async () => {
  await act(async () => root.render(React.createElement(ModelServiceForm, { onSave: vi.fn() })))
  await input('[aria-label="API Key"]', 'test-key')
  vi.mocked(generateText).mockRejectedValueOnce(Object.assign(new Error(''), { statusCode: 400, responseBody: JSON.stringify({ error: { message: 'Invalid model for test-key' } }) }))
  await submit()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('连接验证失败（HTTP 400）：Invalid model for [Key]')
})

it('reverifies an edited model when changing protocol and exposes the supported reasoning choices', async () => {
  const profile: ProviderProfile = { id: 'p', serviceName: 'OpenAI', templateId: 'openai', name: 'Luna', endpoint: 'https://api.openai.com/v1', apiKey: 'test-only-key', model: 'gpt-6-luna', reasoningEffort: 'none', contextWindow: 272000 }
  const onSave = vi.fn().mockResolvedValue(undefined)
  await act(async () => root.render(React.createElement(ModelServiceForm, { mode: 'model', profile, onSave })))
  const protocol = document.querySelector<HTMLSelectElement>('[aria-label="接口格式"]')!
  const effort = document.querySelector<HTMLSelectElement>('[aria-label="推理强度"]')!
  expect(Array.from(effort.options).map(option => option.value)).toEqual(['none'])
  await act(async () => { protocol.value = 'responses'; protocol.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(Array.from(effort.options).map(option => option.value)).toContain('xhigh')
  expect(Array.from(effort.options).some(option => option.textContent?.includes('服务商默认'))).toBe(false)
  await act(async () => { effort.value = 'xhigh'; effort.dispatchEvent(new Event('change', { bubbles: true })) })
  await submit()
  expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({ apiProtocol: 'responses', reasoningEffort: 'xhigh' }), expect.anything())
  expect(generateText).toHaveBeenCalledOnce()
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiProtocol: 'responses', reasoningEffort: 'xhigh' }))
})

it('lets the user cancel a pending verification without saving', async () => {
  const onSave = vi.fn()
  vi.mocked(generateText).mockImplementation(options => new Promise((_resolve, reject) => options.abortSignal!.addEventListener('abort', () => reject(new Error('aborted')))))
  await act(async () => root.render(React.createElement(ModelServiceForm, { onSave })))
  await input('[aria-label="API Key"]', 'demo-key')
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })) })
  expect(document.querySelector('[role="status"]')?.textContent).toContain('正在验证')
  await click(button('取消'))
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('已取消验证。')
  expect(onSave).not.toHaveBeenCalled()
})

it('allows updating service credentials for legacy models without a reasoning setting', async () => {
  const profile: ProviderProfile = { id: 'legacy', serviceName: '旧服务', name: '旧模型', model: 'legacy-model', endpoint: 'https://example.test/v1', apiKey: 'old-key', reasoningEffort: '' }
  const onSave = vi.fn().mockResolvedValue(undefined)
  await act(async () => root.render(React.createElement(ModelServiceForm, { mode: 'credentials', profile, onSave })))
  await input('[aria-label="API Key"]', 'new-key')
  await submit()
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'new-key', reasoningEffort: '', apiProtocol: 'chat-completions' }))
  expect(onSave.mock.calls[0][0].contextWindow).toBeUndefined()
  expect(generateText).toHaveBeenCalledOnce()
})

it('edits a model without a request or selecting it, and selects only through the explicit button', async () => {
  const p: ProviderProfile = { id: 'p', serviceId: 's', serviceName: '我的服务', templateId: 'deepseek', name: 'Flash', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'key', reasoningEffort: 'high', contextWindow: 400000 }
  const config = addServiceModel(DEFAULT_CONFIG, p)
  const q = { ...p, id: 'q', model: 'other', name: '另一个模型' }
  const value = addServiceModel(config, q)
  const onChange = vi.fn().mockResolvedValue(undefined)
  await act(async () => root.render(React.createElement(ModelServices, { config: value, onChange })))
  const row = button('选用 另一个模型').closest('.model-service-row')!
  await click(Array.from(row.querySelectorAll('button')).find(b => b.textContent === '调整')!)
  await click(button('200K'))
  await submit()
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ activeProfileId: 'p', contextWindow: 400000, profiles: expect.arrayContaining([expect.objectContaining({ id: 'q', contextWindow: 200000 })]) }))
  expect(generateText).not.toHaveBeenCalled()
  await click(button('选用 另一个模型'))
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ activeProfileId: 'q', model: 'other' }))
})


it('times out a stalled verification and restores the submit action', async () => {
  vi.useFakeTimers()
  try {
    const onSave = vi.fn()
    vi.mocked(generateText).mockImplementation(options => new Promise((_resolve, reject) => options.abortSignal!.addEventListener('abort', () => reject(new Error('aborted')))))
    await act(async () => root.render(React.createElement(ModelServiceForm, { onSave })))
    await input('[aria-label="API Key"]', 'demo-key')
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })) })
    await act(async () => vi.advanceTimersByTime(20000))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('连接超时')
    expect(button('验证并添加').disabled).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it('preserves unauthenticated legacy connections without requiring a key or per-model budget', async () => {
  const profile: ProviderProfile = { id: 'local', serviceName: '本地服务', name: '本地模型', model: 'local-model', endpoint: 'http://localhost:8080/v1', apiKey: '', reasoningEffort: '' }
  const onSave = vi.fn().mockResolvedValue(undefined)
  await act(async () => root.render(React.createElement(ModelServiceForm, { mode: 'credentials', profile, onSave })))
  expect(document.querySelector<HTMLInputElement>('[aria-label="API Key"]')!.required).toBe(false)
  await input('[aria-label="API 地址"]', 'http://localhost:8081/v1')
  await submit()
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://localhost:8081/v1', apiKey: '', reasoningEffort: '' }))
  expect(generateText).toHaveBeenCalledOnce()
})
