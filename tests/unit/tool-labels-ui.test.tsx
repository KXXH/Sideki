// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../src/sidepanel/components/MessageList'
import type { ToolCallDisplay } from '../../src/shared/types'
import { collectToolActivities } from '../../src/shared/kernel/tool-activity'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('../../src/sidepanel/components/StreamingMarkdown', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/VizFrame', () => ({ default: () => null }))
const settings = vi.hoisted(() => ({ collapseSteps: true }))
vi.mock('../../src/shared/storage', () => ({ loadConfig: vi.fn(async () => ({ collapseSteps: settings.collapseSteps })) }))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  settings.collapseSteps = true
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  chrome.storage.local.onChanged = { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(), hasListeners: vi.fn() }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
afterAll(() => vi.unstubAllGlobals())

function message(running = false, reasoning = false): UIMessage {
  return {
    id: 'reply', role: 'assistant', parts: [
      ...(reasoning ? [{ type: 'reasoning' as const, text: '先读取页面，再执行脚本。' }] : []),
      { type: 'dynamic-tool', toolName: 'getPageContent', toolCallId: 'read', state: 'output-available', input: {}, output: 'Page content' },
      { type: 'dynamic-tool', toolName: 'bash', toolCallId: 'script', input: { description: '读取网页标题', command: 'js "document.title"' },
        ...(running ? { state: 'input-available' as const } : { state: 'output-available' as const, output: 'Page title' }) },
    ],
  }
}

async function render(msg: UIMessage, streaming = false, display?: ToolCallDisplay) {
  await act(async () => root.render(<MessageBubble message={msg} isStreaming={streaming} isLast toolCallDisplay={display} />))
}

describe('tool approval presentation', () => {
  it('distinguishes reviewer protocol failure from a model risk denial', async () => {
    await render({ id: 'failed-review', role: 'assistant', parts: [{
      type: 'tool-bash', toolCallId: 'failed', state: 'output-denied', input: { command: 'echo test' },
      approval: { id: 'a', approved: false, reason: '审批未完成：模型未调用 submitApproval' },
    }] } as UIMessage)
    const row = container.querySelector<HTMLButtonElement>('button[title^="bash ·"]')!
    expect(row.textContent).toContain('确认异常')
    expect(row.textContent).not.toContain('已拒绝')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await act(async () => row.click())
    expect(row.parentElement?.textContent).toContain('模型未调用 submitApproval')
  })
  it.each(['dynamic-tool', 'tool-bash'])('keeps %s denials collapsed and distinct from execution errors', async type => {
    const part = {
      type, toolName: 'bash', toolCallId: 'denied-call', state: 'output-denied',
      input: { command: 'bash /tmp/order.sh', description: '检查商品' },
      approval: { id: 'approval-a', approved: false, isAutomatic: true, reason: '用户未授权提交订单' },
    } as UIMessage['parts'][number]
    await render({ id: 'denied-reply', role: 'assistant', parts: [part] })
    const row = container.querySelector<HTMLButtonElement>('button[title^="bash ·"]')!
    expect(row.className).not.toContain('text-error')
    expect(row.querySelector('[role="status"]')?.className).toContain('bg-error')
    expect(row.textContent).toContain('已拒绝')
    expect(row.textContent).not.toContain('调用失败')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.parentElement?.querySelector('.expand-panel.is-open')).toBeNull()
    expect(row.querySelector('.animate-spin')).toBeNull()
    expect(row.textContent).not.toContain('确认操作')
    await act(async () => row.click())
    expect(row.parentElement?.querySelector('.is-open')?.textContent).toContain('用户未授权提交订单')
  })

  it('shows reviewing on the current tool without changing its description or other tool rows', async () => {
    const msg = message(true)
    await act(async () => root.render(<MessageBubble message={msg} isStreaming isLast approvalState={{ status: 'reviewing', toolCallId: 'script' }} />))
    const row = container.querySelector<HTMLButtonElement>('button[title^="bash ·"]')!
    expect(row.querySelector('[role="status"]')?.textContent).toBe('确认操作…')
    expect(row.querySelector('.tool-title-viewport')?.textContent).toContain('读取网页标题')
    expect(container.querySelector('button[title^="getPageContent ·"]')?.textContent).not.toContain('确认操作')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await act(async () => root.render(<MessageBubble message={msg} isStreaming isLast approvalState={{ status: 'idle' }} />))
    expect(row.querySelector('[role="status"] .swap-in')?.textContent).toBe('执行中…')
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps execution failures collapsed until the user opens the error details', async () => {
    await render({ id: 'execution-error', role: 'assistant', parts: [{
      type: 'dynamic-tool', toolName: 'click', toolCallId: 'click-error', state: 'output-error',
      input: { target: '#missing', description: '打开个人中心' }, errorText: '页面未找到目标元素',
    }] })
    const row = container.querySelector<HTMLButtonElement>('button[title^="click ·"]')!
    expect(row.textContent).toContain('调用失败')
    expect(row.textContent).not.toContain('已拒绝')
    expect(row.className).toContain('text-error')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.parentElement?.querySelector('.expand-panel.is-open')).toBeNull()
    await act(async () => row.click())
    expect(row.parentElement?.querySelector('.is-open')?.textContent).toContain('页面未找到目标元素')
  })

  it('counts SDK denials separately from failures and never reports them as pending', async () => {
    settings.collapseSteps = false
    const msg = message()
    msg.parts[1] = {
      type: 'dynamic-tool', toolName: 'bash', toolCallId: 'script', state: 'approval-responded',
      input: { command: 'bash /tmp/a' }, approval: { id: 'a', approved: false, reason: '证据不足' },
    }
    await render(msg, true)
    const header = container.querySelector<HTMLButtonElement>('button')!
    expect(header.textContent).toContain('1 个已拒绝')
    expect(header.textContent).not.toContain('个失败')
    expect(header.textContent).not.toContain('1/2')
    expect(container.querySelector('button[title^="bash ·"]')?.textContent).toContain('已拒绝')
  })
})

describe('tool labels in messages', () => {
  it('keeps batch counts and retains technical details behind a described tool row', async () => {
    await render(message())
    const group = container.querySelector('button')!
    expect(group.querySelector('.roll-ghost')?.textContent).toBe('2')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    await act(async () => group.click())
    expect(group.getAttribute('aria-expanded')).toBe('true')
    const script = container.querySelector<HTMLButtonElement>('button[title^="bash ·"]')!
    expect(script.textContent).toBe('读取网页标题')
    await act(async () => script.click())
    expect(script.getAttribute('aria-expanded')).toBe('true')
    expect(script.parentElement?.querySelector('.is-open')?.textContent).toContain('js "document.title"')
    expect(script.parentElement?.querySelector('.is-open')?.textContent).toContain('Page title')
  })

  it('keeps the existing group status and reasoning step count', async () => {
    await render(message(true, true), true)
    expect(container.querySelector('button')?.textContent).not.toContain('读取网页标题')
    await render(message(false, true))
    const header = container.querySelector('button')!
    expect(header.querySelector('.roll-ghost')?.textContent).toBe('3')
    expect(header.textContent).toContain('个步骤')
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })

  it('waits for a complete description then animates once while the command continues streaming', async () => {
    const stream = (rawInput: string, input: unknown): UIMessage => ({ id: 'live', role: 'assistant', parts: [
      { type: 'dynamic-tool', toolName: 'bash', toolCallId: 'live-call', state: 'input-streaming', input, rawInput } as UIMessage['parts'][number],
    ] })
    await render(stream('{"description":"读取网页', { description: '读取网页' }), true)
    let row = container.querySelector<HTMLButtonElement>('button[title^="bash ·"]')!
    expect(row.title).toBe('bash · bash')
    await render(stream('{"description":"读取网页标题","command":"js ', { description: '读取网页标题', command: 'js ' }), true)
    row = container.querySelector<HTMLButtonElement>('button[title^="bash ·"]')!
    expect(row.title).toBe('bash · 读取网页标题')
    const entered = row.querySelector('.swap-in')
    expect(entered?.textContent).toBe('读取网页标题')
    await render(stream('{"description":"读取网页标题","command":"js document.', { description: '读取网页标题', command: 'js document.' }), true)
    expect(row.querySelector('.swap-in')).toBe(entered)
    await act(async () => row.click())
    expect(row.parentElement?.querySelector('.is-open')?.textContent).toContain('js document.')
  })

  it('preserves the tool row and its outgoing title when text starts in the same patch as the description', async () => {
    const part = (described: boolean): UIMessage['parts'][number] => ({
      type: 'dynamic-tool', toolName: 'bash', toolCallId: 'stable-call', state: 'input-streaming',
      input: described ? { description: '读取网页标题', command: 'js ' } : {},
      rawInput: described ? '{"description":"读取网页标题","command":"js ' : '{',
    } as UIMessage['parts'][number])
    await render({ id: 'stable', role: 'assistant', parts: [part(false)] }, true)
    const row = container.querySelector('button[title^="bash ·"]')!
    await render({ id: 'stable', role: 'assistant', parts: [part(true), { type: 'text', text: '开始分析' }] }, true)
    expect(container.querySelector('button[title^="bash ·"]')).toBe(row)
    expect(row.querySelector('.swap-out')?.textContent).toBe('bash')
    expect(row.querySelector('.swap-in')?.textContent).toBe('读取网页标题')
  })

  it('preserves the row when a single tool completes and the active group header disappears', async () => {
    const pending: UIMessage = { id: 'complete', role: 'assistant', parts: [{
      type: 'dynamic-tool', toolName: 'getPageContent', toolCallId: 'single', state: 'input-available', input: {},
    }] }
    await render(pending, true)
    const row = container.querySelector('button[title^="getPageContent ·"]')!
    await render({ ...pending, parts: [{
      type: 'dynamic-tool', toolName: 'getPageContent', toolCallId: 'single', state: 'output-available',
      input: { description: '读取网页正文' }, output: 'content',
    }] })
    expect(container.querySelector('button[title^="getPageContent ·"]')).toBe(row)
    expect(row.querySelector('.swap-out')?.textContent).toBe('getPageContent')
  })

  it('preserves an expanded-mode row when another call joins its batch', async () => {
    settings.collapseSteps = false
    const part: UIMessage['parts'][number] = {
      type: 'dynamic-tool', toolName: 'bash', toolCallId: 'first', state: 'input-streaming', input: {}, rawInput: '{',
    } as UIMessage['parts'][number]
    await render({ id: 'batch', role: 'assistant', parts: [part] }, true)
    const row = container.querySelector('button[title^="bash ·"]')!
    await render({ id: 'batch', role: 'assistant', parts: [
      { ...part, input: { description: '读取网页标题' }, rawInput: '{"description":"读取网页标题",' } as UIMessage['parts'][number],
      { type: 'dynamic-tool', toolName: 'screenshot', toolCallId: 'second', state: 'input-available', input: {} },
    ] }, true)
    expect(container.querySelector('button[title^="bash ·"]')).toBe(row)
    expect(row.querySelector('.swap-out')?.textContent).toBe('bash')
    expect(row.querySelector('.swap-in')?.textContent).toBe('读取网页标题')
  })

  it('keeps raw tool names for legacy calls, without inferring Chinese from shell commands', async () => {
    await render({ id: 'legacy', role: 'assistant', parts: [
      { type: 'dynamic-tool', toolName: 'bash', toolCallId: 'legacy-call', state: 'output-available', input: { command: 'js document.title' }, output: 'title' },
    ] })
    const row = container.querySelector('button[title^="bash ·"]')!
    expect(row.querySelector('.font-mono')?.textContent).toBe('bash')
    expect(row.textContent).not.toContain('执行')
  })

  it('shows streamed arguments until a complete description arrives', async () => {
    const msg = (complete: boolean): UIMessage => ({ id: 'arguments', role: 'assistant', parts: [{
      type: 'dynamic-tool', toolName: 'bash', toolCallId: 'arguments-call', state: 'input-streaming',
      input: { command: 'js document.title', description: complete ? '读取标题' : '读取' },
      rawInput: complete ? '{"command":"js document.title","description":"读取标题"' : '{"command":"js document.title","description":"读取',
    } as UIMessage['parts'][number]] })
    await render(msg(false), true)
    let row = container.querySelector('button[title^="bash ·"]')!
    expect(row.textContent).toContain('js document.title')
    expect(row.title).toBe('bash · bash')
    await render(msg(true), true)
    row = container.querySelector('button[title^="bash ·"]')!
    expect(row.querySelector('.swap-in')?.textContent).toBe('读取标题')
    expect(row.textContent).not.toContain('js document.title')
  })

  it.each([true, false])('raw presentation retains descriptions in messages and activity with collapseSteps=%s', async collapseSteps => {
    settings.collapseSteps = collapseSteps
    const msg: UIMessage = { id: 'preference', role: 'assistant', parts: [{
      type: 'dynamic-tool', toolName: 'bash', toolCallId: 'preference-call', state: 'input-available',
      input: { command: 'js document.title', description: '读取标题' },
    }] }
    const before = JSON.stringify(msg)
    await render(msg, true, 'raw')
    const row = container.querySelector('button[title^="bash ·"]')!
    expect(row.textContent).toContain('bash')
    expect(row.textContent).toContain('js document.title')
    expect(row.textContent).not.toContain('读取标题')
    await act(async () => (row as HTMLButtonElement).click())
    expect(row.parentElement?.textContent).not.toContain('读取标题')
    expect(collectToolActivities({ status: 'streaming', messages: [msg] })).toEqual([
      { id: 'preference:preference-call', description: '读取标题', phase: 'executing' },
    ])
    await render(msg, true, 'description')
    expect(container.querySelector('button[title^="bash ·"]')).toBe(row)
    expect(row.querySelector('.swap-in')?.textContent).toBe('读取标题')
    expect(JSON.stringify(msg)).toBe(before)
  })

  it('paints loading shimmer on the text leaf and removes it on completion without replacing the title', async () => {
    const msg = (state: 'input-available' | 'output-available'): UIMessage => ({
      id: 'shimmer', role: 'assistant', parts: [{
        type: 'dynamic-tool', toolName: 'bash', toolCallId: 'shimmer-call', state,
        input: { description: '读取网页标题', command: 'js document.title' },
        ...(state === 'output-available' ? { output: 'Title' } : {}),
      } as UIMessage['parts'][number]],
    })
    await render(msg('input-available'), true)
    const row = container.querySelector('button[title^="bash ·"]')!
    const text = row.querySelector('.shimmer-sweep')!
    expect(text.textContent).toBe('读取网页标题')
    expect(text.children).toHaveLength(0)
    expect(text.parentElement?.closest('.shimmer-sweep')).toBeNull()
    await render(msg('output-available'))
    expect(container.querySelector('button[title^="bash ·"]')).toBe(row)
    expect(text.isConnected).toBe(true)
    expect(text.classList.contains('shimmer-sweep')).toBe(false)
  })

  it('leaves an unknown remote tool name intact', async () => {
    await render({ id: 'remote', role: 'assistant', parts: [
      { type: 'dynamic-tool', toolName: 'mcp_remote_lookup', toolCallId: 'remote', state: 'output-available', input: { query: 'Sideki' }, output: 'result' },
    ] })
    expect(container.querySelector('button')?.textContent).toContain('mcp_remote_lookup')
  })
})
