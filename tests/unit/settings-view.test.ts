// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import SettingsView from '../../src/sidepanel/views/SettingsView'
import { loadConfig, saveConfig } from '../../src/shared/storage'
import type { ApiConfig } from '../../src/shared/types'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('../../src/shared/storage', async original => ({
  ...await original<typeof import('../../src/shared/storage')>(),
  loadConfig: vi.fn(), saveConfig: vi.fn(), loadSessionIndex: vi.fn(async () => []),
}))
vi.mock('../../src/shared/memory-storage', async original => ({
  ...await original<typeof import('../../src/shared/memory-storage')>(),
  getGlobalMemory: vi.fn(async () => ''), getAllSiteHostnames: vi.fn(async () => []),
  getNotes: vi.fn(async () => []), getCurationUndoTs: vi.fn(async () => null),
}))
vi.mock('../../src/shared/skills', () => ({ skillRegistry: new Map() }))
vi.mock('../../src/sidepanel/components/McpSection', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/MemoryCurationSheet', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/views/DataView', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/views/UsageView', () => ({ default: () => null }))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('__BUILD_HASH__', 'test')
  vi.stubGlobal('__AI_SDK_VERSION__', 'test')
  vi.stubGlobal('__JUST_BASH_VERSION__', 'test')
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  chrome.storage.local.onChanged = { addListener: vi.fn(), removeListener: vi.fn() } as unknown as typeof chrome.storage.local.onChanged
  vi.mocked(loadConfig).mockResolvedValue(null)
  vi.mocked(saveConfig).mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

afterAll(() => vi.unstubAllGlobals())

function control(label: string) {
  return container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!
}
async function render() { await act(async () => root.render(React.createElement(SettingsView))) }
async function toggle(label: string) {
  const button = control(label)
  const details = button.closest('details')
  if (details) details.open = true
  await act(async () => button.click())
  await act(async () => vi.advanceTimersByTime(300))
  return vi.mocked(saveConfig).mock.calls.at(-1)![0]
}

it('keeps all four technical controls in a closed disclosure, enabled by default', async () => {
  await render()
  for (const label of ['后台内核（Offscreen）', '拟真操作', '异步脚本执行', 'LLM 后端兼容模式']) {
    const button = control(label)
    expect(button.getAttribute('aria-checked')).toBe('true')
    expect(button.closest('section')?.id).toBe('s-developer')
    expect(button.closest('details')?.open).toBe(false)
  }
  expect(container.textContent).not.toContain('实验室')
  expect(control('折叠中间步骤').closest('section')?.id).toBe('s-appearance')
  expect(control('单美元符号公式').closest('section')?.id).toBe('s-appearance')
  expect(control('自动上下文压缩').closest('section')?.id).toBe('s-conversation')
  expect(container.querySelector('#s-conversation')?.textContent).toContain('0 或留空使用 100 步')
  expect(control('大文件上传').getAttribute('aria-checked')).toBe('true')
  expect(control('保存图片副本').getAttribute('aria-checked')).toBe('false')
})

it('persists independent compatibility overrides and image/upload preferences', async () => {
  await render()
  await toggle('后台内核（Offscreen）')
  await toggle('拟真操作')
  await toggle('异步脚本执行')
  await toggle('LLM 后端兼容模式')
  const withCopies = await toggle('保存图片副本')
  expect(withCopies).toMatchObject({
    labKernelHost: 'panel', labInputEngine: false, labAsyncScript: false,
    labBackendCompat: false, labImageFs: true, largeFileUploads: true,
  })
  const smallFiles = await toggle('大文件上传')
  expect(smallFiles).toMatchObject({ labImageFs: true, largeFileUploads: false })
  const withoutPointer = await toggle('AI 操作指针')
  expect(withoutPointer).toMatchObject({ aiPointer: false, labInputEngine: false })
  const newEngine = await toggle('拟真操作')
  expect(newEngine).toMatchObject({ aiPointer: false, labInputEngine: true })
})

it('preserves existing opt-outs and image copies while defaulting the new upload setting on', async () => {
  const profile = { id: 'p1', name: 'saved', endpoint: '', apiKey: '', model: '', reasoningEffort: '' as const }
  vi.mocked(loadConfig).mockResolvedValue({
    ...profile, profiles: [profile], activeProfileId: profile.id, contextWindow: 128000,
    systemPrompt: '', maxToolRounds: 0, securityLevel: 'strict', yoloMode: false,
    devMode: false, accentColor: 'indigo', fontFamily: 'sans', fontSize: 'default',
    labKernelHost: 'panel', labInputEngine: false, labAsyncScript: false,
    labBackendCompat: false, labImageFs: true,
  } as ApiConfig)
  await render()
  expect(control('LLM 后端兼容模式').getAttribute('aria-checked')).toBe('false')
  expect(control('保存图片副本').getAttribute('aria-checked')).toBe('true')
  expect(control('大文件上传').getAttribute('aria-checked')).toBe('true')
  const saved = await toggle('大文件上传')
  expect(saved).toMatchObject({
    labKernelHost: 'panel', labInputEngine: false, labAsyncScript: false,
    labBackendCompat: false, labImageFs: true, largeFileUploads: false,
  })
})

it('offers the update walkthrough again from settings', async () => {
  const onShowUpdateIntro = vi.fn()
  await act(async () => root.render(React.createElement(SettingsView, { onShowUpdateIntro })))
  const replay = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看本次更新')!
  expect(replay).toBeDefined()
  await act(async () => replay.click())
  expect(onShowUpdateIntro).toHaveBeenCalledOnce()
})


it('offers a separate entry for onboarding', async () => {
  const onShowOnboarding = vi.fn(), onShowUpdateIntro = vi.fn()
  await act(async () => root.render(React.createElement(SettingsView, { onShowOnboarding, onShowUpdateIntro })))
  const replay = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看新手引导')!
  await act(async () => replay.click())
  expect(onShowOnboarding).toHaveBeenCalledOnce()
  expect(onShowUpdateIntro).not.toHaveBeenCalled()
})
