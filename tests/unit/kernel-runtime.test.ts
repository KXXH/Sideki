import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('../../src/shared/agent', () => ({
  createAgent: vi.fn().mockResolvedValue({}),
}))
vi.mock('../../src/shared/ai-provider', () => ({
  generateTitle: vi.fn().mockResolvedValue('Generated Title'),
  compactContext: vi.fn().mockResolvedValue('SUMMARY'),
}))

import { SessionRuntime, type KernelEnv, type RuntimeHooks } from '../../src/shared/kernel/kernel-runtime'
import { createAgent } from '../../src/shared/agent'
import type { ApiConfig, ChatSession, ElementAttachment, PageContent } from '../../src/shared/types'

const cfg = { model: 'test', contextWindow: 100000, mcpServers: [] } as unknown as ApiConfig

function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id, title: `S-${id}`, createdAt: 1, updatedAt: 1, mode: 'chat',
    messages: [{ id: `m-${id}`, role: 'user', parts: [{ type: 'text', text: `hello ${id}` }] }],
    ...over,
  } as ChatSession
}

function makeEnv(): KernelEnv {
  return {
    loadConfig: vi.fn().mockResolvedValue(cfg),
    onConfigChanged: vi.fn().mockReturnValue(() => {}),
    loadSessions: vi.fn().mockResolvedValue([]),
    loadSession: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    updateSessionMeta: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    removeHistory: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(async (msg: { type?: string }) => msg.type === 'canvas:request' ? { success: true, result: [] } : undefined),
  }
}

describe('canvas context persistence', () => {
  it('saves the immutable user snapshot before handing the request to the transport', async () => {
    const env = makeEnv()
    const snapshots = [{ canvasId: 'a', path: '/viz/a.html', title: 'A', modelRevision: 7, modelContent: { budget: 5000 } }]
    ;(env.sendMessage as Mock).mockImplementation(async (msg: { type?: string; op?: string }) => msg.type === 'canvas:request' ? { success: true, result: msg.op === 'capture' ? snapshots : undefined } : undefined)
    const rt = new SessionRuntime({ session: session('s', { messages: [] }), env, hooks: makeHooks(), getConfig: () => cfg })
    const send = vi.spyOn(rt.chat, 'sendMessage').mockImplementation(async () => {
      expect(env.saveSession).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ parts: expect.arrayContaining([{ type: 'data-canvas-context', data: snapshots }]) }),
      ]) }))
    })
    await rt.kernel.handleSend('重新计算')
    expect(send).toHaveBeenCalledOnce()
    expect(rt.kstate.messages[0].parts).toContainEqual({ type: 'data-canvas-context', data: snapshots })
    rt.dispose()
  })
})

function makeHooks(over: Partial<RuntimeHooks> = {}): RuntimeHooks {
  return {
    getPageInfo: () => ({ title: 'Page', url: 'https://example.com/x' }),
    extractContent: vi.fn().mockResolvedValue({ title: 'Page', url: 'https://example.com/x', content: 'body', images: [] } as unknown as PageContent),
    getCurrentTabId: () => 1,
    ...over,
  }
}

function makeRuntime(s: ChatSession, over: { onSessionUpdated?: (s: ChatSession) => void } = {}) {
  const env = makeEnv()
  const rt = new SessionRuntime({
    session: s,
    env,
    hooks: makeHooks(),
    getConfig: () => cfg,
    ...over,
  })
  return { rt, env }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionRuntime construction', () => {
  it('persists per-session permission changes including empty conversations', async () => {
    const onSessionUpdated = vi.fn()
    const { rt, env } = makeRuntime(session('permissions', { messages: [] }), { onSessionUpdated })
    await rt.setPermissionMode('auto')
    expect(rt.session.permissionMode).toBe('auto')
    expect(env.saveSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'auto', messages: [] }))
    expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'auto' }))
    rt.dispose()
  })

  it('rolls back a permission change when persistence fails', async () => {
    const { rt, env } = makeRuntime(session('permissions', { permissionMode: 'ask' }))
    vi.mocked(env.saveSession).mockRejectedValueOnce(new Error('storage failed'))
    await expect(rt.setPermissionMode('allow')).rejects.toThrow('storage failed')
    expect(rt.session.permissionMode).toBe('ask')
    rt.dispose()
  })

  it('loads the session messages into kernel state', () => {
    const { rt } = makeRuntime(session('a'))
    expect(rt.sessionId).toBe('a')
    expect(rt.kstate.messages.map(m => m.id)).toEqual(['m-a'])
    expect(rt.kernel.sessionId).toBe('a')
  })

  it('loading an interrupted session marks the trailing assistant message', () => {
    const s = session('x', {
      interrupted: true,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
      ],
    })
    const { rt } = makeRuntime(s)
    const last = rt.kstate.messages.at(-1) as { metadata?: { interrupted?: boolean } }
    expect(last.metadata?.interrupted).toBe(true)
    // Reason: fresh kernel starts ready — same semantics as a panel close
    expect(rt.kstate.status).toBe('ready')
  })
})

describe('SessionRuntime persistence', () => {
  it('flushSave writes current messages and reports upward', () => {
    const updates: ChatSession[] = []
    const { rt, env } = makeRuntime(session('a'), { onSessionUpdated: (s) => updates.push(s) })
    rt.injectMessage('assistant', 'answer')
    rt.flushSave()
    const saved = (env.saveSession as Mock).mock.calls.at(-1)![0] as ChatSession
    expect(saved.id).toBe('a')
    expect(saved.messages).toHaveLength(2)
    expect(saved.interrupted).toBe(false)
    expect(updates.at(-1)!.messages).toHaveLength(2)
  })

  it('mid-turn checkpoint marks the session interrupted; ready save clears it', () => {
    const { rt, env } = makeRuntime(session('a'))
    rt.kstate.status = 'streaming'
    rt.flushSave()
    let saved = (env.saveSession as Mock).mock.calls.at(-1)![0] as ChatSession
    expect(saved.interrupted).toBe(true)
    rt.kstate.status = 'ready'
    rt.flushSave()
    saved = (env.saveSession as Mock).mock.calls.at(-1)![0] as ChatSession
    expect(saved.interrupted).toBe(false)
  })

  it('advances updatedAt for a same-length message change and only then', () => {
    const { rt } = makeRuntime(session('a', { updatedAt: 1 }))
    const now = vi.spyOn(Date, 'now').mockReturnValue(50)
    rt.kstate.messages = rt.kstate.messages.map(m => ({ ...m, parts: [{ type: 'text', text: 'edited' }] }))
    rt.flushSave()
    expect(rt.session.updatedAt).toBe(50)
    now.mockReturnValue(99)
    rt.flushSave()
    expect(rt.session.updatedAt).toBe(50)
    now.mockRestore()
  })

  it('flushSave is a no-op with no messages', () => {
    const { rt, env } = makeRuntime(session('a', { messages: [] }))
    rt.flushSave()
    expect((env.saveSession as Mock).mock.calls.length).toBe(0)
  })

  it('dispose stops late checkpoints and saves from resurrecting a deleted session', async () => {
    const { rt, env } = makeRuntime(session('a'))
    rt.injectMessage('assistant', 'partial')
    rt.dispose()
    ;(env.saveSession as Mock).mockClear()
    rt.flushSave()
    rt.scheduleSave()
    expect(env.saveSession).not.toHaveBeenCalled()
    expect(env.sendMessage).toHaveBeenCalledWith({ type: 'tab-lock:release', sessionId: 'a' })
  })

  it('applySessionMeta keeps pool-side renames from being overwritten by saves', () => {
    const { rt, env } = makeRuntime(session('a'))
    rt.applySessionMeta({ ...session('a'), title: 'Renamed' })
    rt.injectMessage('assistant', 'x')
    rt.flushSave()
    const saved = (env.saveSession as Mock).mock.calls.at(-1)![0] as ChatSession
    expect(saved.title).toBe('Renamed')
  })
})

describe('SessionRuntime page context locking', () => {
  it('accepts page context before first message, locks after', () => {
    const { rt } = makeRuntime(session('a', { messages: [] }))
    const page = { title: 'P', url: 'u', content: 'c', images: [] } as unknown as PageContent
    rt.offerPageContext(page)
    expect(rt.pageContextRef.current).toBe(page)
    rt.injectMessage('user', 'first')
    const page2 = { title: 'P2', url: 'u2', content: 'c2', images: [] } as unknown as PageContent
    rt.offerPageContext(page2)
    expect(rt.pageContextRef.current).toBe(page)
  })
})

describe('SessionRuntime send resilience', () => {
  // Reason: regression — extraction failure (chrome:// pages) used to skip
  // the agent build in the same try block, then silently drop the send.
  it('extraction failure still builds the agent and delivers the send', async () => {
    const env = makeEnv()
    const rt = new SessionRuntime({
      session: session('a'),
      env,
      hooks: makeHooks({ extractContent: vi.fn().mockRejectedValue(new Error('Cannot access chrome:// URL')) }),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('hello')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(rt.kstate.error).toBeUndefined()
  })

  it('non-injectable pages (chrome://) skip extraction entirely', async () => {
    const env = makeEnv()
    const extract = vi.fn()
    const rt = new SessionRuntime({
      session: session('a'),
      env,
      hooks: makeHooks({
        getPageInfo: () => ({ title: '扩展程序', url: 'chrome://extensions/' }),
        extractContent: extract,
      }),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('hello')
    expect(extract).not.toHaveBeenCalled()
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  it('missing config surfaces an error instead of dropping silently', async () => {
    const env = makeEnv()
    const rt = new SessionRuntime({
      session: session('a'),
      env,
      hooks: makeHooks(),
      getConfig: () => null,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('hello')
    expect(sendSpy).not.toHaveBeenCalled()
    expect(rt.kstate.error?.message).toContain('未就绪')
  })

})

// Reason: regression — the bubble used to be created by chat.sendMessage, which
// only runs after page extraction and the agent rebuild; a slow first send
// therefore showed the user's own message nowhere until it was already answered.
describe('SessionRuntime optimistic send', () => {
  function gatedRuntime(attachments?: ElementAttachment[]) {
    let release: (p: PageContent) => void = () => {}
    const gate = new Promise<PageContent>(resolve => { release = resolve })
    const rt = new SessionRuntime({
      session: session('a', { messages: [] }),
      env: makeEnv(),
      hooks: makeHooks({ extractContent: vi.fn().mockReturnValue(gate) }),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    return { rt, sendSpy, sending: rt.kernel.handleSend('hello', attachments), release: () => release({ title: 'P', url: 'https://x.test/', content: 'body', images: [] } as unknown as PageContent) }
  }

  it('shows the bubble while prepare is still running, then commits in place', async () => {
    const { rt, sendSpy, sending, release } = gatedRuntime()
    await new Promise(r => setTimeout(r, 0))

    expect(sendSpy).not.toHaveBeenCalled()
    expect(rt.kstate.messages).toHaveLength(1)
    expect(rt.kstate.messages[0].role).toBe('user')

    release()
    await sending
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(rt.kstate.messages).toHaveLength(1)
    const sent = sendSpy.mock.calls[0][0] as { messageId?: string }
    expect(sent.messageId).toBe(rt.kstate.messages[0].id)
  })

  it('stops preparation without dispatching a late result, and allows retry', async () => {
    const { rt, sendSpy, sending, release } = gatedRuntime()
    await new Promise(r => setTimeout(r, 0))
    expect(rt.kernel.preparing).toBe(true)
    await rt.stop()
    await sending
    expect(rt.kernel.preparing).toBe(false)
    expect(rt.kernel.dispatching).toBe(false)
    expect(rt.kstate.error).toBeUndefined()
    release()
    await new Promise(r => setTimeout(r, 0))
    expect(sendSpy).not.toHaveBeenCalled()
    expect(createAgent).not.toHaveBeenCalled()
    await rt.kernel.handleSend('retry')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    rt.dispose()
  })

  it('times out hung initialization and ignores late page content', async () => {
    vi.useFakeTimers()
    try {
      const { rt, sendSpy, sending, release } = gatedRuntime()
      await vi.advanceTimersByTimeAsync(0)
      expect(rt.kernel.preparing).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      await sending
      expect(rt.kernel.preparing).toBe(false)
      expect(rt.kernel.dispatching).toBe(false)
      expect(rt.kstate.error?.message).toContain('超时')
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(sendSpy).not.toHaveBeenCalled()
      expect(createAgent).not.toHaveBeenCalled()
      rt.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['stop', 'timeout'])('releases the preparation lock on %s without late cleanup touching a retry', async reason => {
    vi.useFakeTimers()
    let rt: SessionRuntime | undefined
    try {
      let releaseOld!: (p: PageContent) => void
      const oldContent = new Promise<PageContent>(resolve => { releaseOld = resolve })
      const env = makeEnv()
      const extractContent = vi.fn().mockReturnValueOnce(oldContent).mockReturnValue(new Promise(() => {}))
      rt = new SessionRuntime({ session: session('a', { messages: [] }), env, hooks: makeHooks({ extractContent }), getConfig: () => cfg })
      const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
      const releases = () => (env.sendMessage as Mock).mock.calls.filter(([m]) => m.type === 'tab-lock:release')
      const sending = rt.kernel.handleSend('first')
      await vi.advanceTimersByTimeAsync(0)
      expect(rt.kernel.preparing).toBe(true)
      if (reason === 'stop') await rt.stop()
      else await vi.advanceTimersByTimeAsync(30_000)
      await sending
      expect(releases()).toHaveLength(1)

      const retrying = rt.kernel.handleSend('retry')
      await vi.advanceTimersByTimeAsync(0)
      expect(rt.kernel.preparing).toBe(true)
      releaseOld({ title: 'Late', url: 'https://late.test', content: 'late', images: [] } as unknown as PageContent)
      await vi.advanceTimersByTimeAsync(0)
      expect(releases()).toHaveLength(1)
      expect(rt.kernel.preparing).toBe(true)
      expect(sendSpy).not.toHaveBeenCalled()
      await rt.stop()
      await retrying
      expect(releases()).toHaveLength(2)
    } finally {
      rt?.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['stop', 'timeout'])('retains the tab stack for a queued continuation after preparation %s', async reason => {
    vi.useFakeTimers()
    let rt: SessionRuntime | undefined
    try {
      const env = makeEnv()
      rt = new SessionRuntime({ session: session('a', { messages: [] }), env, hooks: makeHooks({ extractContent: () => new Promise(() => {}) }), getConfig: () => cfg })
      const releases = () => (env.sendMessage as Mock).mock.calls.filter(([m]) => m.type === 'tab-lock:release')
      const sending = rt.kernel.handleSend('first')
      await vi.advanceTimersByTimeAsync(0)
      await rt.kernel.handleSend('queued')
      if (reason === 'stop') await rt.stop()
      else await vi.advanceTimersByTimeAsync(30_000)
      await sending
      await vi.advanceTimersByTimeAsync(0)
      expect(rt.kernel.queue).toHaveLength(0)
      expect(rt.kernel.preparing).toBe(true)
      expect(releases()).toHaveLength(0)
      await rt.stop()
      await vi.advanceTimersByTimeAsync(0)
      expect(releases()).toHaveLength(1)
    } finally {
      rt?.dispose()
      vi.useRealTimers()
    }
  })

  it('awaits preparation cleanup before a new turn can acquire its tab', async () => {
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
    const env = makeEnv()
    ;(env.sendMessage as Mock).mockImplementation((m: { type: string }) => m.type === 'tab-lock:release' ? cleanup : Promise.resolve(m.type === 'canvas:request' ? { success: true, result: [] } : undefined))
    const extractContent = vi.fn().mockReturnValue(new Promise(() => {}))
    const rt = new SessionRuntime({ session: session('a', { messages: [] }), env, hooks: makeHooks({ extractContent }), getConfig: () => cfg })
    try {
      const sending = rt.kernel.handleSend('first')
      await new Promise(r => setTimeout(r, 0))
      await rt.stop()
      await new Promise(r => setTimeout(r, 0))
      expect(rt.kernel.dispatching).toBe(true)
      await rt.kernel.handleSend('queued during cleanup')
      expect(extractContent).toHaveBeenCalledTimes(1)
      releaseCleanup()
      await sending
      await new Promise(r => setTimeout(r, 0))
      expect(extractContent).toHaveBeenCalledTimes(2)
      expect(rt.kernel.preparing).toBe(true)
      await rt.stop()
      await new Promise(r => setTimeout(r, 0))
    } finally {
      releaseCleanup()
      rt.dispose()
    }
  })

  it.each(['mcp', 'agent'])('ignores late %s initialization after stop', async stage => {
    let release: (value: unknown) => void = () => {}
    const gate = new Promise(resolve => { release = resolve })
    const { rt, env } = makeRuntime(session('a', { messages: [] }))
    if (stage === 'mcp') {
      ;(env.sendMessage as Mock).mockImplementation((msg: { type: string }) => msg.type === 'mcp:ensure' ? gate : Promise.resolve(msg.type === 'canvas:request' ? { success: true, result: [] } : undefined))
    } else {
      ;(createAgent as Mock).mockReturnValueOnce(gate)
    }
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    const sending = rt.kernel.handleSend('hello')
    await new Promise(r => setTimeout(r, 0))
    await rt.stop()
    await sending
    release(stage === 'mcp' ? { tools: [] } : {})
    await new Promise(r => setTimeout(r, 0))
    expect(sendSpy).not.toHaveBeenCalled()
    expect(rt.kernel.preparing).toBe(false)
    await rt.kernel.handleSend('retry')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    rt.dispose()
  })

  it('holds the dispatch flag for the whole handoff, releases it at the SDK', async () => {
    const { rt, sending, release } = gatedRuntime()
    await new Promise(r => setTimeout(r, 0))

    // Reason: status is still 'ready' through this window — the flag is the
    // only signal that says the turn is in flight while the craton is built.
    expect(rt.kernel.dispatching).toBe(true)

    release()
    await sending
    expect(rt.kernel.dispatching).toBe(false)
  })

  it('a file-only send carries a file part already on the bubble', async () => {
    const attachment = {
      croppedImage: '',
      domSnapshot: '',
      label: '',
      savedFile: { sessionId: 'a', path: '/tmp/notes.txt', name: 'notes.txt', size: 5, mime: 'text/plain' },
    } as ElementAttachment
    const { rt, sending, release } = gatedRuntime([attachment])
    await new Promise(r => setTimeout(r, 0))

    const parts = rt.kstate.messages[0].parts as Array<{ type: string; data?: { path?: string } }>
    expect(parts.some(p => p.type === 'data-file' && p.data?.path === '/tmp/notes.txt')).toBe(true)
    release()
    await sending
    expect(rt.kstate.messages).toHaveLength(1)
  })

  it('retracts the bubble when nothing survives the send', async () => {
    const rt = new SessionRuntime({
      session: session('a', { messages: [] }),
      env: makeEnv(),
      hooks: makeHooks(),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    // Reason: an attachment with no text, image, snapshot or saved file builds
    // zero parts — the send dies, and a bubble left behind would be a lie.
    const empty = { croppedImage: '', domSnapshot: '', label: 'x' } as ElementAttachment
    await rt.kernel.handleSend('', [empty])
    expect(sendSpy).not.toHaveBeenCalled()
    expect(rt.kstate.messages).toHaveLength(0)
    // Reason: a send that dies on its own must not leave the flag stuck — the
    // panel would show a turn that is not coming.
    expect(rt.kernel.dispatching).toBe(false)
  })
})

describe('SessionRuntime.regenerate', () => {
  it('keeps the last user turn through the lazy build and commits the resend into it', async () => {
    const { rt } = makeRuntime(session('a', { messages: [] }))
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    rt.injectMessage('user', 'q1')
    rt.injectMessage('assistant', 'a1')
    const userId = rt.kstate.messages[0].id
    const assistantId = rt.kstate.messages[1].id
    rt.regenerate(assistantId)
    // Reason: the reply slot needs the user turn as its anchor while the
    // craton is being built — removing it leaves an empty/finished-looking chat.
    expect(rt.kstate.messages.map(m => m.id)).toEqual([userId])
    await new Promise(r => setTimeout(r, 0))
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const arg = sendSpy.mock.calls[0][0] as { parts: Array<{ type: string; text?: string }>; messageId?: string }
    expect(arg.parts[0].text).toBe('q1')
    // Reason: commit into the same message id instead of appending a duplicate user turn.
    expect(arg.messageId).toBe(userId)
  })

  it('a send queued during regenerate waits for the resend handoff', async () => {
    let release: (p: PageContent) => void = () => {}
    const gate = new Promise<PageContent>(resolve => { release = resolve })
    const rt = new SessionRuntime({
      session: session('x', {
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
        ],
      }),
      env: makeEnv(),
      hooks: makeHooks({ extractContent: vi.fn().mockReturnValue(gate) }),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)

    rt.regenerate('a1')
    await new Promise(r => setTimeout(r, 0))
    expect(rt.kernel.dispatching).toBe(true)
    await rt.kernel.handleSend('B')

    release({ title: 'P', url: 'https://x.test/', content: 'body', images: [] } as unknown as PageContent)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    // Reason: the queued send must not be dispatched while the regenerate
    // build is still in flight — its handoff commits first, then the queue.
    const sent = sendSpy.mock.calls.map(c => (c[0] as { messageId?: string }).messageId)
    expect(sent[0]).toBe('u1')
    expect(sent).toHaveLength(2)
  })

  it('ignores non-assistant targets', () => {
    const { rt } = makeRuntime(session('a', { messages: [] }))
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    rt.injectMessage('user', 'q1')
    rt.regenerate(rt.kstate.messages[0].id)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(rt.kstate.messages).toHaveLength(1)
  })
})

// Reason: entering a session (new, switch, reopen) must not build anything —
// page extraction, the MCP tool list and the agent all belong to the first
// send, so a session the user only looks at costs nothing.
describe('SessionRuntime lazy craton', () => {
  it('a constructed runtime touches neither MCP nor the agent', () => {
    const { rt, env } = makeRuntime(session('a'))
    expect((createAgent as Mock).mock.calls.length).toBe(0)
    expect((env.sendMessage as Mock).mock.calls.some(c => (c[0] as { type?: string })?.type === 'mcp:ensure')).toBe(false)
    // Reason: a reloaded conversation with history is just as cold
    expect(rt.kstate.messages.length).toBeGreaterThan(0)
  })

  it('the first send builds once; a second send rides the same craton', async () => {
    const { rt } = makeRuntime(session('a', { messages: [] }))
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('one')
    expect((createAgent as Mock).mock.calls.length).toBe(1)
    await rt.kernel.handleSend('two')
    expect((createAgent as Mock).mock.calls.length).toBe(1)
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })

  it('retries the build after a transient MCP failure instead of freezing the tool table', async () => {
    const env = makeEnv()
    let mcpCalls = 0
    ;(env.sendMessage as Mock).mockImplementation(async (msg: { type?: string }) => {
      if (msg?.type === 'canvas:request') return { success: true, result: [] }
      if (msg?.type !== 'mcp:ensure') return undefined
      mcpCalls++
      if (mcpCalls === 1) throw new Error('mcp down')
      return { errors: {}, tools: [] }
    })
    const rt = new SessionRuntime({
      session: session('a', { messages: [] }),
      env,
      hooks: makeHooks(),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)

    await rt.kernel.handleSend('one')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect((createAgent as Mock).mock.calls.length).toBe(1)

    // Reason: the failed build must not claim the fingerprint — the next send retries MCP.
    await rt.kernel.handleSend('two')
    expect(mcpCalls).toBe(2)
    expect((createAgent as Mock).mock.calls.length).toBe(2)
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })

  it('regenerate on a session nobody sent in builds the craton first', async () => {
    const { rt } = makeRuntime(session('x', {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
      ],
    }))
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    expect((createAgent as Mock).mock.calls.length).toBe(0)

    rt.regenerate('a1')
    await new Promise(r => setTimeout(r, 0))

    expect((createAgent as Mock).mock.calls.length).toBe(1)
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })
})

// Reason: regression — offscreen runtimes kept serving the previous profile
// after a mid-session switch: the mirror painted the new model while requests
// went to the old endpoint until a session switch or panel re-init.
describe('SessionRuntime provider convergence', () => {
  function runtimeWithMutableConfig(hooks = makeHooks()) {
    const holder = { current: { ...cfg, model: 'a', endpoint: 'https://a.example.com/v1' } as ApiConfig }
    const rt = new SessionRuntime({
      session: session('a', { messages: [] }),
      env: makeEnv(),
      hooks,
      getConfig: () => holder.current,
    })
    return { rt, holder }
  }

  it('rebuilds the agent with the new profile before the next send', async () => {
    const { rt, holder } = runtimeWithMutableConfig()
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('one')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const built = (createAgent as Mock).mock.calls.length

    holder.current = { ...holder.current, model: 'b', endpoint: 'https://b.example.com/v1' } as ApiConfig
    await rt.kernel.handleSend('two')

    expect((createAgent as Mock).mock.calls.length).toBeGreaterThan(built)
    const lastCfg = (createAgent as Mock).mock.calls.at(-1)![0] as ApiConfig
    expect(lastCfg.model).toBe('b')
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })

  it('does not rebuild when the config is unchanged between sends', async () => {
    const { rt } = runtimeWithMutableConfig()
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('one')
    const built = (createAgent as Mock).mock.calls.length
    await rt.kernel.handleSend('two')
    expect((createAgent as Mock).mock.calls.length).toBe(built)
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })

  it('rebuilds on profile switch even for content-less sessions', async () => {
    const { rt, holder } = runtimeWithMutableConfig(makeHooks({
      getPageInfo: () => ({ title: '扩展程序', url: 'chrome://extensions/' }),
    }))
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('one')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const built = (createAgent as Mock).mock.calls.length

    holder.current = { ...holder.current, model: 'b' } as ApiConfig
    await rt.kernel.handleSend('two')

    expect((createAgent as Mock).mock.calls.length).toBeGreaterThan(built)
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })
})

// Reason: regression — the reply's page link reads metadata.pageUrl, which the
// panel send path wrote but the offscreen sendNow dropped, so mirror mode lost
// the feature entirely. Both send exits must honor the same provenance contract.
describe('SessionRuntime page provenance', () => {
  it('writes pageUrl/pageTitle from opts.page into message metadata', async () => {
    const env = makeEnv()
    const rt = new SessionRuntime({
      session: session('a'),
      env,
      hooks: makeHooks(),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('hello', undefined, { page: { title: 'A', url: 'https://a.com/x' } })
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const sent = sendSpy.mock.calls[0][0] as { metadata?: { pageUrl?: string; pageTitle?: string } }
    expect(sent.metadata?.pageUrl).toBe('https://a.com/x')
    expect(sent.metadata?.pageTitle).toBe('A')
  })

  it('drops non-http provenance (chrome://) instead of writing it', async () => {
    const env = makeEnv()
    const rt = new SessionRuntime({
      session: session('a'),
      env,
      hooks: makeHooks(),
      getConfig: () => cfg,
    })
    const sendSpy = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
    await rt.kernel.handleSend('hello', undefined, { page: { title: 'X', url: 'chrome://extensions/' } })
    const sent = sendSpy.mock.calls[0][0] as { metadata?: { pageUrl?: string } }
    expect(sent.metadata?.pageUrl).toBeUndefined()
  })
})

describe('settleTitle', () => {
  it('resolves immediately for a session that already has its title', async () => {
    const { rt } = makeRuntime(session('a', { title: '拿铁' }))
    await expect(rt.settleTitle(1000)).resolves.toBeUndefined()
  })

  it('waits for the generated title instead of resolving on the placeholder', async () => {
    const { rt } = makeRuntime(session('a', { title: 'New Chat' }))
    let settled = false
    const waiting = rt.settleTitle(1000).then(() => { settled = true })
    await new Promise(r => setTimeout(r, 10))
    expect(settled).toBe(false)

    rt.session = { ...rt.session, title: '修列表圆点' }
    rt.kstate.bump()
    await waiting
    expect(settled).toBe(true)
  })

  it('gives up at the deadline when no title ever lands', async () => {
    const { rt } = makeRuntime(session('a', { title: 'New Chat' }))
    const t0 = Date.now()
    await rt.settleTitle(30)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
  })

  it('keeps waiting through unrelated state changes (streaming bumps)', async () => {
    const { rt } = makeRuntime(session('a', { title: 'New Chat' }))
    let settled = false
    const waiting = rt.settleTitle(1000).then(() => { settled = true })
    rt.kstate.bump()
    rt.kstate.bump()
    await new Promise(r => setTimeout(r, 10))
    expect(settled).toBe(false)
    rt.session = { ...rt.session, title: '有标题了' }
    rt.kstate.bump()
    await waiting
    expect(settled).toBe(true)
  })
})
