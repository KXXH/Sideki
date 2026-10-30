import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('../../src/shared/agent', () => ({
  createAgent: vi.fn().mockResolvedValue({}),
}))
vi.mock('../../src/shared/ai-provider', () => ({
  generateTitle: vi.fn().mockResolvedValue('Generated Title'),
  compactContext: vi.fn().mockResolvedValue('SUMMARY'),
}))

import { KernelPool } from '../../src/shared/kernel/kernel-pool'
import { createAgent } from '../../src/shared/agent'
import type { KernelEnv } from '../../src/shared/kernel/kernel-runtime'
import type { ApiConfig, ChatSession, PageContent } from '../../src/shared/types'

const cfg = { model: 'test', contextWindow: 100000, mcpServers: [] } as unknown as ApiConfig

function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id, title: `S-${id}`, createdAt: 1, updatedAt: 1, mode: 'chat',
    messages: [{ id: `m-${id}`, role: 'user', parts: [{ type: 'text', text: `hello ${id}` }] }],
    ...over,
  } as ChatSession
}

function makeEnv(sessions: ChatSession[] = [], config: ApiConfig | null = cfg): KernelEnv {
  return {
    loadConfig: vi.fn().mockResolvedValue(config),
    onConfigChanged: vi.fn().mockReturnValue(() => {}),
    loadSessions: vi.fn().mockResolvedValue(sessions),
    loadSession: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    updateSessionMeta: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    removeHistory: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }
}

function makePool(sessions: ChatSession[] = [], opts: ConstructorParameters<typeof KernelPool>[1] = {}) {
  const env = makeEnv(sessions)
  const pool = new KernelPool(env, {
    graceMs: 0,
    maxIdle: 3,
    autoEvict: false,
    extractContent: vi.fn().mockResolvedValue({ title: 'P', url: 'u', content: 'c', images: [] } as unknown as PageContent),
    ...opts,
  })
  return { env, pool }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('KernelPool.init', () => {
  it('loads config and all sessions sorted by recency', async () => {
    const { pool } = makePool([session('a', { updatedAt: 10 }), session('b', { updatedAt: 99 }), session('p', { mode: 'pro', updatedAt: 50 })])
    await pool.init()
    expect(pool.config).toEqual(cfg)
    expect(pool.sessions.map(s => s.id)).toEqual(['b', 'p', 'a'])
  })

  it('ensureSessionFor creates and persists when a mode has no session', async () => {
    const { env, pool } = makePool([session('p', { mode: 'pro' })])
    await pool.init()
    const s = pool.ensureSessionFor('chat')
    expect(s.mode).toBe('chat')
    expect(env.saveSession).toHaveBeenCalledWith(s)
    expect(pool.ensureSessionFor('chat').id).toBe(s.id)
  })

  it('legacy sessions without mode count as chat', async () => {
    const legacy = { ...session('l'), mode: undefined } as unknown as ChatSession
    const { pool } = makePool([legacy])
    await pool.init()
    expect(pool.ensureSessionFor('chat').id).toBe('l')
  })
})

describe('KernelPool.acquire', () => {
  it('cold-loads a runtime with the session messages; second acquire reuses it', async () => {
    const { pool } = makePool([session('a')])
    await pool.init()
    const rt = (await pool.acquire('a'))!
    expect(rt.kstate.messages.map(m => m.id)).toEqual(['m-a'])
    expect(await pool.acquire('a')).toBe(rt)
    expect(pool.liveCount).toBe(1)
  })

  it('hydrates metadata-only entries via env.loadSession', async () => {
    // Reason: stripped entries always carry messageCount — that is the
    // hydration trigger, not the empty messages array.
    const meta = session('h', { messages: [], messageCount: 1 })
    const { env, pool } = makePool([meta])
    ;(env.loadSession as Mock).mockResolvedValue(session('h'))
    await pool.init()
    const rt = (await pool.acquire('h'))!
    expect(env.loadSession).toHaveBeenCalledWith('h')
    expect(rt.kstate.messages.map(m => m.id)).toEqual(['m-h'])
  })

  it('preserves a rename made while a cold body read is pending', async () => {
    const { env, pool } = makePool([session('h', { messages: [], messageCount: 1 })])
    let finishRead!: (value: ChatSession) => void
    vi.mocked(env.loadSession).mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
    await pool.init()
    const acquired = pool.acquire('h')
    pool.renameSession('h', 'Renamed while loading')
    finishRead(session('h'))
    const rt = (await acquired)!
    expect(rt.session.title).toBe('Renamed while loading')
    expect(rt.kstate.messages.map(m => m.id)).toEqual(['m-h'])
    rt.flushSave()
    expect(env.saveSession).toHaveBeenCalledWith(expect.objectContaining({ title: 'Renamed while loading' }))
  })

  it('does not create an empty runtime when the indexed body is missing', async () => {
    const { env, pool } = makePool([session('h', { messages: [], messageCount: 1 })])
    await pool.init()
    expect(await pool.acquire('h')).toBeNull()
    expect(pool.liveCount).toBe(0)
    expect(env.saveSession).not.toHaveBeenCalled()
  })

  it('propagates a body read failure without making metadata writable', async () => {
    const { env, pool } = makePool([session('h', { messages: [], messageCount: 1 })])
    vi.mocked(env.loadSession).mockRejectedValueOnce(new Error('read failed'))
    await pool.init()
    await expect(pool.acquire('h')).rejects.toThrow('read failed')
    expect(pool.liveCount).toBe(0)
    expect(env.saveSession).not.toHaveBeenCalled()
  })

  // Reason: regression — a just-created session is genuinely empty; hydrating
  // it dragged a full storage read into the new-session click path (perceived
  // lag on "new chat").
  it('skips hydration for just-created sessions', async () => {
    const { env, pool } = makePool([])
    await pool.init()
    const s = pool.newSession('chat')
    const rt = await pool.acquire(s.id)
    expect(rt).not.toBeNull()
    expect(env.loadSession).not.toHaveBeenCalled()
  })

  it('skips hydration for stored sessions with zero messages', async () => {
    const meta = session('z', { messages: [], messageCount: 0 })
    const { env, pool } = makePool([meta])
    await pool.init()
    const rt = await pool.acquire('z')
    expect(rt).not.toBeNull()
    expect(env.loadSession).not.toHaveBeenCalled()
  })

  it('returns null for unknown sessions', async () => {
    const { pool } = makePool([])
    await pool.init()
    expect(await pool.acquire('missing')).toBeNull()
  })

  it('two runtimes hold isolated page contexts', async () => {
    const { pool } = makePool([session('a'), session('b')])
    await pool.init()
    pool.updatePageCtx('a', { pageInfo: { title: 'A', url: 'https://a.com' }, tabId: 1 })
    pool.updatePageCtx('b', { pageInfo: { title: 'B', url: 'https://b.com' }, tabId: 2 })
    const ra = (await pool.acquire('a'))!
    const rb = (await pool.acquire('b'))!
    expect(ra.hooks.getCurrentTabId()).toBe(1)
    expect(rb.hooks.getCurrentTabId()).toBe(2)
    expect(ra.hooks.getPageInfo()?.url).toBe('https://a.com')
    expect(rb.hooks.getPageInfo()?.url).toBe('https://b.com')
  })
})

describe('KernelPool eviction', () => {
  it('idle runtimes beyond maxIdle are evicted LRU with a final save', async () => {
    const { env, pool } = makePool(
      [session('a'), session('b'), session('c')],
      { maxIdle: 1, graceMs: 0 },
    )
    await pool.init()
    await pool.retain('a'); await pool.retain('b'); await pool.retain('c')
    pool.release('a'); await new Promise(r => setTimeout(r, 5))
    pool.release('b'); await new Promise(r => setTimeout(r, 5))
    pool.release('c')
    const evicted = pool.evictNow()
    expect(evicted).toBe(2)
    expect(pool.liveCount).toBe(1)
    // Reason: oldest released ('a', 'b') go first; 'c' stays warm
    expect(await pool.acquire('c')).toBe(await pool.acquire('c'))
    expect((env.saveSession as Mock).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('port-retained runtimes are pinned regardless of cap', async () => {
    const { pool } = makePool([session('a'), session('b')], { maxIdle: 0, graceMs: 0 })
    await pool.init()
    await pool.retain('a')
    await pool.retain('b')
    expect(pool.evictNow()).toBe(0)
    expect(pool.liveCount).toBe(2)
  })

  it('non-ready (streaming) runtimes are pinned even without ports', async () => {
    const { pool } = makePool([session('a')], { maxIdle: 0, graceMs: 0 })
    await pool.init()
    const rt = (await pool.retain('a'))!
    rt.kstate.status = 'streaming'
    pool.release('a')
    expect(pool.evictNow()).toBe(0)
    rt.kstate.status = 'ready'
    expect(pool.evictNow()).toBe(1)
  })

  it('grace period defers eviction after the last port detaches', async () => {
    const { pool } = makePool([session('a')], { maxIdle: 0, graceMs: 60_000 })
    await pool.init()
    await pool.retain('a')
    pool.release('a')
    expect(pool.evictNow()).toBe(0)
    expect(pool.evictNow(Date.now() + 61_000)).toBe(1)
  })

  it('acquire after eviction cold-loads with the flushed messages', async () => {
    const { pool } = makePool([session('a')], { maxIdle: 0, graceMs: 0 })
    await pool.init()
    const rt = (await pool.retain('a'))!
    rt.injectMessage('assistant', 'answer')
    pool.release('a')
    expect(pool.evictNow()).toBe(1)
    const rt2 = (await pool.acquire('a'))!
    expect(rt2).not.toBe(rt)
    expect(rt2.kstate.messages).toHaveLength(2)
  })
})

describe('KernelPool session CRUD', () => {
  it('newSession prepends, persists and is acquirable', async () => {
    const { env, pool } = makePool([session('a')])
    await pool.init()
    const s = pool.newSession('chat')
    expect(pool.sessions[0].id).toBe(s.id)
    expect(env.saveSession).toHaveBeenCalledWith(s)
    expect((await pool.acquire(s.id))!.kstate.messages).toEqual([])
  })

  it('deleteSession disposes the live runtime and returns the next session', async () => {
    const { env, pool } = makePool([session('a', { updatedAt: 2 }), session('b', { updatedAt: 1 })])
    await pool.init()
    await pool.retain('a')
    const next = await pool.deleteSession('a', 'chat')
    expect(env.deleteSession).toHaveBeenCalledWith('a')
    expect(env.removeHistory).toHaveBeenCalledWith('a')
    expect(pool.liveCount).toBe(0)
    expect(next.id).toBe('b')
  })

  it('runs eviction hooks before disposing a deleted runtime', async () => {
    const order: string[] = []
    const { pool } = makePool([session('a'), session('b')], {
      onRuntimeEvicted: () => order.push('evicted'),
    })
    await pool.init()
    const rt = (await pool.retain('a'))!
    const dispose = rt.dispose.bind(rt)
    vi.spyOn(rt, 'dispose').mockImplementation(() => { order.push('dispose'); dispose() })
    pool.onEvicted = () => order.push('router')
    await pool.deleteSession('a', 'chat')
    expect(order).toEqual(['evicted', 'dispose', 'router'])
  })

  it('deleting the last session of a mode creates a replacement', async () => {
    const { pool } = makePool([session('only')])
    await pool.init()
    const next = await pool.deleteSession('only', 'chat')
    expect(next.id).not.toBe('only')
    expect(next.mode).toBe('chat')
  })

  it('renameSession updates the list and a live runtime copy', async () => {
    const { env, pool } = makePool([session('a')])
    await pool.init()
    const rt = (await pool.retain('a'))!
    pool.renameSession('a', 'Renamed')
    expect(pool.sessions.find(s => s.id === 'a')!.title).toBe('Renamed')
    expect(rt.session.title).toBe('Renamed')
    expect(env.updateSessionMeta).toHaveBeenCalledWith('a', { title: 'Renamed', updatedAt: expect.any(Number) })
    expect(rt.session.updatedAt).toBe(pool.sessions[0].updatedAt)
    expect(env.saveSession).not.toHaveBeenCalled()
  })

  it('renames a cold metadata entry without saving its empty messages', async () => {
    const { env, pool } = makePool([session('a', { messages: [], messageCount: 12 })])
    await pool.init()
    pool.renameSession('a', 'Renamed')
    expect(env.updateSessionMeta).toHaveBeenCalledWith('a', { title: 'Renamed', updatedAt: expect.any(Number) })
    expect(env.saveSession).not.toHaveBeenCalled()
    expect(env.loadSession).not.toHaveBeenCalled()
    expect(pool.sessions[0].messageCount).toBe(12)
  })

  it('pool change notifications bump live runtimes for extras broadcast', async () => {
    const { pool } = makePool([session('a')])
    await pool.init()
    const rt = (await pool.retain('a'))!
    const before = rt.kstate.rev
    pool.renameSession('a', 'X')
    expect(rt.kstate.rev).toBeGreaterThan(before)
  })
})

describe('KernelPool config propagation', () => {
  // Reason: config edits no longer rebuild eagerly — live runtimes compare the
  // agent fingerprint on their next send, so a profile/MCP edit costs nothing
  // for sessions nobody is about to use. The pool still owns the new value,
  // which is what the mirror and the next build read.
  it('config changes update the pool without rebuilding live runtimes', async () => {
    const { env, pool } = makePool([session('a')])
    await pool.init()
    const onCfg = (env.onConfigChanged as Mock).mock.calls[0][0] as (c: ApiConfig) => void
    await pool.retain('a')

    onCfg({ ...cfg, model: 'other' } as ApiConfig)
    await new Promise(r => setTimeout(r, 0))

    expect(pool.config?.model).toBe('other')
    expect((createAgent as Mock).mock.calls.length).toBe(0)
  })
})

describe('KernelPool.refreshSessions', () => {
  it('picks up sessions created by other hosts while the document was idle', async () => {
    const { env, pool } = makePool([session('a')])
    await pool.init()
    ;(env.loadSessions as Mock).mockResolvedValue([session('a'), session('fresh', { updatedAt: 99 })])
    await pool.refreshSessions()
    expect(pool.sessions.map(s => s.id)).toEqual(['fresh', 'a'])
  })

  it('live runtime copies win over storage (in-flight saves)', async () => {
    const { env, pool } = makePool([session('a')])
    await pool.init()
    const rt = (await pool.retain('a'))!
    rt.injectMessage('assistant', 'hot')
    rt.flushSave()
    ;(env.loadSessions as Mock).mockResolvedValue([session('a')]) // stale storage read
    await pool.refreshSessions()
    expect(pool.sessions.find(s => s.id === 'a')!.messages).toHaveLength(2)
  })

  it('keeps local sessions missing from a stale storage read', async () => {
    const { env, pool } = makePool([session('a')])
    await pool.init()
    const s = pool.newSession('chat')
    ;(env.loadSessions as Mock).mockResolvedValue([session('a')]) // save not yet visible
    await pool.refreshSessions()
    expect(pool.sessions.some(x => x.id === s.id)).toBe(true)
  })
})
