// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageBubble } from '../../src/sidepanel/components/MessageList'
import { projectMessages } from '../../src/sidepanel/message-display'
import { derivePhase, PHASE_POOLS, type StatusPhase } from '../../src/sidepanel/status-phase'

const settings = vi.hoisted(() => ({ collapseSteps: true }))

vi.mock('../../src/shared/storage', () => ({
  loadConfig: vi.fn(async () => ({ collapseSteps: settings.collapseSteps })),
}))
vi.mock('../../src/sidepanel/components/StreamingMarkdown', () => ({
  default: ({ content }: { content: string }) => React.createElement('div', { 'data-testid': 'markdown' }, content),
}))
vi.mock('../../src/sidepanel/utils/export-image', () => ({ copyMessageAsImage: vi.fn() }))

const localChanges = { addListener: vi.fn(), removeListener: vi.fn() }
const originalLocalChanges = Object.getOwnPropertyDescriptor(chrome.storage.local, 'onChanged')
let container: HTMLDivElement
let root: Root

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Reason: the shared Chrome stub has the global event, but this hook subscribes to the local-area event.
  Object.defineProperty(chrome.storage.local, 'onChanged', { configurable: true, value: localChanges })
})

afterAll(() => {
  if (originalLocalChanges) Object.defineProperty(chrome.storage.local, 'onChanged', originalLocalChanges)
  else Reflect.deleteProperty(chrome.storage.local, 'onChanged')
  vi.unstubAllGlobals()
})

beforeEach(() => {
  // Reason: only label clocks are controlled; React, motion and its animation-frame hooks remain real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  expect(localChanges.removeListener).toHaveBeenCalledTimes(localChanges.addListener.mock.calls.length)
  for (const [handler] of localChanges.addListener.mock.calls) {
    expect(localChanges.removeListener).toHaveBeenCalledWith(handler)
  }
})

const user = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: `Question ${id}` }] })
const assistant = (parts: UIMessage['parts'] = [], id = 'sdk-assistant'): UIMessage => ({ id, role: 'assistant', parts })
const stepStart: UIMessage['parts'][number] = { type: 'step-start' }
const text = (value: string): UIMessage['parts'][number] => ({ type: 'text', text: value })
const reasoning: UIMessage['parts'][number] = { type: 'reasoning', text: 'Inspecting the page', state: 'streaming' }
const tool: UIMessage['parts'][number] = {
  type: 'dynamic-tool', toolName: 'bash', toolCallId: 'call-1', state: 'input-available', input: { command: 'pwd' },
}

async function renderMessages(
  messages: readonly UIMessage[], phase: StatusPhase,
  options: { sessionId?: string; onRegenerate?: (id: string) => void } = {},
) {
  const sessionId = options.sessionId ?? 'session'
  const items = projectMessages(messages, sessionId, phase)
  await act(async () => {
    root.render(React.createElement(React.Fragment, null, items.map((item, displayIndex) => (
      React.createElement(MessageBubble, {
        key: item.key,
        message: item.message,
        sessionId,
        isStreaming: phase !== 'idle' && item.sourceIndex === messages.length - 1 && item.message?.role === 'assistant',
        isLast: displayIndex === items.length - 1,
        pendingPhase: item.message === null ? phase : undefined,
        onRegenerate: options.onRegenerate,
      })
    ))))
  })
}

function indicators() {
  return [...container.querySelectorAll<HTMLElement>('span.relative.inline-flex.items-center.justify-center')]
}

function statusAt(index = 0) {
  const indicator = indicators()[index]
  expect(indicator).toBeDefined()
  const lines = [...indicator.querySelectorAll<HTMLElement>(':scope > span')]
  expect(lines).toHaveLength(6)
  for (const line of lines) expect(line.classList.contains('bg-current')).toBe(true)
  const header = indicator.parentElement!
  expect(header.tagName).toBe(settings.collapseSteps ? 'BUTTON' : 'SPAN')
  const slot = indicator.nextElementSibling as HTMLElement
  expect(slot?.classList.contains('relative')).toBe(true)
  expect(slot?.classList.contains('whitespace-nowrap')).toBe(true)
  return { header, indicator, lines, slot }
}

type StatusNodes = ReturnType<typeof statusAt>

function expectSameStatus(previous: StatusNodes, index = 0) {
  const next = statusAt(index)
  expect(next.header).toBe(previous.header)
  expect(next.indicator).toBe(previous.indicator)
  expect(next.slot).toBe(previous.slot)
  next.lines.forEach((line, i) => expect(line).toBe(previous.lines[i]))
  return next
}

function currentLabel(nodes: StatusNodes) {
  return nodes.slot.lastElementChild?.textContent ?? ''
}

function expectFreshStatus(previous: StatusNodes, next: StatusNodes) {
  expect(next.header).not.toBe(previous.header)
  expect(next.indicator).not.toBe(previous.indicator)
  expect(next.slot).not.toBe(previous.slot)
  next.lines.forEach(line => expect(previous.lines).not.toContain(line))
  expect(next.slot.querySelector('.swap-out')).toBeNull()
}

describe.each([true, false])('reply slot lifecycle with collapseSteps=%s', collapseSteps => {
  beforeEach(() => { settings.collapseSteps = collapseSteps })

  it('preserves the header, six motion lines and SwapSlot through waiting, start, tool and reasoning', async () => {
    const question = user('u1')
    await renderMessages([question], 'building')
    const original = statusAt()
    expect(currentLabel(original)).toBe(PHASE_POOLS.building[0])

    await renderMessages([question], 'requesting')
    expectSameStatus(original)
    expect(currentLabel(original)).toBe(PHASE_POOLS.requesting[0])
    expect(original.slot.querySelector('.swap-out')?.textContent).toBe(PHASE_POOLS.building[0])

    await act(async () => { vi.advanceTimersByTime(400) })
    expect(original.slot.querySelector('.swap-out')).toBeNull()
    await renderMessages([question, assistant()], 'working')
    expectSameStatus(original)
    expect(PHASE_POOLS.working).toContain(currentLabel(original))
    expect(original.slot.querySelector('.swap-out')?.textContent).toBe(PHASE_POOLS.requesting[0])

    for (const parts of [
      [stepStart], [stepStart, text('')], [stepStart, text(' \n\t')],
      [stepStart, text(''), tool], [stepStart, text(''), tool, reasoning],
    ]) {
      await renderMessages([question, assistant(parts)], 'working')
      expectSameStatus(original)
      expect(indicators()).toHaveLength(1)
      expect(container.querySelector('[data-testid="markdown"]')).toBeNull()
    }
    expect(container.textContent).toContain('bash')
    expect(container.textContent).toContain('Inspecting the page')

    const oldLabel = currentLabel(original)
    await act(async () => { vi.advanceTimersByTime(5000) })
    expectSameStatus(original)
    expect(currentLabel(original)).not.toBe(oldLabel)
    expect(PHASE_POOLS.working).toContain(currentLabel(original))
    expect(original.slot.querySelector('.swap-out')?.textContent).toBe(oldLabel)
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(original.slot.querySelector('.swap-out')).toBeNull()
  })

  it.each([
    ['tool', tool], ['reasoning', reasoning], ['step-start', stepStart],
  ] as const)('reuses the pending instance when the first actual part is %s', async (_name, part) => {
    const question = user('u1')
    await renderMessages([question], 'requesting')
    const original = statusAt()
    await renderMessages([question, assistant([part])], 'working')
    expectSameStatus(original)
    expect(original.slot.querySelector('.swap-out')?.textContent).toBe(PHASE_POOLS.requesting[0])
    expect(PHASE_POOLS.working).toContain(currentLabel(original))
  })

  it.each([0, 1])('renders meaningful text without an artificial empty group (%s step-start)', async count => {
    const question = user('u1')
    const prefix = count ? [stepStart] : []
    await renderMessages([question], 'requesting')
    const original = statusAt()
    for (const emptyText of ['', ' \n\t']) {
      await renderMessages([question, assistant([...prefix, text(emptyText)])], 'writing')
      expectSameStatus(original)
      expect(container.querySelector('[data-testid="markdown"]')).toBeNull()
    }

    const answer = assistant([...prefix, text('The answer is ready.')])
    await renderMessages([question, answer], 'writing')
    const markdown = container.querySelector('[data-testid="markdown"]')
    expect(markdown?.textContent).toBe('The answer is ready.')
    expect(container.querySelector('.expand-panel')).toBeNull()
    expect(container.querySelector('button.group')).toBeNull()
    if (collapseSteps) {
      expect(indicators()).toHaveLength(0)
      expect(original.header.isConnected).toBe(false)
    } else {
      // Reason: expanded mode intentionally retains its separate streaming status until the turn finishes.
      expectSameStatus(original)
      expect(indicators()).toHaveLength(1)
    }

    await renderMessages([question, answer], 'idle')
    expect(indicators()).toHaveLength(0)
    expect(container.querySelector('[data-testid="markdown"]')).toBe(markdown)
    expect(container.textContent).not.toContain('个步骤')
  })

  it.each([
    ['building', 'error'], ['requesting', 'error'], ['building', 'ready'], ['requesting', 'ready'],
  ] as const)('removes a %s pending slot on %s without removing the user', async (phase, status) => {
    const question = user('u1')
    await renderMessages([question], phase)
    const original = statusAt()
    const userDom = container.firstElementChild
    const idle = derivePhase({ status, preparing: false, dispatching: false, trailing: 'none' })
    await renderMessages([question], idle)
    expect(container.children).toHaveLength(1)
    expect(container.firstElementChild).toBe(userDom)
    expect(indicators()).toHaveLength(0)
    expect(original.header.isConnected).toBe(false)
  })

  it.each([
    ['ready', ''], ['error', ''], ['ready', ' \n\t'], ['error', ' \n\t'],
  ])('removes an empty started assistant on %s (text=%j)', async (status, emptyText) => {
    const question = user('u1')
    await renderMessages([question], 'requesting')
    const original = statusAt()
    const started = assistant([stepStart, text(emptyText)])
    await renderMessages([question, started], 'working')
    expectSameStatus(original)
    await renderMessages([question, started], derivePhase({ status, preparing: false, dispatching: false, trailing: 'none' }))
    expect(indicators()).toHaveLength(0)
    expect(original.header.isConnected).toBe(false)
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual([])
    expect(container.children).toHaveLength(1)
  })

  it('starts a fresh indicator for the next user while preserving the historical bubble DOM', async () => {
    const firstUser = user('u1')
    await renderMessages([firstUser], 'requesting')
    const firstStatus = statusAt()
    const answer = assistant([stepStart, tool, reasoning, text('First answer')])
    await renderMessages([firstUser, answer], 'writing')
    expectSameStatus(firstStatus)
    await renderMessages([firstUser, answer], 'idle')
    const oldBubble = container.children[1]
    const oldMarkdown = oldBubble.querySelector('[data-testid="markdown"]')
    const oldToolButton = oldBubble.querySelector('button[title^="bash ·"]')
    expect(oldToolButton).toBeDefined()
    if (collapseSteps) {
      expectSameStatus(firstStatus)
      expect(firstStatus.slot.querySelector('.roll-ghost')?.textContent).toBe('2')
    } else {
      expect(firstStatus.header.isConnected).toBe(false)
    }

    const secondUser = user('u2')
    await renderMessages([firstUser, answer, secondUser], 'building')
    const nextIndex = collapseSteps ? 1 : 0
    const nextStatus = statusAt(nextIndex)
    expectFreshStatus(firstStatus, nextStatus)
    expect(currentLabel(nextStatus)).toBe(PHASE_POOLS.building[0])
    expect(container.children[1]).toBe(oldBubble)
    expect(oldBubble.querySelector('[data-testid="markdown"]')).toBe(oldMarkdown)
    expect(oldBubble.contains(oldToolButton!)).toBe(true)
    if (collapseSteps) expectSameStatus(firstStatus)

    await renderMessages([firstUser, answer, secondUser], 'requesting')
    expectSameStatus(nextStatus, nextIndex)
    expect(nextStatus.slot.querySelector('.swap-out')?.textContent).toBe(PHASE_POOLS.building[0])
    await renderMessages([firstUser, answer, secondUser, assistant([stepStart, tool], 'sdk-second')], 'working')
    expectSameStatus(nextStatus, nextIndex)
    expect(container.children[1]).toBe(oldBubble)
    expect(oldBubble.querySelector('[data-testid="markdown"]')).toBe(oldMarkdown)
    expect(oldBubble.contains(oldToolButton!)).toBe(true)
  })

  it('isolates mounted reply instances across sessions with identical raw message IDs', async () => {
    const messages = [user('same-user')]
    await renderMessages(messages, 'requesting', { sessionId: 'first-session' })
    const original = statusAt()
    await renderMessages(messages, 'requesting', { sessionId: 'second-session' })
    expectFreshStatus(original, statusAt())
    expect(original.header.isConnected).toBe(false)
    expect(currentLabel(statusAt())).toBe(PHASE_POOLS.requesting[0])
  })

  it('passes the real assistant ID to MessageActions and confirms regeneration of historical replies', async () => {
    const onRegenerate = vi.fn()
    const question = user('u1')
    const answer = assistant([text('Completed answer')], 'real-sdk-message-id')
    const options = { onRegenerate }
    await renderMessages([question], 'requesting', options)
    await renderMessages([question, answer], 'idle', options)
    const more = [...container.querySelectorAll('button')].find(button => button.textContent === '⋯')!
    expect(more).toBeDefined()
    await act(async () => more.click())
    const regenerate = [...document.querySelectorAll('button')].find(button => button.textContent === '重新生成')!
    expect(regenerate).toBeDefined()
    await act(async () => regenerate.click())
    expect(onRegenerate).toHaveBeenCalledExactlyOnceWith(answer.id)
    expect(projectMessages([question, answer], 'session', 'idle')[1].key).not.toBe(answer.id)

    onRegenerate.mockClear()
    await renderMessages([question, answer, user('u2')], 'requesting', options)
    await act(async () => more.click())
    const historical = [...document.querySelectorAll('button')].find(button => button.textContent === '重新生成')!
    await act(async () => historical.click())
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(historical.textContent).toBe('确认清空后续消息？')
    await act(async () => historical.click())
    expect(onRegenerate).toHaveBeenCalledExactlyOnceWith(answer.id)
  })
})
