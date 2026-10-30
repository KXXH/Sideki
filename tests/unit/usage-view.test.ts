// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import UsageView from '../../src/sidepanel/views/UsageView'
import { recordUsage, USAGE_ENABLED_KEY, USAGE_STORAGE_KEY, type UsageStore } from '../../src/shared/token-usage'
import * as tokenUsage from '../../src/shared/token-usage'

const sessions = vi.hoisted(() => ({ rows: [{ id: 's1', title: '排查登录问题', updatedAt: 0 }] }))
const chromeMock = chrome
vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('../../src/shared/storage', () => ({ SESSION_INDEX_KEY: 'sidekick_session_index', loadSessionIndex: async () => sessions.rows }))

let container: HTMLDivElement
let root: Root
let store: UsageStore
beforeEach(() => {
  vi.stubGlobal('chrome', chromeMock)
  sessions.rows = [{ id: 's1', title: '排查登录问题', updatedAt: 0 }]
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const at = Date.now()
  store = recordUsage(undefined, { id: 'a', at, session: 's1', provider: 'p1', name: 'DeepSeek', model: 'deepseek-chat', tokens: { input: 1000, output: 100, read: 800, write: null, reasoning: null } })
  store = recordUsage(store, { id: 'b', at, session: 's2', provider: 'p2', name: 'DashScope', model: 'qwen-plus', tokens: { input: 2000, output: 200, read: 0, write: null, reasoning: 20 } })
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store })
  vi.mocked(chrome.storage.onChanged.addListener).mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const render = () => act(async () => { root.render(React.createElement(UsageView, { onBack: vi.fn() })) })

function bulkSessions(count = 25) {
  const midnight = new Date().setHours(0, 0, 0, 0)
  sessions.rows = Array.from({ length: count }, (_, index) => ({ id: `session-${index}`, title: `会话 ${String(index).padStart(2, '0')}`, updatedAt: midnight + (count - index) * 1000 }))
  let bulk: UsageStore | undefined
  for (let index = 0; index < count; index++) bulk = recordUsage(bulk, { id: `bulk-${index}`, at: midnight + index * 1000,
    session: `session-${index}`, provider: 'bulk', name: '服务商', model: 'model', tokens: { input: (count - index) * 100, output: 10, read: 0, write: null, reasoning: null } })
  store = bulk!
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store })
}
const visibleTitles = () => [...container.querySelectorAll('article')].map(element => element.getAttribute('aria-label'))
async function button(label: string) {
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!.click())
}
async function input(label: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('defaults to recent session usage, paginates the DOM, and keeps totals across all pages', async () => {
  bulkSessions()
  await render()
  expect(visibleTitles()).toHaveLength(10)
  expect(visibleTitles()[0]).toBe('会话 24')
  const total = container.querySelector('section')!.textContent
  expect(total).toContain('25 次请求')
  await button('下一页')
  expect(visibleTitles()).toHaveLength(10)
  expect(visibleTitles()[0]).toBe('会话 14')
  expect(container.querySelector('section')!.textContent).toBe(total)
  await input('页码', '3')
  expect(visibleTitles()).toHaveLength(5)
  expect(visibleTitles()[0]).toBe('会话 04')
  expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '下一页')!.disabled).toBe(true)
  await button('上一页')
  expect(visibleTitles()[0]).toBe('会话 14')
})

it('resets pagination when sorting or searching and searches both names and IDs', async () => {
  bulkSessions()
  await render()
  await input('页码', '3')
  const sort = container.querySelector<HTMLSelectElement>('select[aria-label="明细排序"]')!
  await act(async () => { sort.value = 'tokens'; sort.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="页码"]')?.value).toBe('1')
  expect(visibleTitles()[0]).toBe('会话 00')
  await input('搜索会话', '会话 02')
  expect(visibleTitles()).toEqual(['会话 02'])
  expect(container.querySelector('section')?.textContent).toContain('1 次请求')
  await input('搜索会话', 'SESSION-12')
  expect(visibleTitles()).toEqual(['会话 12'])
  await input('搜索会话', '不存在的聊天')
  expect(container.textContent).toContain('没有匹配的会话用量')
  expect(visibleTitles()).toHaveLength(0)
  await input('搜索会话', '')
  expect(visibleTitles()).toHaveLength(10)
})

it('clamps the current page after live pruning and includes new usage in recent order', async () => {
  bulkSessions()
  await render()
  await input('页码', '3')
  const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0]
  const rows = store.rows.slice(0, 2)
  await act(async () => listener({ [USAGE_STORAGE_KEY]: { newValue: { ...store, rows } } }, 'local'))
  expect(container.querySelector<HTMLInputElement>('input[aria-label="页码"]')?.value).toBe('1')
  expect(visibleTitles()).toHaveLength(2)
  const refreshed = recordUsage({ ...store, rows }, { id: 'fresh', at: Date.now(), session: 'session-0', provider: 'bulk', name: '服务商', model: 'model', tokens: { input: 1, output: 1, read: 0, write: null, reasoning: null } })
  await act(async () => listener({ [USAGE_STORAGE_KEY]: { newValue: refreshed } }, 'local'))
  expect(visibleTitles()[0]).toBe('会话 00')
})

it('exports all matching records rather than only the current page', async () => {
  vi.useFakeTimers()
  bulkSessions()
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const csv = vi.spyOn(tokenUsage, 'usageCsv')
  await render()
  await input('页码', '2')
  await button('导出 CSV')
  expect(csv.mock.calls.at(-1)?.[0]).toHaveLength(25)
  await input('搜索会话', 'session-12')
  await button('导出 CSV')
  expect(csv.mock.calls.at(-1)?.[0].map(row => row.session)).toEqual(['session-12'])
  await act(async () => vi.advanceTimersByTimeAsync(1000))
})

it('filters main and approval totals, charts and session groups independently', async () => {
  store = recordUsage(store, { id: 'approval', at: Date.now(), session: 's1', source: 'approval', provider: 'p1', name: 'DeepSeek', model: 'deepseek-chat',
    tokens: { input: 4000, output: 400, read: 1000, write: 20, reasoning: 30 } })
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store })
  await render()
  const choose = async (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="用量来源"] button')].find(button => button.textContent === label)!.click())
  expect(container.querySelector('section')?.textContent).toContain('7.0K')
  await choose('自动审批')
  expect(container.querySelector('section')?.textContent).toContain('1 次请求')
  expect(container.querySelector('section')?.textContent).toContain('4.0K')
  expect(container.querySelector('section')?.textContent).toContain('25.0%')
  expect(container.querySelector('[role="img"]')?.textContent).not.toContain('3.0K')
  expect(container.querySelector('[role="img"] [title*="输入 4.0K"]')).toBeTruthy()
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Session')!.click())
  expect(container.querySelector('article[aria-label="排查登录问题"] [aria-label="自动审批用量"]')).toBeTruthy()
  expect(container.querySelector('article[aria-label="排查登录问题"] [aria-label="主会话用量"]')).toBeNull()
  expect(container.textContent).not.toContain('已删除会话')
  await choose('主会话')
  expect(container.querySelector('section')?.textContent).toContain('2 次请求')
  expect(container.querySelector('section')?.textContent).toContain('3.0K')
  expect(container.querySelector('section')?.textContent).toContain('26.7%')
  expect(container.querySelector('article[aria-label="排查登录问题"] [aria-label="自动审批用量"]')).toBeNull()
  await choose('全部')
  expect(container.querySelector('section')?.textContent).toContain('3 次请求')
  expect(container.querySelectorAll('article[aria-label="排查登录问题"]')).toHaveLength(1)
  const parent = container.querySelector('article[aria-label="排查登录问题"]')!
  const breakdown = parent.querySelector('details')!
  expect(breakdown.open).toBe(false)
  await act(async () => breakdown.querySelector('summary')!.click())
  expect(breakdown.open).toBe(true)
  expect(parent.querySelector('[aria-label="主会话用量"]')?.textContent).toContain('1.1K')
  expect(parent.querySelector('[aria-label="自动审批用量"]')?.textContent).toContain('4.4K')
  expect(parent.textContent).toContain('5.5K')
  expect(parent.textContent).toContain('合计 · 2 次')
})

it('keeps approval children with their parent when paginating sessions', async () => {
  bulkSessions(12)
  for (const [index, row] of store.rows.slice().entries()) store = recordUsage(store, { id: `approval-${index}`, at: row.lastAt! + 500,
    session: row.session, source: 'approval', provider: row.provider, name: row.name, model: row.model,
    tokens: { input: 1, output: 1, read: 0, write: null, reasoning: null } })
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store })
  await render()
  expect(visibleTitles()).toHaveLength(10)
  expect(container.querySelector('nav[aria-label="用量明细分页"]')?.textContent).toContain('共 12 个会话')
  expect(container.querySelector('section')?.textContent).toContain('24 次请求')
  for (const parent of container.querySelectorAll('article')) {
    expect(parent.querySelector('[aria-label="主会话用量"]')).toBeTruthy()
    expect(parent.querySelector('[aria-label="自动审批用量"]')).toBeTruthy()
  }
  await button('下一页')
  expect(visibleTitles()).toHaveLength(2)
  for (const parent of container.querySelectorAll('article')) {
    expect(parent.querySelector('[aria-label="主会话用量"]')).toBeTruthy()
    expect(parent.querySelector('[aria-label="自动审批用量"]')).toBeTruthy()
  }
  expect(container.querySelector('section')?.textContent).toContain('24 次请求')
})

it('keeps model breakdowns scoped to the main or approval child without double counting the parent', async () => {
  for (const [id, source, provider] of [['extra-main', 'main', 'p2'], ['approval', 'approval', 'p1']] as const) {
    store = recordUsage(store, { id, at: Date.now(), source, session: 's1', provider, name: provider, model: `model-${id}`,
      tokens: { input: 1000, output: 100, read: 500, write: null, reasoning: null } })
  }
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store })
  await render()
  const parent = container.querySelector('article[aria-label="排查登录问题"]')!
  expect(parent.textContent).toContain('合计 · 3 次')
  const main = parent.querySelector('[aria-label="主会话用量"]')!
  const approval = parent.querySelector('[aria-label="自动审批用量"]')!
  expect(main.textContent).toContain('model-extra-main')
  expect(main.textContent).not.toContain('model-approval')
  expect(approval.textContent).not.toContain('model-extra-main')
  expect(main.textContent).toContain('2.2K')
  expect(approval.textContent).toContain('1.1K')
  expect(container.querySelector('section')?.textContent).toContain('5.0K')
})

it('groups old orphaned approval records as historical approvals rather than deleted chats', async () => {
  for (const id of ['old-one', 'old-two']) {
    store = recordUsage(store, { id, at: Date.now(), session: `approval:${id}`, provider: 'p1', name: 'DeepSeek', model: 'deepseek-chat',
      tokens: { input: 100, output: 10, read: 0, write: null, reasoning: null } })
    delete store.rows.at(-1)!.source
  }
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [USAGE_STORAGE_KEY]: store })
  await render()
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="用量来源"] button')].find(button => button.textContent === '自动审批')!.click())
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Session')!.click())
  expect(container.textContent).toContain('历史自动审批（未关联会话）')
  expect(container.textContent).not.toContain('已删除会话')
  expect(container.querySelector('section')?.textContent).toContain('2 次请求')
})

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
