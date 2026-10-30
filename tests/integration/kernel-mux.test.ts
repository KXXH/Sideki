import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/shared/agent', () => ({
  createAgent: vi.fn().mockResolvedValue({}),
}))
vi.mock('../../src/shared/ai-provider', () => ({
  generateTitle: vi.fn().mockResolvedValue('Generated Title'),
  compactContext: vi.fn().mockResolvedValue('SUMMARY'),
}))

import { KernelPool } from '../../src/shared/kernel/kernel-pool'
import { KernelMux } from '../../src/shared/kernel/kernel-mux'
import { KernelSyncHost } from '../../src/shared/kernel/kernel-host'
import { createAgent } from '../../src/shared/agent'
import type { KernelEnv } from '../../src/shared/kernel/kernel-runtime'
import type { ApiConfig, ChatSession, PageContent } from '../../src/shared/types'
import type { SyncSnapshot, SyncPatch } from '../../src/shared/kernel/sync-protocol'

const cfg = { model: 'test', contextWindow: 100000, mcpServers: [] } as unknown as ApiConfig

function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id, title: `S-${id}`, createdAt: 1, updatedAt: 1, mode: 'chat',
    messages: [{ id: `m-${id}`, role: 'user', parts: [{ type: 'text', text: `hello ${id}` }] }],
    ...over,
  } as ChatSession
}

function makeEnv(sessions: ChatSession[]): KernelEnv {
  return {
    loadConfig: vi.fn().mockResolvedValue(cfg),
    onConfigChanged: vi.fn().mockReturnValue(() => {}),
    loadSessions: vi.fn().mockResolvedValue(sessions),
    loadSession: vi.fn().mockImplementation(async (id: string) => sessions.find(s => s.id === id) ?? null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    updateSessionMeta: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    removeHistory: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }
}

class FakePort {
  sent: (SyncSnapshot | SyncPatch)[] = []
  postMessage(msg: unknown) { this.sent.push(msg as SyncSnapshot | SyncPatch) }
  onMessage = { addListener: vi.fn() }
  onDisconnect = { addListener: vi.fn() }
  lastSnapshot(): SyncSnapshot | undefined {
    return [...this.sent].reverse().find(m => m.type === 'snapshot') as SyncSnapshot | undefined
  }
}

let cmdSeq = 0
const nextId = () => `cmd-${++cmdSeq}`

async function makeMux(sessions: ChatSession[]) {
  const env = makeEnv(sessions)
  const pool = new KernelPool(env, {
    graceMs: 0,
    maxIdle: 0,
    autoEvict: false,
    extractContent: vi.fn().mockResolvedValue({ title: 'P', url: 'u', content: 'c', images: [] } as unknown as PageContent),
  })
  const mux = new KernelMux(pool, {
    createHost: (rt) => new KernelSyncHost(rt.kernel, {
      throttleMs: 0,
      commands: { ping: () => rt.injectMessage('assistant', 'pong') },
      extras: () => ({ activeId: rt.sessionId, sessions: pool.sessions.map(s => ({ id: s.id })) }),
      requests: {
        'session-inspector': () => ({ craton: rt.craton, orogenLines: [] }),
      },
    }),
  })
  await mux.start()
  return { env, pool, mux }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('KernelMux binding', () => {
  it('bare sync binds to the most recent session and snapshots it', async () => {
    const { mux } = await makeMux([session('a', { updatedAt: 1 }), session('b', { updatedAt: 9 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    const snap = port.lastSnapshot()!
    expect(snap.sessionId).toBe('b')
    expect(snap.messages.map(m => m.id)).toEqual(['m-b'])
  })

  it('init rebinds to the requested mode', async () => {
    const { mux } = await makeMux([session('c', { mode: 'chat', updatedAt: 1 }), session('p', { mode: 'pro', updatedAt: 9 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    expect(port.lastSnapshot()!.sessionId).toBe('p')
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'init', args: { mode: 'chat' } })
    expect(port.lastSnapshot()!.sessionId).toBe('c')
  })

  it('select-session rebinds and releases the previous runtime', async () => {
    const { mux, pool } = await makeMux([session('a', { updatedAt: 9 }), session('b', { updatedAt: 1 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'b' } })
    expect(port.lastSnapshot()!.sessionId).toBe('b')
    // Reason: 'a' released (retain 0) — with maxIdle 0 + grace 0 it is evictable
    expect(pool.evictNow()).toBe(1)
    expect(pool.liveCount).toBe(1)
  })

  it('select-session rejects ids outside the requested mode', async () => {
    const { mux } = await makeMux([
      session('c', { mode: 'chat', updatedAt: 9 }),
      session('p', { mode: 'pro', updatedAt: 1 }),
    ])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    expect(port.lastSnapshot()!.sessionId).toBe('c')

    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'p', mode: 'chat' } })
    expect(port.lastSnapshot()!.sessionId).toBe('c')

    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'p', mode: 'pro' } })
    expect(port.lastSnapshot()!.sessionId).toBe('p')
  })

  it('a rejected rebind still answers with a snapshot', async () => {
    const { mux } = await makeMux([session('a', { updatedAt: 9 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    const snapshots = () => port.sent.filter(m => m.type === 'snapshot').length
    const before = snapshots()

    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'missing' } })

    // Reason: the mirror only clears bindingPending on a snapshot — a silent
    // refusal would leave every later send waiting on a dead rebind.
    expect(snapshots()).toBe(before + 1)
    expect(port.lastSnapshot()!.sessionId).toBe('a')
  })

  it('session-inspector request returns the bound runtime craton', async () => {
    const { mux, pool } = await makeMux([session('a', { updatedAt: 9 }), session('b', { updatedAt: 1 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    expect(port.lastSnapshot()!.sessionId).toBe('a')

    const craton = { instructions: 'frozen-a', builtAt: 1 }
    ;(await pool.acquire('a'))!.craton = craton

    // Reason: exercise the same request route the panel mirror uses, without
    // turning the full craton into an 80ms extras payload.
    await mux.handleMessage(port, {
      type: 'request', id: nextId(), name: 'session-inspector', args: {},
    })
    const response = port.sent.at(-1) as { type: string; result?: { craton?: unknown; orogenLines?: unknown } }
    expect(response.type).toBe('response')
    expect(response.result?.craton).toEqual(craton)
    expect(response.result?.orogenLines).toEqual([])
  })

  it('duplicate command ids never double-execute (reconnect retry)', async () => {
    const { pool, mux } = await makeMux([session('a')])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    const id = nextId()
    await mux.handleMessage(port, { type: 'cmd', id, name: 'new-session', args: { mode: 'chat' } })
    const count = pool.sessions.length
    await mux.handleMessage(port, { type: 'cmd', id, name: 'new-session', args: { mode: 'chat' } })
    expect(pool.sessions.length).toBe(count)
  })

  // Reason: entry actions (open, switch, new session, manual context load) must
  // stay free — page extraction, the MCP tool list and the craton are all built
  // by the first send, so entering a session blocks on nothing.
  it('entering a session builds nothing until the first send', async () => {
    const { env, mux, pool } = await makeMux([session('a', { updatedAt: 9 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'new-session', args: { mode: 'chat' } })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'a', mode: 'chat' } })
    await mux.handleMessage(port, {
      type: 'cmd', id: nextId(), name: 'page-context',
      args: { content: { title: 'P', url: 'https://x.test/', content: 'c', images: [] }, pageInfo: { title: 'P', url: 'https://x.test/' } },
    })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'init', args: { mode: 'chat' } })
    await new Promise(r => setTimeout(r, 0))

    expect((createAgent as Mock).mock.calls.length).toBe(0)
    const ensures = (env.sendMessage as Mock).mock.calls.filter(c => (c[0] as { type?: string })?.type === 'mcp:ensure')
    expect(ensures.length).toBe(0)
    // Reason: the binding itself still happened — only the build is deferred
    expect(port.lastSnapshot()!.sessionId).toBeTruthy()
    expect(pool.liveCount).toBeGreaterThan(0)
  })
})

describe('KernelMux isolation', () => {
  it('two ports bound to different sessions receive only their own patches', async () => {
    const { mux, pool } = await makeMux([session('a', { updatedAt: 9 }), session('b', { updatedAt: 1 })])
    const pa = new FakePort()
    const pb = new FakePort()
    await mux.handleMessage(pa, { type: 'sync' })
    await mux.handleMessage(pb, { type: 'sync' })
    await mux.handleMessage(pb, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'b' } })
    const aSent = pa.sent.length
    const bSent = pb.sent.length
    ;(await pool.acquire('b'))!.injectMessage('assistant', 'only-b')
    expect(pb.sent.length).toBeGreaterThan(bSent)
    expect(pa.sent.length).toBe(aSent)
    const patch = pb.sent.at(-1) as SyncPatch
    expect(patch.changed.some(c => c.message.parts.some(p => (p as { text?: string }).text === 'only-b'))).toBe(true)
  })

  it('session commands route to the bound runtime', async () => {
    const { mux, pool } = await makeMux([session('a', { updatedAt: 9 }), session('b', { updatedAt: 1 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'b' } })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'ping', args: {} })
    expect((await pool.acquire('b'))!.kstate.messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'pong' }])
    expect((await pool.acquire('a'))!.kstate.messages).toHaveLength(1)
  })

  // Reason: regression check for the offscreen error path — a backend/LLM
  // failure sets kstate.error inside the offscreen kernel; that error must
  // reach the bound panel via the patch stream (errorMessage), otherwise the
  // turn appears to abort with no visible error bar.
  it('kstate errors propagate to the bound port as errorMessage', async () => {
    const { mux, pool } = await makeMux([session('a')])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    const before = port.sent.length
    ;(await pool.acquire('a'))!.kstate.error = new Error('backend 500: upstream failed')
    const patch = port.sent.slice(before).reverse().find(m => m.type === 'patch') as SyncPatch | undefined
    expect(patch).toBeDefined()
    expect(patch!.errorMessage).toBe('backend 500: upstream failed')
  })

  it('a fresh snapshot after an error still carries errorMessage', async () => {
    const { mux, pool } = await makeMux([session('a')])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    ;(await pool.acquire('a'))!.kstate.error = new Error('rate limited')
    // Reason: a reconnecting panel takes a fresh snapshot, not a patch.
    await mux.handleMessage(port, { type: 'sync' })
    expect(port.lastSnapshot()!.errorMessage).toBe('rate limited')
  })
})

describe('KernelMux panel presence', () => {
  it('a bound panel counts as foreground until it reports otherwise', async () => {
    const { mux } = await makeMux([session('a')])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    expect(mux.hasVisiblePanelFor('a')).toBe(true)
    await mux.handleMessage(port, { type: 'presence', visible: false })
    expect(mux.hasVisiblePanelFor('a')).toBe(false)
    await mux.handleMessage(port, { type: 'presence', visible: true })
    expect(mux.hasVisiblePanelFor('a')).toBe(true)
  })

  it('a session no panel shows is not foreground', async () => {
    const { mux } = await makeMux([
      session('a', { updatedAt: 9 }), session('b', { updatedAt: 1 }), session('c', { updatedAt: 1 }),
    ])
    const pa = new FakePort()
    const pb = new FakePort()
    await mux.handleMessage(pa, { type: 'sync' })
    await mux.handleMessage(pb, { type: 'sync' })
    await mux.handleMessage(pb, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'c' } })
    expect(mux.hasVisiblePanelFor('a')).toBe(true)
    expect(mux.hasVisiblePanelFor('c')).toBe(true)
    expect(mux.hasVisiblePanelFor('b')).toBe(false)
  })

  it('presence follows the port across a session switch', async () => {
    const { mux } = await makeMux([session('a', { updatedAt: 9 }), session('b', { updatedAt: 1 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    await mux.handleMessage(port, { type: 'presence', visible: false })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'select-session', args: { id: 'b' } })
    expect(mux.hasVisiblePanelFor('b')).toBe(false)
  })

  it('a closed panel stops counting immediately', async () => {
    const { mux } = await makeMux([session('a')])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    mux.handleDisconnect(port)
    expect(mux.hasVisiblePanelFor('a')).toBe(false)
  })
})

describe('KernelMux lifecycle', () => {
  it('delete-session rebinds affected ports to the survivor', async () => {
    const { mux } = await makeMux([session('a', { updatedAt: 9 }), session('b', { updatedAt: 1 })])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    await mux.handleMessage(port, { type: 'cmd', id: nextId(), name: 'delete-session', args: { id: 'a', mode: 'chat' } })
    expect(port.lastSnapshot()!.sessionId).toBe('b')
  })

  it('disconnect releases the binding', async () => {
    const { mux, pool } = await makeMux([session('a')])
    const port = new FakePort()
    await mux.handleMessage(port, { type: 'sync' })
    expect(pool.evictNow()).toBe(0)
    mux.handleDisconnect(port)
    expect(pool.evictNow()).toBe(1)
  })
})
