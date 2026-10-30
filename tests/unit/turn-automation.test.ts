import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/shared/agent', () => ({
  createAgent: vi.fn().mockResolvedValue({}),
}))
vi.mock('../../src/shared/ai-provider', () => ({
  generateTitle: vi.fn().mockResolvedValue('Generated Title'),
  compactContext: vi.fn().mockResolvedValue('SUMMARY'),
}))

import { SessionRuntime, type KernelEnv, type RuntimeHooks } from '../../src/shared/kernel/kernel-runtime'
import { wireTurnAutomation } from '../../src/shared/kernel/turn-automation'
import type { ApiConfig, ChatSession, PageContent } from '../../src/shared/types'

const cfg = { model: 'test', contextWindow: 100000, mcpServers: [] } as unknown as ApiConfig

function session(id: string): ChatSession {
  return {
    id, title: `S-${id}`, createdAt: 1, updatedAt: 1, mode: 'chat',
    messages: [{ id: `m-${id}`, role: 'user', parts: [{ type: 'text', text: `hello ${id}` }] }],
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
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }
}

const hooks: RuntimeHooks = {
  getPageInfo: () => null,
  extractContent: vi.fn().mockResolvedValue({} as PageContent),
  getCurrentTabId: () => null,
}

function makeWired(onSessionUpdated?: (s: ChatSession) => void) {
  const env = makeEnv()
  const rt = new SessionRuntime({ session: session('a'), env, hooks, getConfig: () => cfg, onSessionUpdated })
  wireTurnAutomation(rt, () => cfg)
  return { rt, env }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

// Reason: regression for the save feedback loop — flushSave() bumps kstate
// (and pool #notify bumps all runtimes), which used to reschedule another
// save every 300ms forever, each one a full-array storage write.
describe('wireTurnAutomation save loop guard', () => {
  it('a message change saves exactly once; the save\'s own bump does not reschedule', async () => {
    const { rt, env } = makeWired()
    rt.injectMessage('assistant', 'answer') // real change → bump
    await vi.advanceTimersByTimeAsync(10_000)
    expect(env.saveSession).toHaveBeenCalledTimes(1)
  })

  it('external bumps (pool #notify) with unchanged messages never trigger saves', async () => {
    const { rt, env } = makeWired()
    rt.injectMessage('assistant', 'answer')
    await vi.advanceTimersByTimeAsync(10_000)
    ;(env.saveSession as ReturnType<typeof vi.fn>).mockClear()
    for (let i = 0; i < 20; i++) {
      rt.kstate.bump()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(env.saveSession).not.toHaveBeenCalled()
  })

  it('cross-runtime notify storm stays quiescent (two wired runtimes bumping each other)', async () => {
    // Reason: reproduce the production wiring — each flushSave notifies the
    // pool, which bumps every live runtime. Without the reference guard this
    // ping-pongs forever.
    const runtimes: SessionRuntime[] = []
    const notifyAll = () => { for (const r of runtimes) r.kstate.bump() }
    const a = makeWired(notifyAll)
    const b = makeWired(notifyAll)
    runtimes.push(a.rt, b.rt)
    a.rt.injectMessage('assistant', 'answer')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(a.env.saveSession).toHaveBeenCalledTimes(1)
    expect(b.env.saveSession).not.toHaveBeenCalled()
  })

  it('a further message change after quiescence saves again', async () => {
    const { rt, env } = makeWired()
    rt.injectMessage('assistant', 'one')
    await vi.advanceTimersByTimeAsync(10_000)
    rt.injectMessage('assistant', 'two')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(env.saveSession).toHaveBeenCalledTimes(2)
  })

  it('retains tab lock across queued turn handoff and releases after queue drains', async () => {
    const { rt, env } = makeWired()
    vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)

    rt.kstate.status = 'streaming'
    await rt.kernel.handleSend('queued follow-up')
    ;(env.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    rt.kstate.status = 'ready'
    await Promise.resolve()

    expect(env.sendMessage).toHaveBeenCalledWith({ type: 'tab-lock:touch', sessionId: rt.sessionId })
    expect(env.sendMessage).not.toHaveBeenCalledWith({ type: 'tab-lock:release', sessionId: rt.sessionId })

    ;(env.sendMessage as ReturnType<typeof vi.fn>).mockClear()
    rt.kstate.status = 'streaming'
    rt.kstate.status = 'ready'

    expect(env.sendMessage).toHaveBeenCalledWith({ type: 'tab-lock:release', sessionId: rt.sessionId })
  })

  // Reason: 'error' is terminal — the SDK never moves it to 'ready' on its own,
  // so without an explicit release the lock and the page indicator survive
  // until the 2-minute staleness backstop.
  it('releases the tab lock when a turn ends in the terminal error status', async () => {
    const { rt, env } = makeWired()
    rt.kstate.status = 'streaming'
    ;(env.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    rt.kstate.status = 'error'
    await Promise.resolve()

    expect(env.sendMessage).toHaveBeenCalledWith({ type: 'tab-lock:release', sessionId: rt.sessionId })
  })

  it('releases on error even with a queued continuation, since the queue cannot drain', async () => {
    const { rt, env } = makeWired()
    vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)

    rt.kstate.status = 'streaming'
    await rt.kernel.handleSend('queued follow-up')
    expect(rt.kernel.hasQueuedContinuation).toBe(true)
    ;(env.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    rt.kstate.status = 'error'
    await Promise.resolve()

    expect(env.sendMessage).toHaveBeenCalledWith({ type: 'tab-lock:release', sessionId: rt.sessionId })
    expect(env.sendMessage).not.toHaveBeenCalledWith({ type: 'tab-lock:touch', sessionId: rt.sessionId })
  })

  it('the returned unsubscribe detaches checkpointing and turn announcements', async () => {
    const env = makeEnv()
    const rt = new SessionRuntime({ session: session('a'), env, hooks, getConfig: () => cfg })
    const unwire = wireTurnAutomation(rt, () => cfg)
    unwire()
    rt.injectMessage('assistant', 'answer')
    rt.kstate.status = 'streaming'
    await vi.advanceTimersByTimeAsync(10_000)
    rt.kstate.status = 'ready'
    await Promise.resolve()
    expect(env.saveSession).not.toHaveBeenCalled()
    expect(env.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'turn:done' }))
  })

  it('does not re-release while already sitting in error', async () => {
    const { rt, env } = makeWired()
    rt.kstate.status = 'streaming'
    rt.kstate.status = 'error'
    ;(env.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    rt.kstate.bump()
    await Promise.resolve()

    expect(env.sendMessage).not.toHaveBeenCalledWith({ type: 'tab-lock:release', sessionId: rt.sessionId })
  })
})
