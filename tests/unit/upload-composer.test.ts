import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElementAttachment } from '../../src/shared/types'

// Reason: isolate composer handlers without installing a DOM test environment or starting an agent.
const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, attachments: [] as ElementAttachment[],
  send: vi.fn(), sessionId: 's1', status: 'ready',
}))

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: <T,>(initial: T | (() => T)) => {
    const i = harness.cursor++
    if (!(i in harness.slots)) harness.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial
    return [harness.slots[i], (value: T | ((prev: T) => T)) => {
      harness.slots[i] = typeof value === 'function' ? (value as (prev: T) => T)(harness.slots[i] as T) : value
    }]
  },
  useRef: <T,>(initial: T) => {
    const i = harness.cursor++
    if (!(i in harness.slots)) harness.slots[i] = { current: initial }
    return harness.slots[i]
  },
  useCallback: <T,>(callback: T) => callback,
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: () => {},
}))
vi.mock('../../src/sidepanel/hooks/useSidekickChat', () => ({
  COMPACT_MSG_ID: 'compact',
  useSidekickChat: () => ({
    messages: [], sessions: [], activeId: harness.sessionId, queue: [],
    status: harness.status, sendMessage: harness.send, config: { labImageFs: true },
    tokenUsage: { tokens: 0, exact: false }, relayedIds: new Set(), debugStatusRef: { current: null },
  }),
}))
vi.mock('../../src/sidepanel/hooks/useElementPicker', () => ({
  useElementPicker: () => ({ attachments: harness.attachments, setAttachments: (update: (prev: ElementAttachment[]) => ElementAttachment[]) => { harness.attachments = update(harness.attachments) } }),
}))
vi.mock('../../src/sidepanel/App', () => ({ getMyWindowId: vi.fn() }))
vi.mock('../../src/shared/skills', () => ({ skillRegistry: new Map(), getSkillContent: () => 'synthetic skill' }))
vi.mock('../../src/sidepanel/components/MessageList', () => ({ EmptyState: () => null, MessageBubble: () => null, ContextMeter: () => null, LinesIndicator: () => null }))
vi.mock('../../src/sidepanel/components/SessionBar', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/ProBackground', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/DebugToolbar', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/TodoStrip', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/QueueStrip', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/ModelSwitcher', () => ({ default: () => null }))
vi.mock('../../src/sidepanel/components/ShinyText', () => ({ default: () => null }))

import ChatView from '../../src/sidepanel/views/ChatView'
import ComposerActions from '../../src/sidepanel/components/ComposerActions'
import ChatComposer from '../../src/sidepanel/components/ChatComposer'

interface Node { type: unknown; props: Record<string, unknown> }
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const node = value as Node
  const children = node.type === ComposerActions
    ? ComposerActions(node.props as unknown as Parameters<typeof ComposerActions>[0])
    : node.type === ChatComposer
    ? ChatComposer(node.props as unknown as Parameters<typeof ChatComposer>[0])
    : node.props.children
  return [node, ...nodes(children)]
}
function render() {
  harness.cursor = 0
  const tree = nodes(ChatView({
    pageInfo: null, pageContent: null, activeTabId: null, extractContent: vi.fn(),
    extracting: false, proMode: false, contextLocked: false, onToggleContextLock: vi.fn(), onOpenSettings: vi.fn(),
  }))
  return {
    tree,
    textarea: tree.find(node => node.type === 'textarea')!,
    send: tree.find(node => node.type === 'button' && (node.props['aria-label'] === '发送消息' || node.props['aria-label'] === '加入队列'))!,
  }
}
function type(text: string) {
  const onChange = render().textarea.props.onChange as (event: unknown) => void
  onChange({ target: { value: text, style: {}, scrollHeight: 36 } })
}
async function clickSend() {
  const onClick = render().send.props.onClick as () => Promise<void>
  await onClick()
}

beforeEach(() => {
  harness.slots = []
  harness.cursor = 0
  harness.sessionId = 's1'
  harness.status = 'ready'
  harness.attachments = [{ label: 'doc.pdf', croppedImage: '', domSnapshot: '', file: { name: 'doc.pdf', mime: 'application/pdf', latin1: '%PDF synthetic' } }]
  harness.send.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('requestAnimationFrame', vi.fn())
})

describe('upload composer handlers (mocked React hooks)', () => {
  it('retains input and attachments and displays the specific upload failure', async () => {
    const original = harness.attachments[0]
    type('read this file')
    harness.send.mockRejectedValueOnce(new Error('doc.pdf 上传失败：VFS capacity exceeded'))
    await clickSend()
    const view = render()
    expect(view.textarea.props.value).toBe('read this file')
    expect(harness.attachments).toEqual([original])
    expect(view.tree.some(node => node.props.children === 'doc.pdf 上传失败：VFS capacity exceeded')).toBe(true)
    expect(view.send.props.disabled).toBe(false)
  })

  it('supports a file-only send and clears attachments only after acceptance', async () => {
    expect(render().send.props.disabled).toBe(false)
    await clickSend()
    expect(harness.send).toHaveBeenCalledWith('', expect.arrayContaining([expect.objectContaining({ file: expect.any(Object) })]), {})
    expect(harness.attachments).toEqual([])
  })

  it('prevents a second send while uploading and preserves edits made during the wait', async () => {
    type('original')
    let accept!: () => void
    harness.send.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve }))
    const click = render().send.props.onClick as () => Promise<void>
    const pending = click()
    await click()
    expect(harness.send).toHaveBeenCalledTimes(1)
    expect(render().tree.some(node => node.type === 'button' && node.props.disabled && String(node.props.title).includes('正在'))).toBe(true)
    type('new draft')
    const next = { croppedImage: '', domSnapshot: 'new', label: 'new attachment' }
    harness.attachments = [...harness.attachments, next]
    accept()
    await pending
    expect(render().textarea.props.value).toBe('new draft')
    expect(harness.attachments).toEqual([next])
  })

  it('allows the kernel to queue a send while streaming', async () => {
    harness.status = 'streaming'
    harness.attachments = []
    type('queued text')
    await clickSend()
    expect(harness.send).toHaveBeenCalledWith('queued text', undefined, {})
    expect(render().textarea.props.value).toBe('')
  })

  it('retains a slash-command draft and its file when upload fails', async () => {
    type('/debug inspect')
    harness.send.mockRejectedValueOnce(new Error('upload failed'))
    await clickSend()
    expect(harness.send).toHaveBeenCalledWith('inspect', expect.any(Array), { skill: { name: 'debug', content: 'synthetic skill' } })
    expect(render().textarea.props.value).toBe('/debug inspect')
    expect(harness.attachments).toHaveLength(1)
  })
})
