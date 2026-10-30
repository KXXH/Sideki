// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { ApiConfig, ChatSession } from '../../src/shared/types'
import { useSidekickChat } from '../../src/sidepanel/hooks/useSidekickChat'
import { loadConfig, loadSessionIndex, loadSession, loadSessions, saveSession, updateSessionMeta, deleteSession } from '../../src/shared/storage'
import { generateTitle } from '../../src/shared/ai-provider'

const callbacks = vi.hoisted(() => ({ finish: null as ((message: UIMessage) => unknown) | null }))
const mirrorState = vi.hoisted(() => ({ activeId: '', messages: [] as UIMessage[] }))
vi.mock('../../src/shared/storage', () => ({
  loadConfig: vi.fn(), loadSessionIndex: vi.fn(), loadSession: vi.fn(), loadSessions: vi.fn(),
  saveSession: vi.fn(), updateSessionMeta: vi.fn(), deleteSession: vi.fn(),
}))
vi.mock('../../src/shared/ai-provider', () => ({ generateTitle: vi.fn(), compactContext: vi.fn() }))
vi.mock('../../src/shared/agent', () => ({ createAgent: vi.fn(), buildOrogenLines: () => [], cratonRef: { current: null } }))
vi.mock('../../src/shared/tools/bridge', () => ({ setActiveSessionId: vi.fn(), peekOperatingTabId: vi.fn(), acquireTurnTab: vi.fn() }))
vi.mock('../../src/shared/kernel/chat-kernel', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/shared/kernel/chat-kernel')>()
  return {
    ...actual,
    KernelChat: class extends actual.KernelChat<UIMessage> {
      constructor(options: ConstructorParameters<typeof actual.KernelChat<UIMessage>>[0]) {
        super(options)
        // Reason: exercise the hook's real finish handler without sending an LLM request.
        callbacks.finish = message => options.onFinish?.({ message, messages: [message], isAbort: false, isDisconnect: false, isError: false })
      }
    },
  }
})
vi.mock('../../src/sidepanel/hooks/useKernelMirror', () => ({
  useKernelMirror: () => ({
    mirror: mirrorState.activeId ? { messages: mirrorState.messages, status: 'ready', queue: [] } : null,
    connected: false,
    extras: { activeId: mirrorState.activeId, sessions: [], lastTurnTokens: { input: 0, output: 0, reasoning: 0 } },
    cmd: vi.fn(), request: vi.fn(), captureSendTarget: vi.fn(), whenReady: vi.fn(),
  }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function session(id: string, updatedAt: number, mode: 'chat' | 'pro' = 'chat'): ChatSession {
  return {
    id, title: id, createdAt: 1, updatedAt, mode, messageCount: 1,
    messages: [{ id: `${id}-message`, role: 'user', parts: [{ type: 'text', text: `${id} body` }] }],
  }
}

const indexOf = (entries: ChatSession[]) => entries.map(s => ({ ...s, messages: [], messageCount: s.messages.length }))
const extractContent = vi.fn()
const pageInfo = { title: 'Page', url: 'https://example.com' }
let current: ReturnType<typeof useSidekickChat>
let renders: Array<{ id: string; messages: UIMessage[] }>
let root: Root
let container: HTMLDivElement
let mounted: boolean
let props: { tab: number; pro: boolean; host: 'panel' | 'offscreen' }
let stored: Map<string, ChatSession>
const originalRemove = Object.getOwnPropertyDescriptor(chrome.storage.local, 'remove')

function Harness() {
  const chat = useSidekickChat(pageInfo, null, props.tab, extractContent, props.pro, false, props.host)
  React.useLayoutEffect(() => {
    current = chat
    renders.push({ id: chat.activeId, messages: chat.messages })
  })
  return null
}

async function render(next: Partial<typeof props> = {}) {
  props = { ...props, ...next }
  await act(async () => { root.render(React.createElement(Harness)) })
}

async function tick(ms = 350) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function seed(entries: ChatSession[]) {
  stored = new Map(entries.map(s => [s.id, structuredClone(s)]))
  vi.mocked(loadSessionIndex).mockImplementation(async () => indexOf([...stored.values()]))
  vi.mocked(loadSession).mockImplementation(async id => structuredClone(stored.get(id) ?? null))
}

async function unmount() {
  await act(async () => { root.unmount() })
  mounted = false
}

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(chrome.storage.local, 'remove', { configurable: true, value: vi.fn().mockResolvedValue(undefined) })
})
afterAll(() => {
  if (originalRemove) Object.defineProperty(chrome.storage.local, 'remove', originalRemove)
  else Reflect.deleteProperty(chrome.storage.local, 'remove')
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(10_000)
  vi.clearAllMocks()
  mirrorState.activeId = ''
  mirrorState.messages = []
  vi.mocked(loadConfig).mockResolvedValue({ labAutoCompress: false, contextWindow: 100_000 } as ApiConfig)
  seed([session('a', 300), session('b', 200), session('c', 100)])
  vi.mocked(saveSession).mockImplementation(async s => { stored.set(s.id, structuredClone(s)) })
  vi.mocked(updateSessionMeta).mockImplementation(async (id, patch) => {
    const found = stored.get(id)
    if (found) stored.set(id, { ...found, ...patch })
  })
  vi.mocked(deleteSession).mockImplementation(async id => { stored.delete(id) })
  vi.mocked(generateTitle).mockResolvedValue('Generated title')
  props = { tab: 1, pro: false, host: 'panel' }
  renders = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mounted = true
})
afterEach(async () => {
  if (mounted) await unmount()
  container.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('panel session index and lazy body loading', () => {
  it('loads only the index and selected body, keeping other entries lightweight', async () => {
    const body = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(body.promise)
    await render()
    expect(loadSessionIndex).toHaveBeenCalledTimes(1)
    expect(loadSessions).not.toHaveBeenCalled()
    expect(loadSession).toHaveBeenCalledExactlyOnceWith('a')
    expect(current.activeId).toBe('')
    expect(current.messages).toEqual([])
    expect(current.sessions.map(s => s.messages)).toEqual([[], [], []])
    expect(current.sessions.map(s => s.messageCount)).toEqual([1, 1, 1])
    await act(async () => body.resolve(stored.get('a')!))
    expect(current.activeId).toBe('a')
    expect(current.messages[0].id).toBe('a-message')
    expect(current.sessions.find(s => s.id === 'b')?.messages).toEqual([])
    await tick()
    expect(stored.get('a')?.updatedAt).toBe(300)
    expect(stored.get('a')?.messageCount).toBe(1)
  })

  it('keeps the outgoing identity during reads and saves edits made while waiting under that identity', async () => {
    await render()
    const body = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(body.promise)
    let switching: Promise<void> | void
    await act(async () => { switching = current.handleSelectSession('b') })
    expect(current.activeId).toBe('a')
    expect(current.messages[0].id).toBe('a-message')
    await act(async () => { current.injectMessage('user', 'edit while loading') })
    await tick()
    expect(stored.get('a')?.messageCount).toBe(2)
    expect(stored.get('a')?.updatedAt).toBeGreaterThan(300)
    expect(stored.get('b')?.messages).toHaveLength(1)
    await act(async () => { body.resolve(stored.get('b')!); await switching })
    expect(current.activeId).toBe('b')
    expect(current.messages[0].id).toBe('b-message')
    expect(renders.filter(r => r.id === 'b').every(r => r.messages[0]?.id === 'b-message')).toBe(true)
    await tick()
    expect(stored.get('b')?.updatedAt).toBe(200)
    expect(stored.get('b')?.messageCount).toBe(1)
  })

  it('preserves an immediate dirty edit across select/back without re-reading the loaded body', async () => {
    await render()
    await act(async () => {
      current.injectMessage('user', 'not yet debounced')
      await current.handleSelectSession('b')
      await current.handleSelectSession('a')
    })
    expect(current.activeId).toBe('a')
    expect(current.messages).toHaveLength(2)
    expect(stored.get('a')?.messageCount).toBe(2)
    expect(loadSession).toHaveBeenCalledTimes(2)
  })

  it('does not let an older body read replace a later selection', async () => {
    await render()
    const b = deferred<ChatSession | null>()
    const c = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise)
    await act(async () => { void current.handleSelectSession('b'); void current.handleSelectSession('c') })
    await act(async () => c.resolve(stored.get('c')!))
    await act(async () => b.resolve(stored.get('b')!))
    expect(current.activeId).toBe('c')
    expect(current.messages[0].id).toBe('c-message')
  })

  it('cancels a pending switch when the user selects the still-active session', async () => {
    await render()
    const b = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(b.promise)
    await act(async () => { void current.handleSelectSession('b'); void current.handleSelectSession('a') })
    await act(async () => b.resolve(stored.get('b')!))
    expect(current.activeId).toBe('a')
  })

  it.each(['index', 'body'] as const)('does not overwrite a new session with a slow initial %s read', async stage => {
    const pendingIndex = deferred<ChatSession[]>()
    const pendingBody = deferred<ChatSession | null>()
    if (stage === 'index') vi.mocked(loadSessionIndex).mockReturnValueOnce(pendingIndex.promise)
    else vi.mocked(loadSession).mockReturnValueOnce(pendingBody.promise)
    await render()
    await act(async () => current.handleNewSession())
    const id = current.activeId
    await act(async () => {
      pendingIndex.resolve(indexOf([session('a', 300)]))
      pendingBody.resolve(session('a', 300))
    })
    expect(current.activeId).toBe(id)
    expect(current.messages).toEqual([])
    expect(stored.get(id)?.messageCount).toBe(0)
  })

  it('flushes dirty messages before new-session and cancels an older selection read', async () => {
    await render()
    const b = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(b.promise)
    await act(async () => { void current.handleSelectSession('b') })
    await act(async () => { current.injectMessage('user', 'keep me'); current.handleNewSession() })
    const id = current.activeId
    expect(stored.get('a')?.messages).toHaveLength(2)
    await act(async () => b.resolve(stored.get('b')!))
    expect(current.activeId).toBe(id)
    expect(current.messages).toEqual([])
  })

  it.each(['index', 'body'] as const)('invalidates a slow %s read on mode changes', async stage => {
    seed([session('a', 300), session('pro', 400, 'pro')])
    const pendingIndex = deferred<ChatSession[]>()
    const pendingBody = deferred<ChatSession | null>()
    if (stage === 'index') vi.mocked(loadSessionIndex).mockReturnValueOnce(pendingIndex.promise)
    else vi.mocked(loadSession).mockReturnValueOnce(pendingBody.promise)
    await render()
    await render({ pro: true })
    expect(current.activeId).toBe('pro')
    await act(async () => {
      pendingIndex.resolve(indexOf([session('a', 300)]))
      pendingBody.resolve(session('a', 300))
    })
    expect(current.activeId).toBe('pro')
    expect(current.messages[0].id).toBe('pro-message')
    expect(current.sessions.map(s => s.id)).toEqual(['pro'])
  })

  it.each(['index', 'body'] as const)('does not activate or save after unmount during a %s read', async stage => {
    const pendingIndex = deferred<ChatSession[]>()
    const pendingBody = deferred<ChatSession | null>()
    if (stage === 'index') vi.mocked(loadSessionIndex).mockReturnValueOnce(pendingIndex.promise)
    else vi.mocked(loadSession).mockReturnValueOnce(pendingBody.promise)
    await render()
    await unmount()
    vi.mocked(saveSession).mockClear()
    const count = renders.length
    await act(async () => {
      pendingIndex.resolve([])
      pendingBody.resolve(session('a', 300))
    })
    expect(renders).toHaveLength(count)
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('flushes the outgoing dirty body on unmount and ignores a pending selection afterward', async () => {
    await render()
    const b = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(b.promise)
    await act(async () => {
      current.injectMessage('user', 'save on close')
      void current.handleSelectSession('b')
    })
    await unmount()
    expect(stored.get('a')?.messageCount).toBe(2)
    vi.mocked(saveSession).mockClear()
    await act(async () => b.resolve(stored.get('b')!))
    expect(saveSession).not.toHaveBeenCalled()
    expect(stored.get('b')?.messages).toHaveLength(1)
  })

  it('keeps the current session intact when loading a selected body fails or returns null', async () => {
    await render()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(loadSession).mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce(null)
    await act(async () => { await current.handleSelectSession('b'); await current.handleSelectSession('c') })
    expect(current.activeId).toBe('a')
    expect(current.messages[0].id).toBe('a-message')
    expect(log).toHaveBeenCalledWith('[useSidekickChat] loadSession failed:', expect.any(Error))
  })

  it('uses remembered tab sessions through the same lazy loader after a mode reload clears the cache', async () => {
    seed([session('a', 300), session('b', 200), session('pro', 400, 'pro')])
    await render()
    await render({ tab: 2 })
    await act(async () => { await current.handleSelectSession('b') })
    await render({ tab: 1 })
    expect(current.activeId).toBe('a')
    await render({ pro: true })
    await render({ pro: false })
    vi.mocked(loadSession).mockClear()
    const b = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(b.promise)
    await render({ tab: 2 })
    expect(loadSession).toHaveBeenCalledExactlyOnceWith('b')
    expect(current.activeId).toBe('a')
    await act(async () => b.resolve(stored.get('b')!))
    expect(current.activeId).toBe('b')
    expect(current.messages[0].id).toBe('b-message')
  })

  it('cancels a slow tab switch on another tab change without losing that tab\'s remembered session', async () => {
    seed([session('a', 300), session('b', 200), session('pro', 400, 'pro')])
    await render()
    await render({ tab: 2 })
    await act(async () => { await current.handleSelectSession('b') })
    await render({ tab: 1 })
    await render({ pro: true })
    await render({ pro: false })
    const b = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(b.promise)
    await render({ tab: 2 })
    await render({ tab: 3 })
    await act(async () => b.resolve(stored.get('b')!))
    expect(current.activeId).toBe('a')
    await render({ tab: 2 })
    expect(current.activeId).toBe('b')
  })

  it('loads the next body after deleting the active session without recreating the deleted session', async () => {
    await render()
    const next = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(next.promise)
    let deletion: Promise<void>
    await act(async () => { deletion = current.handleDeleteSession('a') })
    expect(loadSession).toHaveBeenLastCalledWith('b')
    expect(current.activeId).toBe('a')
    await tick()
    expect(stored.has('a')).toBe(false)
    await act(async () => { next.resolve(stored.get('b')!); await deletion })
    expect(current.activeId).toBe('b')
    expect(current.messages[0].id).toBe('b-message')
    expect(chrome.storage.local.remove).toHaveBeenCalledWith('history:a')
  })

  it('suppresses saves while deletion is pending and respects a newer new-session action', async () => {
    await render()
    const deletion = deferred<void>()
    vi.mocked(deleteSession).mockImplementationOnce(async id => { await deletion.promise; stored.delete(id) })
    await act(async () => { void current.handleDeleteSession('a') })
    vi.mocked(saveSession).mockClear()
    await tick()
    expect(saveSession).not.toHaveBeenCalled()
    await act(async () => current.handleNewSession())
    const id = current.activeId
    await act(async () => deletion.resolve())
    expect(current.activeId).toBe(id)
    expect(current.sessions.some(s => s.id === 'a')).toBe(false)
    expect(stored.has('a')).toBe(false)
  })

  it('cancels deletion fallback loading on a later manual switch', async () => {
    await render()
    const b = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(b.promise)
    await act(async () => { void current.handleDeleteSession('a') })
    await act(async () => { await current.handleSelectSession('c') })
    await act(async () => b.resolve(stored.get('b')!))
    expect(current.activeId).toBe('c')
  })

  it('creates an empty session after deleting the last one', async () => {
    seed([session('a', 300)])
    await render()
    await act(async () => { await current.handleDeleteSession('a') })
    expect(current.activeId).not.toBe('a')
    expect(current.sessions).toHaveLength(1)
    expect(current.messages).toEqual([])
    expect(current.sessions[0].messageCount).toBe(0)
  })

  it('renames an unloaded entry without writing its empty metadata body', async () => {
    await render()
    vi.mocked(saveSession).mockClear()
    await act(async () => current.handleRenameSession('b', 'Renamed'))
    expect(updateSessionMeta).toHaveBeenCalledExactlyOnceWith('b', { title: 'Renamed', updatedAt: 10_000 })
    expect(saveSession).not.toHaveBeenCalled()
    expect(stored.get('b')?.messages).toHaveLength(1)
    expect(current.sessions.find(s => s.id === 'b')?.messages).toEqual([])
  })

  it('preserves a rename made while that session body is loading', async () => {
    await render()
    const stale = structuredClone(stored.get('b')!)
    const body = deferred<ChatSession | null>()
    vi.mocked(loadSession).mockReturnValueOnce(body.promise)
    await act(async () => { void current.handleSelectSession('b'); current.handleRenameSession('b', 'During read') })
    await act(async () => body.resolve(stale))
    await tick()
    expect(stored.get('b')?.title).toBe('During read')
    expect(stored.get('b')?.messages).toHaveLength(1)
  })

  it.each([false, true])('auto-title uses only a metadata patch (fallback=%s)', async fallback => {
    seed([{ ...session('a', 300), title: 'New Chat' }])
    if (fallback) {
      vi.mocked(generateTitle).mockRejectedValueOnce(new Error('title failed'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
    }
    await render()
    vi.mocked(saveSession).mockClear()
    await act(async () => { await callbacks.finish?.({ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] }) })
    expect(updateSessionMeta).toHaveBeenCalledExactlyOnceWith('a', { title: fallback ? 'a body' : 'Generated title', updatedAt: 10_000 })
    expect(saveSession).not.toHaveBeenCalled()
    expect(stored.get('a')?.messages).toHaveLength(1)
  })

  it('flushes the panel body under its own identity when switching back to a different mirrored session', async () => {
    const original = structuredClone(stored.get('a')!)
    mirrorState.activeId = 'a'
    mirrorState.messages = original.messages as UIMessage[]
    await render({ host: 'offscreen' })
    await render({ host: 'panel' })
    await act(async () => { await current.handleSelectSession('b') })
    await act(async () => { current.injectMessage('user', 'panel-only edit') })
    vi.mocked(saveSession).mockClear()
    await render({ host: 'offscreen' })
    expect(current.activeId).toBe('a')
    expect(stored.get('a')).toEqual(original)
    expect(stored.get('b')?.messages).toHaveLength(2)
    expect(vi.mocked(saveSession).mock.calls.every(([s]) => s.id === 'b')).toBe(true)
    await unmount()
    expect(stored.get('a')).toEqual(original)
  })

  it('still selects the next session when a pending deletion target is selected again', async () => {
    await render()
    const deletion = deferred<void>()
    vi.mocked(deleteSession).mockImplementationOnce(async id => { await deletion.promise; stored.delete(id) })
    let removing: Promise<void>
    await act(async () => { removing = current.handleDeleteSession('a') })
    await act(async () => { await current.handleSelectSession('a') })
    await act(async () => { deletion.resolve(); await removing })
    expect(stored.has('a')).toBe(false)
    expect(current.activeId).toBe('b')
    expect(current.messages[0].id).toBe('b-message')
  })

  it('does not use panel storage in mirror mode', async () => {
    await render({ host: 'offscreen' })
    expect(loadSessionIndex).not.toHaveBeenCalled()
    expect(loadSession).not.toHaveBeenCalled()
    expect(saveSession).not.toHaveBeenCalled()
  })
})
