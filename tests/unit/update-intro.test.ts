// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import UpdateIntro from '../../src/sidepanel/components/UpdateIntro'
import { useUpdateIntro, UPDATE_INTRO_ID, UPDATE_INTRO_SEEN_KEY, ONBOARDING_SEEN_KEY } from '../../src/sidepanel/hooks/use-update-intro'

vi.mock('@iconify/react', () => ({ Icon: () => null }))

let root: Root
let container: HTMLDivElement
beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
})
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(chrome.storage.local.get).mockResolvedValue({})
  vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === label || b.textContent === label)!
const click = async (element: HTMLElement) => { await act(async () => element.click()) }

function GateHarness() {
  const { open, kind, dismiss, replay, replayOnboarding } = useUpdateIntro()
  return React.createElement('div', {},
    React.createElement('span', { 'data-open': open, 'data-kind': kind }, String(open)),
    React.createElement('button', { onClick: dismiss }, '关闭'),
    React.createElement('button', { onClick: replay }, '重看'),
    React.createElement('button', { onClick: replayOnboarding }, '新手引导'),
  )
}

describe('update announcement visibility', () => {
  it('shows a new announcement once, persists only on dismiss, and supports replay', async () => {
    await act(async () => root.render(React.createElement(GateHarness)))
    expect(container.querySelector('[data-open]')?.textContent).toBe('true')
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    await click(button('关闭'))
    expect(container.querySelector('[data-open]')?.textContent).toBe('false')
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [UPDATE_INTRO_SEEN_KEY]: UPDATE_INTRO_ID, [ONBOARDING_SEEN_KEY]: true })
    await click(button('重看'))
    expect(container.querySelector('[data-open]')?.textContent).toBe('true')
    await act(async () => root.render(null))
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ [UPDATE_INTRO_SEEN_KEY]: UPDATE_INTRO_ID })
    await act(async () => root.render(React.createElement(GateHarness)))
    expect(container.querySelector('[data-open]')?.textContent).toBe('false')
  })

  it('does not block chat when announcement storage cannot be read or written', async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(new Error('unavailable'))
    await act(async () => root.render(React.createElement(GateHarness)))
    expect(container.querySelector('[data-open]')?.textContent).toBe('false')
    await click(button('重看'))
    vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('unavailable'))
    await click(button('关闭'))
    expect(container.querySelector('[data-open]')?.textContent).toBe('false')
  })
})

describe('update announcement sandbox', () => {
  it('keeps chat controls inert while allowing the local canvas slider', async () => {
    await act(async () => root.render(React.createElement(UpdateIntro, { open: true, onClose: vi.fn(), devMode: true })))
    const draft = document.querySelector<HTMLTextAreaElement>('[aria-label="示例消息草稿"]')!
    expect(draft.value).toContain('移动端')
    expect(draft.closest('[inert]')?.className).toBe('update-intro-chat')
    expect(button('加入队列').closest('[inert]')).not.toBeNull()
    expect(button('示例模型：自选模型').closest('[inert]')).not.toBeNull()
    expect(button('示例自动任务').closest('[inert]')).not.toBeNull()
    expect(button('展开任务计划').closest('[inert]')).not.toBeNull()
    expect(document.querySelector('[aria-label="调整同行人数"]')?.closest('[inert]')).toBeNull()
    expect(button('关闭更新介绍').closest('[inert]')).toBeNull()
    expect(button('接下来，看看新配色').closest('[inert]')).toBeNull()
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })

  it('keeps navigation active and resets scroll and focus between static pages', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(React.createElement(UpdateIntro, { open: true, onClose })))
    const scroll = document.querySelector<HTMLElement>('.update-intro-scroll')!
    scroll.scrollTop = 180
    await click(button('接下来，看看新配色'))
    await click(button('继续'))
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[aria-label="第 3 页，共 3 页"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('让答案，在画布里动起来。')
    expect(scroll.scrollTop).toBe(0)
    await click(button('上一页'))
    expect(document.activeElement?.textContent).toBe('新界面，也有你的颜色。')
    await click(button('上一页'))
    expect(document.activeElement?.textContent).toBe('换了新装，也更顺手了。')
    expect(button('示例自动任务').getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="示例消息草稿"]')?.value).toContain('移动端')
    await click(button('接下来，看看新配色'))
    await click(button('继续'))
    expect(button('上一页').closest('[inert]')).toBeNull()
    expect(button('开始使用').closest('[inert]')).toBeNull()
    await click(button('开始使用'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })

  it('dismisses with Escape or the footer and returns focus on unmount', async () => {
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    const onClose = vi.fn()
    await act(async () => root.render(React.createElement(UpdateIntro, { open: true, onClose })))
    expect(document.activeElement).toBe(button('关闭更新介绍'))
    const dialog = document.querySelector('dialog')!
    await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })))
    expect(onClose).toHaveBeenCalledOnce()
    await click(button('接下来，看看新配色'))
    await click(button('继续'))
    await click(button('开始使用'))
    expect(onClose).toHaveBeenCalledTimes(2)
    await act(async () => root.render(null))
    expect(document.activeElement).toBe(previous)
    previous.remove()
  })
})


describe('update theme selection', () => {
  const originalConfig = { endpoint: 'https://example.test/v1', apiKey: 'existing-secret', model: 'model-a', accentColor: 'indigo', colorMode: 'dark' }
  const choice = (text: string) => Array.from(document.querySelectorAll('.intro-theme-choices label')).find(label => label.textContent?.startsWith(text))!.querySelector('input')!
  const selectedTheme = () => document.querySelector('.intro-theme-selected')?.textContent
  const openThemes = async (onClose = vi.fn()) => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ sidekick_config: originalConfig })
    await act(async () => root.render(React.createElement(UpdateIntro, { open: true, onClose })))
    await click(button('接下来，看看新配色'))
  }

  it('keeps the radio choice, theme preview and wall selection synchronized without changing real settings', async () => {
    await openThemes()
    expect(choice('试试新配色').checked).toBe(true)
    expect(selectedTheme()).toContain('瑞士红')
    expect(document.querySelector('.intro-theme-card[aria-pressed="true"]')?.textContent).toContain('推荐')
    await click(choice('使用我原来的配色'))
    expect(selectedTheme()).toContain('靛蓝')
    await click(button('预览克莱因蓝'))
    expect(choice('试试新配色').checked).toBe(true)
    expect(selectedTheme()).toContain('克莱因蓝')
    await click(choice('使用我原来的配色'))
    await click(choice('试试新配色'))
    expect(selectedTheme()).toContain('克莱因蓝')
    await click(button('关闭更新介绍'))
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('drags a row without selecting a card and leaves normal clicks usable afterward', async () => {
    await openThemes()
    const row = document.querySelector<HTMLElement>('.intro-theme-row')!
    Object.defineProperty(row.firstElementChild, 'offsetWidth', { configurable: true, value: 500 })
    row.setPointerCapture = vi.fn()
    row.hasPointerCapture = () => true
    row.releasePointerCapture = vi.fn()
    const pointer = async (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      await act(async () => row.dispatchEvent(event))
    }
    await pointer('pointerdown', 250, 100)
    await pointer('pointermove', 150, 102)
    expect(row.getAttribute('data-dragging')).toBe('true')
    expect(row.scrollLeft).toBe(100)
    await pointer('pointerup', 150, 102)
    expect(row.hasAttribute('data-dragging')).toBe(false)
    await click(button('预览克莱因蓝'))
    expect(selectedTheme()).toContain('瑞士红')
    await pointer('pointerdown', 250, 100)
    await pointer('pointerup', 250, 100)
    await click(button('预览克莱因蓝'))
    expect(selectedTheme()).toContain('克莱因蓝')
  })

  it('saves only after finishing, preserving the latest unrelated settings', async () => {
    const onClose = vi.fn()
    await openThemes(onClose)
    await click(button('继续'))
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ sidekick_config: { ...originalConfig, model: 'newer-model' } })
    await click(button('开始使用'))
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ sidekick_config: { ...originalConfig, model: 'newer-model', accentColor: 'swiss', yoloMode: false } })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps an old theme id untouched when the user chooses their original palette', async () => {
    const onClose = vi.fn()
    await openThemes(onClose)
    await click(choice('使用我原来的配色'))
    await click(button('继续'))
    await click(button('开始使用'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })

  it('stays open and reports a failed save so the user can retry', async () => {
    const onClose = vi.fn()
    await openThemes(onClose)
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('storage unavailable'))
    await click(button('继续'))
    await click(button('开始使用'))
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('配色保存失败')
    await click(button('开始使用'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('creates a complete initial config when a new user chooses another palette', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({})
    const onClose = vi.fn()
    await act(async () => root.render(React.createElement(UpdateIntro, { open: true, onClose })))
    await click(button('接下来，看看新配色'))
    await click(button('预览克莱因蓝'))
    await click(button('继续'))
    await click(button('开始使用'))
    const saved = vi.mocked(chrome.storage.local.set).mock.calls[0][0].sidekick_config
    expect(saved.accentColor).toBe('klein')
    expect(saved.profiles).toHaveLength(1)
    expect(saved.activeProfileId).toBe(saved.profiles[0].id)
    expect(saved.notifyOnComplete).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })
})


describe('first-run onboarding', () => {
  it('has four pages, no existing-theme radios, and allows deferring model setup without sending a request', async () => {
    await act(async () => root.render(React.createElement(UpdateIntro, { open: true, onClose: vi.fn(), kind: 'onboarding' })))
    expect(document.querySelector('[aria-label="第 1 页，共 4 页"]')).not.toBeNull()
    await click(button('挑一个喜欢的颜色'))
    expect(document.querySelector('.intro-theme-choices')).toBeNull()
    await click(button('继续，连接模型'))
    expect(document.querySelector('[aria-label="第 3 页，共 4 页"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="API Key"]')).not.toBeNull()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="接口格式"]')?.value).toBe('chat-completions')
    await click(button('稍后配置，先看看'))
    expect(document.querySelector('[aria-label="第 4 页，共 4 页"]')).not.toBeNull()
    expect(document.body.textContent).toContain('模型尚未连接')
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })
})


it('replays onboarding explicitly for existing users and keeps update replay separate', async () => {
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ [UPDATE_INTRO_SEEN_KEY]: UPDATE_INTRO_ID })
  await act(async () => root.render(React.createElement(GateHarness)))
  await click(button('新手引导'))
  expect(container.querySelector('[data-open]')?.getAttribute('data-kind')).toBe('onboarding')
  expect(container.querySelector('[data-open]')?.textContent).toBe('true')
  await click(button('关闭'))
  await click(button('重看'))
  expect(container.querySelector('[data-open]')?.getAttribute('data-kind')).toBe('update')
})
