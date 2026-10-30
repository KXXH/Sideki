// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import UsageView from '../../src/sidepanel/views/UsageView'
import { recordUsage, USAGE_ENABLED_KEY, USAGE_STORAGE_KEY, type UsageStore } from '../../src/shared/token-usage'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('../../src/shared/storage', () => ({ SESSION_INDEX_KEY: 'sidekick_session_index', loadSessionIndex: async () => [{ id: 's1', title: '排查登录问题' }] }))

let container: HTMLDivElement
let root: Root
let store: UsageStore
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const at = Date.now()
  store = recordUsage(undefined, { id: 'a', at, session: 's1', provider: 'p1', name: 'DeepSeek', model: 'deepseek-chat', tokens: { input: 1000, output: 100, read: 800, write: null, reasoning: null } })
  store = recordUsage(store, { id: 'b', at, session: 's2', provider: 'p2', name: 'DashScope', model: 'qwen-plus', tokens: { input: 2000, output: 200, read: 0, write: null, reasoning: 20 } })
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store })
  vi.mocked(chrome.storage.onChanged.addListener).mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const render = () => act(async () => { root.render(React.createElement(UsageView, { onBack: vi.fn() })) })

it('filters totals and session breakdowns using the same records', async () => {
  await render()
  expect(container.textContent).toContain('3.0K')
  expect(container.textContent).toContain('26.7%')
  const provider = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!
  await act(async () => { provider.value = 'p1'; provider.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.textContent).toContain('1.0K')
  expect(container.textContent).toContain('80.0%')
  expect(container.textContent).not.toContain('26.7%')
  expect(container.textContent).not.toContain('2.0K')
  const session = [...container.querySelectorAll('button')].find(b => b.textContent === 'Session')!
  await act(async () => session.click())
  expect(container.textContent).toContain('排查登录问题')
  expect(container.textContent).not.toContain('已删除会话')
  expect(container.textContent).not.toContain('Asia/Shanghai')
  expect(container.textContent).not.toContain('未提供 ≠ 0')
})

it('updates on durable writes and presents a clean empty state after removal', async () => {
  await render()
  const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0]
  await act(async () => listener({ [USAGE_STORAGE_KEY]: { newValue: { ...store, rows: [] } } }, 'local'))
  expect(container.textContent).toContain('暂无用量记录')
  const exportButton = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('导出 CSV'))!
  expect(exportButton.disabled).toBe(true)
})

it('persists the recording switch without hiding existing records', async () => {
  await render()
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await act(async () => toggle.click())
  expect(chrome.storage.local.set).toHaveBeenCalledWith({ [USAGE_ENABLED_KEY]: false })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(container.textContent).toContain('3.0K')
  expect([...container.querySelectorAll('button')].find(b => b.textContent?.includes('导出 CSV'))!.disabled).toBe(false)
})

it('loads the saved switch and leaves it unchanged if saving fails', async () => {
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store, [USAGE_ENABLED_KEY]: false })
  await render()
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('unavailable'))
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(container.textContent).toContain('保存失败，请重试。')
})
