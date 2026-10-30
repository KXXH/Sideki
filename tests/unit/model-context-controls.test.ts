// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import ModelSwitcher from '../../src/sidepanel/components/ModelSwitcher'
import { ContextMeter } from '../../src/sidepanel/components/ContextMeter'
import { saveConfig } from '../../src/shared/storage'
import type { ApiConfig, ProviderProfile } from '../../src/shared/types'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('../../src/shared/storage', async importOriginal => ({ ...await importOriginal<typeof import('../../src/shared/storage')>(), saveConfig: vi.fn() }))
let root: Root, container: HTMLDivElement
beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(saveConfig).mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const profiles: ProviderProfile[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: i === 7 ? '备用服务' : `配置 ${i}`, model: 'shared-model', endpoint: `https://service-${i}.example/v1`, apiKey: `key-${i}`, contextWindow: (i + 1) * 32000, reasoningEffort: i === 7 ? 'high' : '', supportsImages: i === 7, modelParams: { temperature: i / 10 } }))
const config = { ...profiles[0], activeProfileId: 'p0', profiles, contextWindow: 32000 } as unknown as ApiConfig
const find = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(text))!
async function click(el: HTMLElement) { await act(async () => el.click()) }
async function render(disabled = false, value = config) { await act(async () => root.render(React.createElement(ModelSwitcher, { config: value, disabled, onOpenSettings: vi.fn(), direction: 'up' }))) }

it('distinguishes duplicate model IDs by profile and host and applies every selected profile field', async () => {
  await render(); await click(container.querySelector('button')!)
  const popup = document.querySelector('[role="dialog"]')!
  expect(popup.textContent).toContain('service-7.example')
  expect(popup.textContent).toContain('256K')
  await click(find('备用服务'))
  expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ activeProfileId: 'p7', endpoint: profiles[7].endpoint, apiKey: 'key-7', model: 'shared-model', contextWindow: 256000, reasoningEffort: 'high', supportsImages: true, modelParams: { temperature: 0.7 } }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('searches by custom name and endpoint and exposes an empty result without losing management', async () => {
  await render(); await click(container.querySelector('button')!)
  const input = document.querySelector('input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  for (const query of ['service-7', '不存在的配置']) {
    await act(async () => { setter.call(input, query); input.dispatchEvent(new Event('input', { bubbles: true })) })
    if (query === 'service-7') { expect(find('备用服务')).toBeDefined(); expect(find('配置 1')).toBeUndefined() }
    else expect(document.body.textContent).toContain('没有匹配的模型')
    expect(find('管理模型')).toBeDefined()
  }
})

it('keeps a failed switch open with an error and permits retry', async () => {
  vi.mocked(saveConfig).mockRejectedValueOnce(new Error('storage unavailable'))
  await render(); await click(container.querySelector('button')!); await click(find('备用服务'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await click(find('备用服务'))
  expect(saveConfig).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('closes an already open picker when a turn starts and disables further switching', async () => {
  await render(); await click(container.querySelector('button')!)
  await render(true)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('button')!.disabled).toBe(true)
  expect(saveConfig).not.toHaveBeenCalled()
})

it('updates reasoning only on the active profile and restores focus with Escape', async () => {
  await render(); const trigger = container.querySelector('button')!; await click(trigger)
  const select = document.querySelector<HTMLSelectElement>('[aria-label="当前模型的思考强度"]')!
  expect(Array.from(select.options).some(option => option.textContent === '服务商默认')).toBe(false)
  await act(async () => { select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  const saved = vi.mocked(saveConfig).mock.calls[0][0]
  expect(saved.reasoningEffort).toBe('high')
  expect(saved.profiles[0].reasoningEffort).toBe('high')
  expect(saved.profiles[1]).toEqual(profiles[1])
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('keeps compression separate, uses the current capacity, and guards unavailable compression', async () => {
  const compact = vi.fn()
  const props = { used: 32000, total: 128000, onCompact: compact, canCompact: false, direction: 'up' as const }
  await act(async () => root.render(React.createElement(ContextMeter, props)))
  const trigger = container.querySelector('button')!
  expect(trigger.getAttribute('aria-label')).toContain('25%')
  await click(trigger)
  expect(container.contains(document.querySelector('[role="dialog"]'))).toBe(false)
  expect(find('压缩上下文').disabled).toBe(true)
  await click(find('压缩上下文')); expect(compact).not.toHaveBeenCalled()
  await act(async () => root.render(React.createElement(ContextMeter, { ...props, total: 64000, canCompact: true })))
  expect(trigger.getAttribute('aria-label')).toContain('50%')
  await click(find('压缩上下文')); expect(compact).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('keeps legacy configurations usable without a profiles array', async () => {
  await render(false, { ...config, profiles: undefined } as unknown as ApiConfig)
  await click(container.querySelector('button')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('shared-model')
  expect(find('管理模型')).toBeDefined()
})

it('prevents concurrent profile writes while a save is pending', async () => {
  let finish!: () => void
  vi.mocked(saveConfig).mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  await render(); await click(container.querySelector('button')!)
  await click(find('备用服务'))
  expect(find('配置 1').disabled).toBe(true)
  await click(find('配置 1'))
  expect(saveConfig).toHaveBeenCalledOnce()
  await act(async () => finish())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('caps an upward model menu to the actual space above its trigger and remeasures on resize', async () => {
  let top = 340
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 28, left: 0, right: 100, width: 100, height: 28, x: 0, y: top, toJSON() {} }))
  try {
    await render(); await click(container.querySelector('button')!)
    const menu = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(menu.style.maxHeight).toBe('328px')
    top = 250
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(menu.style.maxHeight).toBe('238px')
  } finally { rect.mockRestore() }
})
