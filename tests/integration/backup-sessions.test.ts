import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '../../src/shared/types'

const idb = new Map<string | number, unknown>()
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => structuredClone(idb.get(key))),
  keys: vi.fn(async () => [...idb.keys()]),
}))

const baseChrome = chrome
let local: Record<string, unknown>
let client: typeof import('../../src/background/backup-client')
let storage: typeof import('../../src/shared/storage')
let socket: FakeSocket
const sockets: FakeSocket[] = []
const localGet = vi.fn(async (requested?: string | string[] | null) => {
  if (requested == null) return structuredClone(local)
  const selected = typeof requested === 'string' ? [requested] : requested
  return structuredClone(Object.fromEntries(selected.filter(key => key in local).map(key => [key, local[key]])))
})

class FakeSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  sent: Array<Record<string, unknown>> = []

  constructor() { sockets.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = FakeSocket.CLOSED; this.onclose?.() }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  receive(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

function session(id: string, updatedAt = 1): ChatSession {
  return { id, title: id, createdAt: 1, updatedAt, messages: [{ role: 'user', content: `Synthetic ${id}` }] }
}

function seedSessions(sessions: ChatSession[]) {
  local[storage.SESSION_INDEX_KEY] = sessions.map(storage.sessionIndexEntry)
  for (const value of sessions) local[storage.sessionStorageKey(value.id)] = value
}

function sessionPushes() {
  return socket.sent.filter(message => message.type === 'push' && message.category === 'session')
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  idb.clear()
  sockets.length = 0
  local = { sidekick_backup_key: 'synthetic-pair-key', sidekick_session_index: [] }
  let queue: Promise<unknown> = Promise.resolve()
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn(<T>(_name: string, operation: () => Promise<T>): Promise<T> => {
        const result = queue.then(operation)
        queue = result.then(() => undefined, () => undefined)
        return result
      }),
    },
  })
  vi.stubGlobal('chrome', {
    ...baseChrome,
    storage: {
      ...baseChrome.storage,
      local: {
        get: localGet,
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(local, structuredClone(values)) }),
        remove: vi.fn(async (requested: string | string[]) => {
          for (const key of typeof requested === 'string' ? [requested] : requested) delete local[key]
        }),
      },
    },
    runtime: { ...baseChrome.runtime, getManifest: () => ({ version: 'test' }) },
  })
  vi.stubGlobal('WebSocket', FakeSocket)
  storage = await import('../../src/shared/storage')
  client = await import('../../src/background/backup-client')
  const probing = client.probeAndConnect()
  await Promise.resolve()
  socket = sockets[0]
  socket.open()
  await probing
  socket.sent = []
  localGet.mockClear()
})

afterEach(() => {
  socket.close()
  vi.unstubAllGlobals()
})

describe('backup session storage changes', () => {
  it('pushes a changed body even if updatedAt did not advance', () => {
    const before = session('a', 10)
    const after = { ...before, title: 'Renamed', messages: [...before.messages, { role: 'assistant', content: 'Checkpoint' }] }
    client.handleStorageChange({
      [storage.sessionStorageKey('a')]: { oldValue: before, newValue: after },
      [storage.SESSION_INDEX_KEY]: { oldValue: [storage.sessionIndexEntry(before)], newValue: [storage.sessionIndexEntry(after)] },
    })
    expect(sessionPushes()).toEqual([{ type: 'push', category: 'session', key: 'a', data: after }])
    expect(localGet).not.toHaveBeenCalled()
  })

  it('pushes added records and protocol-compatible explicit deletions', () => {
    const added = session('new')
    client.handleStorageChange({
      [storage.sessionStorageKey('new')]: { newValue: added },
      [storage.sessionStorageKey('removed')]: { oldValue: session('removed') },
    })
    expect(sessionPushes()).toEqual([
      { type: 'push', category: 'session', key: 'new', data: added },
      { type: 'push', category: 'session', key: 'removed', data: null, deleted: true },
    ])
  })

  it('ignores index changes and deletion of the migrated legacy array', () => {
    client.handleStorageChange({
      sidekick_sessions: { oldValue: [session('a'), session('b')] },
      [storage.SESSION_INDEX_KEY]: { newValue: [storage.sessionIndexEntry(session('a'))] },
    })
    expect(socket.sent).toEqual([])
  })

  it('pushes migrated bodies without treating legacy cleanup as deletion', () => {
    const migrated = session('a')
    client.handleStorageChange({
      sidekick_sessions: { oldValue: [migrated] },
      [storage.sessionStorageKey('a')]: { newValue: migrated },
    })
    expect(sessionPushes()).toEqual([{ type: 'push', category: 'session', key: 'a', data: migrated }])
  })

  it('preserves config, skills, actions, history and OAuth change handling', () => {
    client.handleStorageChange({
      sidekick_config: { newValue: { endpoint: 'synthetic' } },
      userSkills: { newValue: { skill: 'content' } },
      customActions: { newValue: ['action'] },
      'history:a': { newValue: ['archive'] },
      'history:removed': { oldValue: ['archive'] },
      mcp_tokens_demo: { newValue: 'synthetic-token' },
      mcp_client_demo: { oldValue: 'synthetic-client' },
      mcp_as_demo: { newValue: 'synthetic-server' },
      unrelated: { newValue: 'ignored' },
    })
    expect(socket.sent).toEqual([
      { type: 'push', category: 'config', key: 'config', data: { endpoint: 'synthetic' } },
      { type: 'push', category: 'userSkills', key: 'userSkills', data: { skill: 'content' } },
      { type: 'push', category: 'customActions', key: 'customActions', data: ['action'] },
      { type: 'push', category: 'history', key: 'a', data: ['archive'] },
      { type: 'push', category: 'history', key: 'removed', deleted: true },
      { type: 'push', category: 'mcpAuth', key: 'mcp_tokens_demo', data: 'synthetic-token' },
      { type: 'push', category: 'mcpAuth', key: 'mcp_client_demo', deleted: true },
      { type: 'push', category: 'mcpAuth', key: 'mcp_as_demo', data: 'synthetic-server' },
    ])
  })

  it('does not push after pairing is invalidated', () => {
    socket.receive({ type: 'backup_exists' })
    client.handleStorageChange({ [storage.sessionStorageKey('a')]: { newValue: session('a') } })
    expect(sessionPushes()).toEqual([])
  })
})

describe('backup delta sync', () => {
  it('compares index timestamps and reuses one chrome snapshot for full bodies', async () => {
    const sessions = [session('equal', 5), session('changed', 10), session('unknown', 0), session('remote-newer', 2)]
    seedSessions(sessions)
    local[storage.sessionStorageKey('orphan')] = session('orphan', 100)
    socket.receive({ type: 'welcome', knownSessions: { equal: { ts: 5 }, changed: { ts: 1 }, 'remote-newer': { ts: 9 } } })
    await vi.waitFor(() => { expect(client.getSyncState().phase).toBe('syncing') })

    expect(sessionPushes()).toEqual([
      { type: 'push', category: 'session', key: 'changed', data: sessions[1] },
      { type: 'push', category: 'session', key: 'unknown', data: sessions[2] },
    ])
    expect(localGet.mock.calls.filter(call => call[0] === undefined)).toHaveLength(1)
    expect(localGet.mock.calls).toHaveLength(3)
    expect(localGet.mock.calls.some(([requested]) => {
      const keys = typeof requested === 'string' ? [requested] : requested ?? []
      return keys.some(key => key.startsWith(storage.SESSION_KEY_PREFIX))
    })).toBe(false)
    expect(client.getSyncState()).toMatchObject({ total: 2, done: 0, errors: 0 })
    socket.receive({ type: 'ack', ok: true })
    socket.receive({ type: 'ack', ok: true })
    expect(client.getSyncState()).toMatchObject({ phase: 'done', done: 2 })
  })

  it('pushes explicit deletions for sessions the daemon still knows', async () => {
    seedSessions([session('kept', 5)])
    socket.receive({ type: 'welcome', knownSessions: { kept: { ts: 5 }, gone: { ts: 3 } } })
    await vi.waitFor(() => { expect(client.getSyncState().phase).toBe('syncing') })
    expect(sessionPushes()).toEqual([
      { type: 'push', category: 'session', key: 'gone', data: null, deleted: true },
    ])
    expect(client.getSyncState()).toMatchObject({ total: 1, done: 0, errors: 0 })
    socket.receive({ type: 'ack', ok: true })
    expect(client.getSyncState()).toMatchObject({ phase: 'done', done: 1 })
  })

  it('retains config normalization and all non-session delta categories', async () => {
    seedSessions([session('a')])
    Object.assign(local, {
      sidekick_config: { endpoint: 'synthetic', proMode: true },
      userSkills: { demo: 'content' }, customActions: ['action'], 'history:a': ['archive'],
      mcp_tokens_demo: 'synthetic-token', mcp_client_demo: 'synthetic-client', mcp_as_demo: 'synthetic-server',
    })
    idb.set('shellfs:a', { '/tmp/a': 'file' })
    idb.set('memory:global', 'memory')
    idb.set('unrelated', 'ignore')
    idb.set(7, 'ignore')
    socket.receive({ type: 'welcome', knownSessions: {} })
    await vi.waitFor(() => { expect(client.getSyncState().phase).toBe('syncing') })
    expect(socket.sent).toEqual([
      { type: 'push', category: 'session', key: 'a', data: session('a') },
      { type: 'push', category: 'config', key: 'config', data: { endpoint: 'synthetic', yoloMode: true, defaultPermissionMode: 'allow' } },
      { type: 'push', category: 'userSkills', key: 'userSkills', data: { demo: 'content' } },
      { type: 'push', category: 'customActions', key: 'customActions', data: ['action'] },
      { type: 'push', category: 'history', key: 'a', data: ['archive'] },
      { type: 'push', category: 'mcpAuth', key: 'mcp_tokens_demo', data: 'synthetic-token' },
      { type: 'push', category: 'mcpAuth', key: 'mcp_client_demo', data: 'synthetic-client' },
      { type: 'push', category: 'mcpAuth', key: 'mcp_as_demo', data: 'synthetic-server' },
      { type: 'push', category: 'shellfs', key: 'a', data: { '/tmp/a': 'file' } },
      { type: 'push', category: 'memory', key: 'global', data: 'memory' },
    ])
    expect(client.getSyncState().total).toBe(10)
  })

  it('migrates synthetic legacy records before preparing a delta', async () => {
    const legacy = session('legacy', 5)
    local = { sidekick_backup_key: 'synthetic-pair-key', sidekick_sessions: [legacy] }
    socket.receive({ type: 'welcome', knownSessions: {} })
    await vi.waitFor(() => { expect(client.getSyncState().phase).toBe('syncing') })
    expect(sessionPushes()).toEqual([{ type: 'push', category: 'session', key: 'legacy', data: legacy }])
    expect(local.sidekick_sessions).toBeUndefined()
  })

  it('finishes without pushing when every indexed session is current', async () => {
    seedSessions([session('a', 5)])
    socket.receive({ type: 'welcome', knownSessions: { a: { ts: 5 } } })
    await vi.waitFor(() => { expect(client.getSyncState().phase).toBe('done') })
    expect(socket.sent).toEqual([])
    expect(client.getSyncState()).toMatchObject({ total: 0, done: 0, errors: 0 })
  })

  it('skips delta sync when the daemon omits knownSessions', () => {
    socket.receive({ type: 'welcome' })
    expect(localGet).not.toHaveBeenCalled()
    expect(socket.sent).toEqual([])
    expect(client.getSyncState().phase).toBe('idle')
  })
})
