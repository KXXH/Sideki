import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendToolMessage, peekOperatingTabId, acquireTurnTab, setLockedTabId, setFallbackTabProvider, setActiveSessionId } from '../../src/shared/tools/bridge'
import type { ToolCallCtx } from '../../src/shared/tools/bridge'
import { createAgentTools, agentTools } from '../../src/shared/tools'

// Reason: session multiplexing runs several kernels concurrently — tool calls
// must carry their own session/tab context instead of module-level singletons.
const realChrome = globalThis.chrome

function stubChrome(opts: { operatingTab?: number; blockedMessage?: string; envFails?: boolean; lockedTab?: number | null } = {}) {
  const sendMessage = vi.fn().mockImplementation(async (msg: { type: string; anchorTabId?: number }) => {
    if (msg.type === 'tab-lock:query') {
      return { tabId: opts.lockedTab ?? null }
    }
    if (msg.type === 'env:operating-tab') {
      if (opts.envFails) throw new Error('SW unreachable')
      if (opts.blockedMessage) return { tabId: null, blocked: true, message: opts.blockedMessage }
      // Reason: the SW answers with the turn's stack top; tests default to
      // echoing the seed anchor (single-element stack, no navigation yet).
      return { tabId: opts.operatingTab ?? msg.anchorTabId ?? 77 }
    }
    if (msg.type === 'env:active-tab') {
      if (opts.envFails) throw new Error('SW unreachable')
      return { tabId: 77 }
    }
    if (msg.type.startsWith('tool:bash')) return { success: true, stdout: 'ok', stderr: '', exitCode: 0 }
    return { success: true }
  })
  vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: null } })
  return { sendMessage }
}

beforeEach(() => {
  setLockedTabId(null)
  setFallbackTabProvider(null)
  setActiveSessionId('')
})

afterEach(() => {
  vi.stubGlobal('chrome', realChrome)
})

describe('sendToolMessage with per-call context', () => {
  it('ctx.getTabId seeds resolution and wins over provider and env fallback', async () => {
    const { sendMessage } = stubChrome()
    setFallbackTabProvider(() => 42)
    const ctx: ToolCallCtx = { getTabId: () => 11, getSessionId: () => 'ctx-s' }
    await sendToolMessage('click', { target: 'x' }, undefined, ctx)
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 11 })
    // Reason: an unpinned anchor is a WINDOW anchor — the SW resolves the seed
    // from it, then the turn's own stack takes over.
    const env = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'env:operating-tab')
    expect(env![0]).toMatchObject({ sessionId: 'ctx-s', anchorTabId: 11, pinned: false })
  })

  // Reason: regression — a click that opens a new tab must move the tool
  // context along. The stack (SW-side) owns that move, not the window's
  // active tab, so concurrent turns cannot steer each other.
  it('operates on the turn’s stack top, not on the anchor', async () => {
    const { sendMessage } = stubChrome({ operatingTab: 55 })
    await sendToolMessage('click', { target: 'x' }, undefined, { getTabId: () => 11, getSessionId: () => 's' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 55 })
  })

  // Reason: another session holds the tab — the tool must fail loudly instead
  // of acting on a page someone else is mutating.
  it('throws the busy message when the tab is held by another session', async () => {
    const { sendMessage } = stubChrome({ blockedMessage: 'Error: the current page is being operated by another background task' })
    await expect(
      sendToolMessage('click', { target: 'x' }, undefined, { getTabId: () => 11, getSessionId: () => 's' }),
    ).rejects.toThrow('another background task')
    expect(sendMessage.mock.calls.some(c => (c[0] as { type: string }).type === 'tool:click')).toBe(false)
  })

  it('falls back to the anchor itself when the SW is unreachable', async () => {
    const sendMessage = vi.fn().mockImplementation(async (msg: { type: string }) => {
      if (msg.type === 'env:operating-tab' || msg.type === 'env:active-tab') throw new Error('SW unreachable')
      return { success: true }
    })
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: null } })
    await sendToolMessage('click', { target: 'x' }, undefined, { getTabId: () => 11, getSessionId: () => 's' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 11 })
  })

  it('locked tab still wins over ctx (panel context lock)', async () => {
    const { sendMessage } = stubChrome()
    setLockedTabId(9)
    await sendToolMessage('click', { target: 'x' }, undefined, { getTabId: () => 11 })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 9 })
  })

  it('ctx returning null falls through to the provider chain', async () => {
    const { sendMessage } = stubChrome()
    setFallbackTabProvider(() => 42)
    await sendToolMessage('click', { target: 'x' }, undefined, { getTabId: () => null })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 42 })
  })

  it('ctx.getSessionId scopes bash to its own session', async () => {
    const { sendMessage } = stubChrome()
    setActiveSessionId('global-s')
    await sendToolMessage('bash', { command: 'ls' }, undefined, { getTabId: () => 1, getSessionId: () => 'ctx-s' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:bash')
    expect((call![0] as { params: { sessionId: string } }).params.sessionId).toBe('ctx-s')
  })

  it('falls back to module-level session id without ctx (panel mode)', async () => {
    const { sendMessage } = stubChrome()
    setActiveSessionId('global-s')
    setFallbackTabProvider(() => 1)
    await sendToolMessage('bash', { command: 'ls' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:bash')
    expect((call![0] as { params: { sessionId: string } }).params.sessionId).toBe('global-s')
  })
})

// Reason: consent routing / site attribution need the operating tab, but must
// never promote a lock-free turn (pure MCP) into a lock holder.
describe('peekOperatingTabId', () => {
  it('returns the turn’s operating tab without seeding a stack', async () => {
    const { sendMessage } = stubChrome({ lockedTab: 55 })
    setActiveSessionId('s')
    expect(await peekOperatingTabId()).toBe(55)
    // Reason: env:operating-tab is the seeding path — it must not be touched.
    expect(sendMessage.mock.calls.some(c => (c[0] as { type: string }).type === 'env:operating-tab')).toBe(false)
  })

  it('falls back to the ctx anchor when no turn owns a tab', async () => {
    stubChrome({ lockedTab: null })
    setActiveSessionId('s')
    expect(await peekOperatingTabId({ getTabId: () => 11, getSessionId: () => 's' })).toBe(11)
  })

  it('returns null without ctx or lock so callers can apply their own fallback', async () => {
    stubChrome({ lockedTab: null })
    setActiveSessionId('s')
    expect(await peekOperatingTabId()).toBeNull()
  })
})

// Reason: the turn's tab stack is seeded at turn start, not lazily on the first
// tool call — the whole turn needs one stable tab reference.
describe('acquireTurnTab', () => {
  it('seeds the stack through the operating-tab gate', async () => {
    const { sendMessage } = stubChrome({ operatingTab: 42 })
    setActiveSessionId('s')
    await acquireTurnTab({ getTabId: () => 42, getSessionId: () => 's' })
    const seedCall = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'env:operating-tab')
    expect(seedCall?.[0]).toMatchObject({ sessionId: 's', anchorTabId: 42 })
  })

  it('swallows a contested seed tab so the turn still starts', async () => {
    stubChrome({ blockedMessage: 'busy' })
    setActiveSessionId('s')
    await expect(acquireTurnTab({ getTabId: () => 42, getSessionId: () => 's' })).resolves.toBeUndefined()
  })
})

describe('createAgentTools isolation', () => {
  it('two tool sets route to their own tabs concurrently', async () => {
    const { sendMessage } = stubChrome()
    const toolsA = createAgentTools({ getTabId: () => 100, getSessionId: () => 'sa' })
    const toolsB = createAgentTools({ getTabId: () => 200, getSessionId: () => 'sb' })
    type Exec = { execute: (args: Record<string, unknown>, opts: { abortSignal?: AbortSignal }) => Promise<unknown> }
    await Promise.all([
      (toolsA.click as unknown as Exec).execute({ target: 'x', doubleClick: false, real: false }, {}),
      (toolsB.click as unknown as Exec).execute({ target: 'y', doubleClick: false, real: false }, {}),
      (toolsA.bash as unknown as Exec).execute({ command: 'ls' }, {}),
      (toolsB.bash as unknown as Exec).execute({ command: 'ls' }, {}),
    ])
    const clicks = sendMessage.mock.calls.filter(c => (c[0] as { type: string }).type === 'tool:click')
    expect(clicks.map(c => (c[0] as { tabId: number }).tabId).sort()).toEqual([100, 200])
    const bashes = sendMessage.mock.calls.filter(c => (c[0] as { type: string }).type === 'tool:bash')
    expect(bashes.map(c => (c[0] as { params: { sessionId: string } }).params.sessionId).sort()).toEqual(['sa', 'sb'])
  })

  it('static agentTools remains the no-ctx variant (panel mode unchanged)', () => {
    expect(Object.keys(agentTools).sort()).toEqual(Object.keys(createAgentTools()).sort())
  })
})
