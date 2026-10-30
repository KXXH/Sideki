// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import ComposerActions from '../../src/sidepanel/components/ComposerActions'
import ScheduledTaskStrip, { TimerWakeEvent } from '../../src/sidepanel/components/ScheduledTaskStrip'
import QueueStrip from '../../src/sidepanel/components/QueueStrip'
import { TASKS_KEY, TASK_INTRO_KEY } from '../../src/shared/scheduled-task'
import type { ScheduledTask } from '../../src/shared/scheduled-task'

vi.mock('@iconify/react', () => ({ Icon: () => null }))

let container: HTMLDivElement
let root: Root
beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === label || b.textContent === label)!
async function click(element: HTMLElement) { await act(async () => element.click()) }

describe('composer primary action', () => {
  it('queues a draft through the primary action, then exposes Stop again when the draft clears', async () => {
    const onStop = vi.fn(), onSend = vi.fn()
    const props = { running: true, stopping: false, sending: false, hasDraft: true, onStop, onSend }
    await act(async () => root.render(React.createElement(ComposerActions, props)))
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(button('停止当前回复')).toBeUndefined()
    await click(button('加入队列'))
    expect(onSend).toHaveBeenCalledOnce()
    expect(onStop).not.toHaveBeenCalled()
    await act(async () => root.render(React.createElement(ComposerActions, { ...props, hasDraft: false })))
    expect(button('加入队列')).toBeUndefined()
    await click(button('停止当前回复'))
    expect(onStop).toHaveBeenCalledOnce()
    await act(async () => root.render(React.createElement(ComposerActions, { ...props, running: false })))
    expect(button('停止当前回复')).toBeUndefined()
    expect(button('加入队列')).toBeUndefined()
    await click(button('发送消息'))
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('blocks duplicate queue submissions while preparing and restores the queue action after failure', async () => {
    const props = { running: true, stopping: false, sending: true, hasDraft: true, onStop: vi.fn(), onSend: vi.fn() }
    await act(async () => root.render(React.createElement(ComposerActions, props)))
    expect(button('加入队列').disabled).toBe(true)
    expect(button('加入队列').getAttribute('aria-busy')).toBe('true')
    await click(button('加入队列'))
    expect(props.onSend).not.toHaveBeenCalled()
    expect(props.onStop).not.toHaveBeenCalled()
    await act(async () => root.render(React.createElement(ComposerActions, { ...props, sending: false })))
    await click(button('加入队列'))
    expect(props.onSend).toHaveBeenCalledOnce()
  })

  it('keeps Stop enabled without a draft and prevents repeat stop requests', async () => {
    const props = { running: true, stopping: false, sending: true, hasDraft: false, onStop: vi.fn(), onSend: vi.fn() }
    await act(async () => root.render(React.createElement(ComposerActions, props)))
    expect(button('停止当前回复').disabled).toBe(false)
    await act(async () => root.render(React.createElement(ComposerActions, { ...props, stopping: true })))
    expect(button('正在停止').disabled).toBe(true)
    await click(button('正在停止'))
    expect(props.onStop).not.toHaveBeenCalled()
    await act(async () => root.render(React.createElement(ComposerActions, { ...props, running: false, sending: false })))
    expect(button('发送消息').disabled).toBe(true)
  })
})

describe('title bar scheduled task menu', () => {
  const task = (id: string, nextRunAt: number, sessionId = 's1'): ScheduledTask => ({
    id, nextRunAt, sessionId, title: `任务 ${id}`, instruction: '检查构建结果', tabId: 42,
    pageTitle: 'Build #1842', pageUrl: 'https://example.com/build', maxRuns: 5, runs: 1,
    intervalMs: 120_000, createdAt: 1, status: 'scheduled',
  })
  async function render(tasks: ScheduledTask[]) {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ [TASKS_KEY]: tasks, [TASK_INTRO_KEY]: true })
    await act(async () => root.render(React.createElement(ScheduledTaskStrip, { sessionId: 's1', proMode: false })))
  }

  it('shows the nearest session task, opens a portal and restores focus on Escape', async () => {
    await render([task('later', 200000), task('next', 100000), task('other-session', 1000, 's2')])
    const trigger = container.querySelector('button')!
    expect(trigger.getAttribute('aria-label')).toContain(new Date(100000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    expect(trigger.textContent).not.toContain(':')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(trigger)
    const popup = document.querySelector('[role="dialog"]')!
    expect(container.contains(popup)).toBe(false)
    expect(popup.textContent).toContain('任务 next')
    expect(popup.textContent).not.toContain('other-session')
    expect(popup.textContent).not.toContain('检查构建结果')
    await click(button('展开任务详情：任务 next'))
    expect(popup.textContent).toContain('检查构建结果')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['completed', 'cancelled'] as const)('hides the title-bar entry when this session only has %s tasks', async status => {
    await render([{ ...task('inactive', 100000), status }, task('foreign', 1000, 's2')])
    expect(container.querySelector('button')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the last task reachable after pausing and reopening the menu', async () => {
    await render([task('t1', 100000)])
    await click(container.querySelector('button')!)
    const paused = { ...task('t1', 100000), status: 'paused' as const }
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ [TASKS_KEY]: [paused], [TASK_INTRO_KEY]: true })
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0]
    await act(async () => listener({ [TASKS_KEY]: { newValue: [paused] } }, 'local'))
    expect(container.querySelector('button')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(button('恢复任务')).toBeDefined()
    await click(button('收起自动任务'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const trigger = container.querySelector('button')!
    expect(trigger).not.toBeNull()
    await click(trigger)
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true })
    await click(button('恢复任务'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'schedule:command', sessionId: 's1', taskId: 't1', action: 'resume' })
  })

  it('keeps paused tasks discoverable after loading and exposes invalid binding reasons', async () => {
    await render([{ ...task('paused', 100000), status: 'paused', requiresRebind: true, reason: '浏览器已重启，请重新创建任务绑定页面' }])
    const trigger = container.querySelector('button')!
    expect(trigger).not.toBeNull()
    expect(trigger.getAttribute('aria-label')).toContain('0 个')
    await click(trigger)
    expect(button('恢复任务').disabled).toBe(true)
    await click(button('展开任务详情：任务 paused'))
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('浏览器已重启')
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true })
    await click(button('取消任务'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'schedule:command', sessionId: 's1', taskId: 'paused', action: 'cancel' })
  })

  it('routes pause to the bound session and reports failures without closing the menu', async () => {
    await render([task('t1', 100000)])
    await click(container.querySelector('button')!)
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: false, error: '后台不可用' })
    await click(button('暂停任务'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'schedule:command', sessionId: 's1', taskId: 't1', action: 'pause' })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('后台不可用')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('moves a newly cancelled task into collapsed history and resets history when reopening the panel', async () => {
    const first = task('first', 100000), second = task('second', 200000)
    await render([first, second])
    const trigger = container.querySelector('button')!
    await click(trigger)
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true })
    await click(button('取消任务'))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'schedule:command', sessionId: 's1', taskId: 'first', action: 'cancel' })

    const updated = [{ ...first, status: 'cancelled' as const }, second]
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ [TASKS_KEY]: updated, [TASK_INTRO_KEY]: true })
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0]
    await act(async () => listener({ [TASKS_KEY]: { newValue: updated } }, 'local'))
    const popup = document.querySelector('[role="dialog"]')!
    expect(popup.textContent).toContain('任务 second')
    expect(popup.textContent).not.toContain('任务 first')
    const history = Array.from(popup.querySelectorAll('button')).find(b => b.textContent?.startsWith('已取消'))!
    expect(history.getAttribute('aria-expanded')).toBe('false')
    await click(history)
    expect(popup.textContent).toContain('任务 first')
    expect(button('暂停任务')).toBeDefined()

    await click(button('收起自动任务'))
    await click(trigger)
    const reopened = document.querySelector('[role="dialog"]')!
    expect(reopened.textContent).toContain('任务 second')
    expect(Array.from(reopened.querySelectorAll('button')).find(b => b.textContent?.startsWith('已取消'))?.getAttribute('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(reopened.textContent).not.toContain('任务 first'))
  })
})

it('shows a timer wake as a single non-expandable record', async () => {
  await act(async () => root.render(React.createElement(TimerWakeEvent, {
    wake: { taskId: 't1', occurrenceId: 'o1', title: '跟进构建结果', scheduledAt: 1000, startedAt: 2000, tabId: 42, pageTitle: 'Build', pageUrl: 'https://example.com' },
  })))
  expect(container.textContent).toContain('定时唤醒')
  expect(container.textContent).toContain('跟进构建结果')
  expect(container.textContent).not.toContain('这是完整的定时任务提示词')
  expect(container.querySelector('time')?.dateTime).toBe(new Date(2000).toISOString())
  expect(container.querySelector('button')).toBeNull()
  expect(container.querySelector('[aria-expanded]')).toBeNull()
  expect(container.textContent).not.toContain('原定')
  expect(container.textContent).not.toContain('https://example.com')
})

it('keeps every queued message accessible after expanding, including messages beyond the old three-row limit', async () => {
  const queue = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: `消息 ${i}` }))
  const onRecall = vi.fn(), onRemove = vi.fn()
  await act(async () => root.render(React.createElement(QueueStrip, { queue, onRecall, onRemove })))
  expect(container.textContent).not.toContain('消息 4')
  await click(container.querySelector('button')!)
  await click(button('消息 4'))
  expect(onRecall).toHaveBeenCalledWith('4')
  await click(button('移除排队消息：消息 4'))
  expect(onRemove).toHaveBeenCalledWith('4')
})


it('shares the task panel and wake record with page monitors', async () => {
  const monitor: ScheduledTask = {
    id: 'm1', kind: 'monitor', sessionId: 's1', title: '等待导出', instruction: '按钮可用时下载',
    tabId: 42, pageTitle: 'Report', pageUrl: 'https://example.com', nextRunAt: Date.now(),
    maxRuns: 5, runs: 0, status: 'scheduled', createdAt: Date.now(),
    monitor: { token: 'secret', code: '(emit) => { emit({ready:true}) }', documentId: 'doc', expiresAt: Date.now() + 600000, listening: true, received: 0, coalesced: 2 },
  }
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [TASKS_KEY]: [monitor], [TASK_INTRO_KEY]: true })
  await act(async () => root.render(React.createElement(ScheduledTaskStrip, { sessionId: 's1', proMode: false })))
  const trigger = container.querySelector('button')!
  expect(trigger.getAttribute('aria-label')).toContain('自动任务')
  expect(trigger.getAttribute('aria-label')).toContain('监听中')
  await click(trigger)
  const popup = document.querySelector('[role="dialog"]')!
  expect(popup.getAttribute('aria-label')).toBe('本会话的自动任务')
  expect(popup.textContent).toContain('等待导出')
  await click(button('展开任务详情：等待导出'))
  expect(popup.textContent).toContain('页面监听 · 已唤醒')
  expect(popup.textContent).toContain('监听代码')
  expect(popup.textContent).toContain('已合并 2 条事件')
  expect(popup.textContent).not.toContain('secret')
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true })
  await click(button('取消任务'))
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'schedule:command', action: 'cancel', sessionId: 's1', taskId: 'm1' })
  await act(async () => root.render(React.createElement(TimerWakeEvent, { wake: { kind: 'monitor', taskId: 'm1', occurrenceId: 'o1', title: '等待导出', scheduledAt: 1000, startedAt: 2000, tabId: 42, pageTitle: '', pageUrl: '', event: { id: 'event', at: 1000, data: { secret: 'payload' } } } })))
  expect(container.textContent).toContain('页面唤醒')
  expect(container.textContent).not.toContain('payload')
  expect(container.querySelector('button')).toBeNull()
})
