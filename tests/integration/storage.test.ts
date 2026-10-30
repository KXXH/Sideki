import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  loadConfig, saveConfig, SESSION_INDEX_KEY, SESSION_KEY_PREFIX, SESSION_MIGRATION_KEY,
  loadSessionIndex, loadSession, loadSessions, saveSession, updateSessionMeta,
  deleteSession, deleteSessions, getSessionSize, withSessionStorage,
} from '../../src/shared/storage'
import type { SessionMigrationStatus } from '../../src/shared/storage'
import type { ChatSession } from '../../src/shared/types'

const LEGACY_KEY = 'sidekick_sessions'
const PENDING_KEY = 'sidekick_session_migration_pending'
const DELETES_KEY = 'sidekick_session_pending_deletes'
type StoredValues = Record<string, unknown>
type StorageKeys = string | string[] | StoredValues | null | undefined
type StorageEvent =
  | { operation: 'get'; keys: StorageKeys }
  | { operation: 'set'; values: StoredValues }
  | { operation: 'remove'; keys: string | string[] }
  | { operation: 'getBytesInUse'; keys: string | string[] | null | undefined }

function createMemoryStorage() {
  const data: StoredValues = {}
  const events: StorageEvent[] = []
  const pick = (keys: StorageKeys): StoredValues => {
    if (keys == null) return { ...data }
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
    const result: StoredValues = {}
    for (const key of names) {
      if (Object.hasOwn(data, key)) result[key] = data[key]
      else if (typeof keys === 'object' && !Array.isArray(keys)) result[key] = keys[key]
    }
    return result
  }
  const local = {
    get: vi.fn(async (keys?: StorageKeys) => {
      events.push({ operation: 'get', keys: structuredClone(keys) })
      return structuredClone(pick(keys))
    }),
    set: vi.fn(async (values: StoredValues) => {
      events.push({ operation: 'set', values: structuredClone(values) })
      Object.assign(data, structuredClone(values))
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      events.push({ operation: 'remove', keys: structuredClone(keys) })
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]
    }),
    clear: vi.fn(async () => {
      for (const key of Object.keys(data)) delete data[key]
    }),
    getBytesInUse: vi.fn(async (keys?: string | string[] | null) => {
      events.push({ operation: 'getBytesInUse', keys: structuredClone(keys) })
      return Object.entries(pick(keys)).reduce((size, [key, value]) => (
        size + new TextEncoder().encode(key + JSON.stringify(value)).byteLength
      ), 0)
    }),
  }
  return { data, events, local }
}

function createLocks() {
  const queues = new Map<string, Promise<void>>()
  return {
    request: vi.fn(<T>(name: string, callback: (lock: Lock) => T | PromiseLike<T>): Promise<T> => {
      const result = (queues.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }))
      // Reason: a rejected operation releases the shared lock without hiding its rejection from the caller.
      queues.set(name, result.then(() => {}, () => {}))
      return result
    }),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function bodyKey(id: string) {
  return `${SESSION_KEY_PREFIX}${id}`
}

function makeSession(id: string, patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id, title: `Synthetic ${id}`, createdAt: 10, updatedAt: 20,
    pageUrl: 'https://synthetic.example.test/article', mode: 'chat',
    messages: [
      { id: `${id}-user`, role: 'user', parts: [{ type: 'text', text: `Synthetic question ${id}` }] },
      {
        id: `${id}-assistant`, role: 'assistant',
        parts: [
          { type: 'text', text: 'Synthetic answer' },
          { type: 'tool-bash', toolCallId: 'synthetic-call', output: { nested: [1, { ok: true }] } },
        ],
      },
    ],
    ...patch,
  }
}

function metadata(session: ChatSession) {
  const { messages, ...rest } = session
  return { ...rest, messageCount: messages.length }
}

async function separateStorageInstances() {
  vi.resetModules()
  const first = await import('../../src/shared/storage')
  vi.resetModules()
  const second = await import('../../src/shared/storage')
  expect(first.withSessionStorage).not.toBe(second.withSessionStorage)
  return [first, second] as const
}

describe('Storage', () => {
  let memory: ReturnType<typeof createMemoryStorage>
  let locks: ReturnType<typeof createLocks>
  let originalLocal: PropertyDescriptor | undefined
  let originalLocks: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    memory = createMemoryStorage()
    locks = createLocks()
    originalLocal = Object.getOwnPropertyDescriptor(chrome.storage, 'local')
    originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(chrome.storage, 'local', { configurable: true, value: memory.local })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
  })

  afterEach(() => {
    if (originalLocal) Object.defineProperty(chrome.storage, 'local', originalLocal)
    else Reflect.deleteProperty(chrome.storage, 'local')
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  function seedSessions(...sessions: ChatSession[]) {
    memory.data[SESSION_INDEX_KEY] = structuredClone(sessions.map(metadata))
    for (const session of sessions) memory.data[bodyKey(session.id)] = structuredClone(session)
  }

  function migrationWrites(): SessionMigrationStatus[] {
    return memory.events.flatMap(event => event.operation === 'set' && Object.hasOwn(event.values, SESSION_MIGRATION_KEY)
      ? [event.values[SESSION_MIGRATION_KEY] as SessionMigrationStatus]
      : [])
  }

  it('loadConfig returns null when empty', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({})
    expect(await loadConfig()).toBeNull()
  })

  it('saveConfig writes to storage', async () => {
    const cfg = { endpoint: 'x' } as any
    await saveConfig(cfg)
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ sidekick_config: cfg })
  })

  it('loadConfig migrates legacy proMode to yoloMode', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ sidekick_config: { endpoint: 'x', proMode: true } })
    expect(await loadConfig()).toMatchObject({ endpoint: 'x', yoloMode: true })
  })

  it('saveConfig drops legacy proMode field', async () => {
    await saveConfig({ endpoint: 'x', yoloMode: false, proMode: true } as any)
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ sidekick_config: { endpoint: 'x', yoloMode: false } })
  })

  it('persists per-chat permission independently of the new-chat default', async () => {
    await saveSession(makeSession('permissions', { permissionMode: 'ask' }))
    await saveConfig({ defaultPermissionMode: 'allow', securityLevel: 'strict', yoloMode: false } as any)
    expect((await loadConfig())?.defaultPermissionMode).toBe('allow')
    expect((await loadSession('permissions'))?.permissionMode).toBe('ask')
    await updateSessionMeta('permissions', { permissionMode: 'auto' })
    expect((await loadSession('permissions'))?.permissionMode).toBe('auto')
    expect((await loadSessionIndex()).find(session => session.id === 'permissions')?.permissionMode).toBe('auto')
    expect((await loadConfig())?.defaultPermissionMode).toBe('allow')
  })

  describe('local test doubles', () => {
    it('filters get keys, supplies defaults, and supports all-key reads', async () => {
      await memory.local.set({ a: { nested: [1] }, b: false, untouched: 'value' })
      expect(await memory.local.get('a')).toEqual({ a: { nested: [1] } })
      expect(await memory.local.get(['b', 'absent'])).toEqual({ b: false })
      expect(await memory.local.get('absent')).toEqual({})
      expect(await memory.local.get({ b: true, absent: { fallback: 1 } }))
        .toEqual({ b: false, absent: { fallback: 1 } })
      expect(await memory.local.get(null)).toEqual(memory.data)
      expect(await memory.local.get()).toEqual(memory.data)
    })

    it('structured-clones writes, reads and recorded arguments, and removes only selected keys', async () => {
      const input = { a: { nested: ['original'] }, b: 2, c: 3 }
      await memory.local.set(input)
      input.a.nested.push('caller mutation')
      const keys = ['a']
      const loaded = await memory.local.get(keys)
      keys.push('b')
      ;(loaded.a as { nested: string[] }).nested.push('read mutation')
      const removed = ['b', 'missing']
      await memory.local.remove(removed)
      removed.push('a')
      await memory.local.remove('c')
      expect(memory.data).toEqual({ a: { nested: ['original'] } })
      expect(memory.events).toEqual([
        { operation: 'set', values: { a: { nested: ['original'] }, b: 2, c: 3 } },
        { operation: 'get', keys: ['a'] },
        { operation: 'remove', keys: ['b', 'missing'] },
        { operation: 'remove', keys: 'c' },
      ])
    })

    it('serializes the same lock name while allowing a different name to run', async () => {
      const entered = deferred()
      const release = deferred()
      const order: string[] = []
      const first = locks.request('same', async () => {
        order.push('first')
        entered.resolve()
        await release.promise
        order.push('released')
      })
      await entered.promise
      const second = locks.request('same', () => { order.push('second') })
      try {
        await locks.request('other', () => { order.push('other') })
        expect(order).toEqual(['first', 'other'])
      } finally {
        release.resolve()
        await Promise.all([first, second])
      }
      expect(order).toEqual(['first', 'other', 'released', 'second'])
    })
  })

  describe('migration', () => {
    it('preserves messages and unknown metadata, then publishes the index before removing legacy data', async () => {
      const sessions = [
        { ...makeSession('a'), futureMetadata: { tags: ['synthetic'], nested: { enabled: true } }, messageCount: 999 },
        makeSession('b', { mode: 'pro', interrupted: true }),
      ]
      memory.data[LEGACY_KEY] = structuredClone(sessions)
      memory.data.sidekick_config = { endpoint: 'synthetic' }

      expect(await loadSessions()).toEqual(sessions)
      expect(memory.data).toEqual({
        sidekick_config: { endpoint: 'synthetic' },
        [bodyKey('a')]: sessions[0], [bodyKey('b')]: sessions[1],
        [SESSION_INDEX_KEY]: sessions.map(metadata),
        [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 2, total: 2 },
      })
      expect(memory.events).toEqual([
        { operation: 'get', keys: [SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY] },
        { operation: 'get', keys: LEGACY_KEY },
        { operation: 'set', values: { [SESSION_MIGRATION_KEY]: { status: 'running', completed: 0, total: 2 } } },
        { operation: 'set', values: {
          [bodyKey('a')]: sessions[0], [SESSION_MIGRATION_KEY]: { status: 'running', completed: 1, total: 2 },
        } },
        { operation: 'set', values: {
          [bodyKey('b')]: sessions[1], [SESSION_MIGRATION_KEY]: { status: 'running', completed: 2, total: 2 },
        } },
        { operation: 'set', values: { [SESSION_INDEX_KEY]: sessions.map(metadata), [PENDING_KEY]: true } },
        { operation: 'remove', keys: [LEGACY_KEY, PENDING_KEY] },
        { operation: 'set', values: { [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 2, total: 2 } } },
        { operation: 'get', keys: [bodyKey('a'), bodyKey('b')] },
      ])
      expect(memory.local.get.mock.calls.every(([keys]) => keys != null)).toBe(true)
    })

    it('awaits the last body write before publishing or cleaning up', async () => {
      const sessions = [makeSession('a'), makeSession('b')]
      memory.data[LEGACY_KEY] = structuredClone(sessions)
      const persist = memory.local.set.getMockImplementation()!
      const entered = deferred()
      const release = deferred()
      memory.local.set.mockImplementation(async values => {
        if (Object.hasOwn(values, bodyKey('b'))) {
          entered.resolve()
          await release.promise
        }
        await persist(values)
      })
      const migration = loadSessionIndex()
      await entered.promise
      try {
        expect(memory.data[bodyKey('a')]).toEqual(sessions[0])
        expect(memory.data).not.toHaveProperty(SESSION_INDEX_KEY)
        expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'running', completed: 1, total: 2 })
        expect(memory.local.set).toHaveBeenCalledTimes(3)
        expect(memory.local.remove).not.toHaveBeenCalled()
        expect(memory.data[LEGACY_KEY]).toEqual(sessions)
      } finally {
        release.resolve()
        await migration
      }
      expect(memory.data[SESSION_INDEX_KEY]).toEqual(sessions.map(metadata))
      expect(memory.data).not.toHaveProperty(LEGACY_KEY)
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'complete', completed: 2, total: 2 })
    })

    it.each(['body', 'index'] as const)('retains legacy data after a %s write failure and retries successfully', async stage => {
      const sessions = [makeSession('a'), makeSession('b')]
      memory.data[LEGACY_KEY] = structuredClone(sessions)
      const error = new Error(`synthetic ${stage} write failure`)
      const persist = memory.local.set.getMockImplementation()!
      const failingKey = stage === 'body' ? bodyKey('b') : SESSION_INDEX_KEY
      let failed = false
      memory.local.set.mockImplementation(async values => {
        if (!failed && Object.hasOwn(values, failingKey)) {
          failed = true
          throw error
        }
        await persist(values)
      })

      await expect(loadSessionIndex()).rejects.toBe(error)
      expect(memory.data[LEGACY_KEY]).toEqual(sessions)
      expect(memory.data[bodyKey('a')]).toEqual(sessions[0])
      expect(memory.data).not.toHaveProperty(SESSION_INDEX_KEY)
      expect(memory.data).not.toHaveProperty(PENDING_KEY)
      expect(memory.local.remove).not.toHaveBeenCalled()
      const completed = stage === 'body' ? 1 : 2
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'error', completed, total: 2, error: expect.any(String) })
      expect(migrationWrites().map(value => [value.status, value.completed])).toEqual([
        ['running', 0], ['running', 1], ...(stage === 'index' ? [['running', 2]] : []), ['error', completed],
      ])

      const [restarted] = await separateStorageInstances()
      expect(await restarted.loadSessions()).toEqual(sessions)
      expect(memory.data[SESSION_INDEX_KEY]).toEqual(sessions.map(metadata))
      expect(memory.data).not.toHaveProperty(LEGACY_KEY)
      expect(memory.data).not.toHaveProperty(PENDING_KEY)
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'complete', completed: 2, total: 2 })
      expect(migrationWrites().slice(-4)).toEqual([
        { status: 'running', completed: 0, total: 2 },
        { status: 'running', completed: 1, total: 2 },
        { status: 'running', completed: 2, total: 2 },
        { status: 'complete', completed: 2, total: 2 },
      ])
      expect(memory.local.get.mock.calls.filter(([keys]) => keys === LEGACY_KEY)).toHaveLength(2)
    })

    it('retries failed cleanup without overwriting already migrated bodies or rereading legacy data', async () => {
      const original = makeSession('a')
      memory.data[LEGACY_KEY] = [structuredClone(original)]
      const error = new Error('synthetic cleanup failure')
      memory.local.remove.mockRejectedValueOnce(error)

      await expect(loadSessionIndex()).rejects.toBe(error)
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(original)])
      expect(memory.data[PENDING_KEY]).toBe(true)
      expect(memory.data[LEGACY_KEY]).toEqual([original])
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'error', completed: 1, total: 1, error: expect.any(String) })
      expect(migrationWrites().some(value => value.status === 'complete')).toBe(false)
      const migrated = { ...original, messages: [{ role: 'assistant', content: 'new durable content' }] }
      memory.data[bodyKey('a')] = structuredClone(migrated)
      memory.data[SESSION_INDEX_KEY] = [metadata(migrated)]
      memory.local.get.mockClear()
      memory.local.set.mockClear()

      const [restarted] = await separateStorageInstances()
      expect(await restarted.loadSession('a')).toEqual(migrated)
      expect(memory.local.get.mock.calls).toEqual([
        [[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]], [bodyKey('a')],
      ])
      expect(memory.local.set.mock.calls).toEqual([[{ [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 1, total: 1 } }]])
      expect(memory.local.remove).toHaveBeenCalledTimes(2)
      expect(memory.data).not.toHaveProperty(LEGACY_KEY)
      expect(memory.data).not.toHaveProperty(PENDING_KEY)
    })

    it('treats an existing empty index as authoritative instead of reviving stale legacy sessions', async () => {
      seedSessions()
      memory.data[LEGACY_KEY] = [makeSession('stale')]
      expect(await loadSessions()).toEqual([])
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.local.set).not.toHaveBeenCalled()
      expect(memory.local.remove).not.toHaveBeenCalled()
    })

    it('initializes an empty database once without reading bodies or removing unrelated keys', async () => {
      memory.data.unrelated = { keep: true }
      expect(await loadSessionIndex()).toEqual([])
      expect(await loadSession('absent')).toBeNull()
      expect(await loadSessions()).toEqual([])
      expect(memory.local.set.mock.calls).toEqual([[{ [SESSION_INDEX_KEY]: [] }]])
      expect(memory.local.get.mock.calls).toEqual([
        [[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]], [LEGACY_KEY],
        [[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]], [[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]],
      ])
      expect(memory.local.remove).not.toHaveBeenCalled()
      expect(memory.data).toEqual({ unrelated: { keep: true }, [SESSION_INDEX_KEY]: [] })
    })

    it('cleans up an explicitly empty legacy array after publishing an empty index', async () => {
      memory.data[LEGACY_KEY] = []
      expect(await loadSessions()).toEqual([])
      expect(memory.local.set.mock.calls).toEqual([
        [{ [SESSION_MIGRATION_KEY]: { status: 'running', completed: 0, total: 0 } }],
        [{ [SESSION_INDEX_KEY]: [], [PENDING_KEY]: true }],
        [{ [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 0, total: 0 } }],
      ])
      expect(memory.local.remove).toHaveBeenCalledWith([LEGACY_KEY, PENDING_KEY])
      expect(memory.data).toEqual({
        [SESSION_INDEX_KEY]: [], [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 0, total: 0 },
      })
    })

    it.each(['index', 'cleanup'] as const)('does not complete or invoke the callback before %s finishes', async stage => {
      memory.data[LEGACY_KEY] = [makeSession('a')]
      const entered = deferred()
      const release = deferred()
      if (stage === 'index') {
        const persist = memory.local.set.getMockImplementation()!
        memory.local.set.mockImplementation(async values => {
          if (Object.hasOwn(values, SESSION_INDEX_KEY)) {
            entered.resolve()
            await release.promise
          }
          await persist(values)
        })
      } else {
        const remove = memory.local.remove.getMockImplementation()!
        memory.local.remove.mockImplementation(async keys => {
          entered.resolve()
          await release.promise
          await remove(keys)
        })
      }
      const operation = vi.fn(async () => 'ready')
      const migration = withSessionStorage(operation)
      await entered.promise
      try {
        expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'running', completed: 1, total: 1 })
        expect(memory.data[LEGACY_KEY]).toEqual([makeSession('a')])
        expect(operation).not.toHaveBeenCalled()
        expect(migrationWrites().some(value => value.status === 'complete')).toBe(false)
      } finally {
        release.resolve()
        await migration
      }
      expect(operation).toHaveBeenCalledOnce()
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'complete', completed: 1, total: 1 })
    })

    it('records zero progress if the initial running write fails and preserves the original error', async () => {
      memory.data[LEGACY_KEY] = [makeSession('a')]
      const error = new Error('synthetic status write failure')
      memory.local.set.mockRejectedValueOnce(error)
      await expect(loadSessionIndex()).rejects.toBe(error)
      expect(memory.data).not.toHaveProperty(bodyKey('a'))
      expect(memory.data).not.toHaveProperty(SESSION_INDEX_KEY)
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'error', completed: 0, total: 1, error: expect.any(String) })
      expect(memory.local.remove).not.toHaveBeenCalled()
      expect(migrationWrites().map(value => value.status)).toEqual(['error'])
      await loadSessionIndex()
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'complete', completed: 1, total: 1 })
    })

    it('does not persist session contents from an error diagnostic', async () => {
      const sessions = [makeSession('private-session')]
      memory.data[LEGACY_KEY] = sessions
      const error = new Error(`Failed to store ${JSON.stringify(sessions)}`)
      const persist = memory.local.set.getMockImplementation()!
      memory.local.set.mockImplementation(async values => {
        if (Object.hasOwn(values, bodyKey('private-session'))) throw error
        await persist(values)
      })
      await expect(loadSessionIndex()).rejects.toBe(error)
      const status = memory.data[SESSION_MIGRATION_KEY] as SessionMigrationStatus
      expect(status).toEqual({ status: 'error', completed: 0, total: 1, error: expect.any(String) })
      expect(status.error).toBeTruthy()
      expect(JSON.stringify(status)).not.toContain('private-session')
      expect(JSON.stringify(status)).not.toContain('Synthetic')
    })

    it.each(['reject', 'throw'] as const)('rethrows the migration error when saving the error status also fails by %s', async failure => {
      const sessions = [makeSession('a'), makeSession('b')]
      memory.data[LEGACY_KEY] = sessions
      const error = new Error('original body failure')
      const persist = memory.local.set.getMockImplementation()!
      memory.local.set.mockImplementation(values => {
        if (Object.hasOwn(values, bodyKey('b'))) return Promise.reject(error)
        if ((values[SESSION_MIGRATION_KEY] as SessionMigrationStatus)?.status === 'error') {
          if (failure === 'throw') throw new Error('status unavailable')
          return Promise.reject(new Error('status unavailable'))
        }
        return persist(values)
      })
      await expect(loadSessionIndex()).rejects.toBe(error)
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'running', completed: 1, total: 2 })
      expect(memory.data[LEGACY_KEY]).toEqual(sessions)
      expect(memory.data).not.toHaveProperty(SESSION_INDEX_KEY)
      memory.local.set.mockImplementation(persist)
      const [restarted] = await separateStorageInstances()
      expect(await restarted.loadSessions()).toEqual(sessions)
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'complete', completed: 2, total: 2 })
    })

    it('resumes legacy cleanup from the earlier migration implementation without copying bodies', async () => {
      const session = makeSession('a')
      seedSessions(session)
      memory.data[LEGACY_KEY] = [makeSession('stale')]
      memory.data[PENDING_KEY] = true
      await loadSessionIndex()
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.local.set.mock.calls).toEqual([[{ [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 1, total: 1 } }]])
      expect(memory.data[bodyKey('a')]).toEqual(session)
      expect(memory.data).not.toHaveProperty(LEGACY_KEY)
      expect(memory.data).not.toHaveProperty(PENDING_KEY)
    })

    it.each(['running', 'error'] as const)('finalizes a persisted %s state from the ready index without a pending marker', async status => {
      seedSessions(makeSession('a'), makeSession('b'))
      memory.data[SESSION_MIGRATION_KEY] = { status, completed: 1, total: 2, ...(status === 'error' ? { error: 'old error' } : {}) }
      const [restarted] = await separateStorageInstances()
      await restarted.loadSessionIndex()
      await restarted.loadSessionIndex()
      expect(memory.local.get.mock.calls).toEqual([
        [[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]],
        [[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]],
      ])
      expect(memory.local.set.mock.calls).toEqual([[{ [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 2, total: 2 } }]])
      expect(memory.local.remove).not.toHaveBeenCalled()
    })

    it.each([false, true])('recovers after the final complete write fails (error status also fails: %s)', async failErrorStatus => {
      const session = makeSession('a')
      memory.data[LEGACY_KEY] = [session]
      const error = new Error('final status failed')
      const persist = memory.local.set.getMockImplementation()!
      memory.local.set.mockImplementation(async values => {
        const status = (values[SESSION_MIGRATION_KEY] as SessionMigrationStatus)?.status
        if (status === 'complete') throw error
        if (status === 'error' && failErrorStatus) throw new Error('error status failed')
        await persist(values)
      })
      const operation = vi.fn(async () => 'not run')
      await expect(withSessionStorage(operation)).rejects.toBe(error)
      expect(operation).not.toHaveBeenCalled()
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(session)])
      expect(memory.data).not.toHaveProperty(LEGACY_KEY)
      expect(memory.data).not.toHaveProperty(PENDING_KEY)
      expect(memory.data[SESSION_MIGRATION_KEY]).toMatchObject({ status: failErrorStatus ? 'running' : 'error', completed: 1, total: 1 })
      expect(migrationWrites().some(value => value.status === 'complete')).toBe(false)
      memory.local.set.mockImplementation(persist).mockClear()
      memory.local.get.mockClear()
      memory.local.remove.mockClear()
      const [restarted] = await separateStorageInstances()
      await restarted.loadSessionIndex()
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.local.set.mock.calls).toEqual([[{ [SESSION_MIGRATION_KEY]: { status: 'complete', completed: 1, total: 1 } }]])
      expect(memory.local.remove).not.toHaveBeenCalled()
    })

    it('retains the completion result during normal operations and never recreates it after UI acknowledgement', async () => {
      const session = makeSession('a')
      memory.data[LEGACY_KEY] = [session]
      await loadSessionIndex()
      const completion = { status: 'complete', completed: 1, total: 1 }
      for (const acknowledged of [false, true]) {
        if (acknowledged) await memory.local.remove(SESSION_MIGRATION_KEY)
        memory.events.length = 0
        await loadSessionIndex()
        await loadSession('a')
        await loadSessions()
        await saveSession(session)
        await updateSessionMeta('a', { title: 'Renamed' })
        await getSessionSize('a')
        await deleteSession('a')
        expect(migrationWrites()).toEqual([])
        expect(memory.data[SESSION_MIGRATION_KEY]).toEqual(acknowledged ? undefined : completion)
      }
    })

    it('does not mark a callback failure after successful migration as a migration failure', async () => {
      memory.data[LEGACY_KEY] = [makeSession('a')]
      const error = new Error('callback failed')
      await expect(withSessionStorage(async () => { throw error })).rejects.toBe(error)
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual({ status: 'complete', completed: 1, total: 1 })
      expect(migrationWrites().some(value => value.status === 'error')).toBe(false)
    })

    it('leaves a new database without migration status when index initialization fails', async () => {
      const error = new Error('index initialization failed')
      memory.local.set.mockRejectedValueOnce(error)
      await expect(loadSessionIndex()).rejects.toBe(error)
      expect(memory.local.set.mock.calls).toEqual([[{ [SESSION_INDEX_KEY]: [] }]])
      expect(memory.data).not.toHaveProperty(SESSION_MIGRATION_KEY)
    })
  })

  describe('reads and writes', () => {
    it('adds a new session by reading only the index and writing only its body plus the index', async () => {
      const existing = makeSession('existing')
      const added = { ...makeSession('added'), futureMetadata: { source: 'synthetic' } }
      seedSessions(existing)
      memory.data[LEGACY_KEY] = [makeSession('stale')]
      await saveSession(added)
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.local.set.mock.calls).toEqual([[{
        [bodyKey('added')]: added, [SESSION_INDEX_KEY]: [metadata(existing), metadata(added)],
      }]])
      expect(memory.data[bodyKey('existing')]).toEqual(existing)
      expect(memory.local.remove).not.toHaveBeenCalled()
    })

    it('updates an existing session in place without reading any session bodies', async () => {
      const a = makeSession('a')
      const b = makeSession('b')
      const updated = { ...a, title: 'Renamed', updatedAt: 30 }
      seedSessions(a, b)
      await saveSession(updated)
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.local.set.mock.calls).toEqual([[{
        [bodyKey('a')]: updated, [SESSION_INDEX_KEY]: [metadata(updated), metadata(b)],
      }]])
      expect(memory.data[bodyKey('b')]).toEqual(b)
    })

    it('does not rewrite the index when only message contents change with identical metadata', async () => {
      const original = makeSession('a')
      seedSessions(original, makeSession('b'))
      const next = { ...original, messages: original.messages.map((message, i) => ({ message, syntheticRevision: i })) }
      await saveSession(next)
      expect(memory.local.set.mock.calls).toEqual([[{ [bodyKey('a')]: next }]])
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(original), metadata(makeSession('b'))])
    })

    it('updates the index when the message count changes even if other metadata is identical', async () => {
      const original = makeSession('a')
      seedSessions(original)
      const next = { ...original, messages: [...original.messages, { role: 'user', content: 'next synthetic turn' }] }
      await saveSession(next)
      expect(memory.local.set.mock.calls).toEqual([[{
        [bodyKey('a')]: next, [SESSION_INDEX_KEY]: [metadata(next)],
      }]])
    })

    it('loadSession reads exactly one body and returns a detached complete session', async () => {
      const a = { ...makeSession('a'), futureMetadata: { keep: ['value'] } }
      seedSessions(a, makeSession('b'))
      const loaded = await loadSession('a')
      expect(loaded).toEqual(a)
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]], [bodyKey('a')]])
      loaded!.messages.push('caller mutation')
      expect(memory.data[bodyKey('a')]).toEqual(a)
      expect(memory.local.set).not.toHaveBeenCalled()
    })

    it('loadSession returns null for an unindexed id without reading or reviving its orphan body', async () => {
      seedSessions(makeSession('a'))
      memory.data[bodyKey('orphan')] = makeSession('orphan')
      expect(await loadSession('orphan')).toBeNull()
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.local.set).not.toHaveBeenCalled()
    })

    it('loadSession returns null when an indexed body is missing', async () => {
      seedSessions(makeSession('a'))
      delete memory.data[bodyKey('a')]
      expect(await loadSession('a')).toBeNull()
      expect(memory.local.set).not.toHaveBeenCalled()
    })

    it('loadSessions fetches all indexed bodies once in index order, excluding unrelated and orphan data', async () => {
      const a = makeSession('a')
      const b = makeSession('b')
      seedSessions(b, a)
      memory.data[bodyKey('orphan')] = makeSession('orphan')
      memory.data[LEGACY_KEY] = [makeSession('stale')]
      memory.data.sidekick_config = { endpoint: 'synthetic' }
      expect(await loadSessions()).toEqual([b, a])
      expect(memory.local.get.mock.calls).toEqual([
        [[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]], [[bodyKey('b'), bodyKey('a')]],
      ])
      expect(memory.local.set).not.toHaveBeenCalled()
    })

    it('loadSessionIndex returns metadata and counts with empty messages without loading bodies', async () => {
      const a = { ...makeSession('a'), futureMetadata: { nested: ['preserved'] } }
      const b = makeSession('b', { messages: [] })
      seedSessions(a, b)
      const index = await loadSessionIndex()
      expect(index).toEqual([a, b].map(session => ({ ...metadata(session), messages: [] })))
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      index[0].title = 'caller mutation'
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(a), metadata(b)])
      expect(memory.local.set).not.toHaveBeenCalled()
    })

    it('updateSessionMeta preserves complete messages and unknown metadata while renaming', async () => {
      const original = { ...makeSession('a'), interrupted: true, futureMetadata: { nested: ['keep'] } }
      const other = makeSession('b')
      seedSessions(original, other)
      await updateSessionMeta('a', { title: 'New title', updatedAt: 99 })
      const expected = { ...original, title: 'New title', updatedAt: 99 }
      expect(memory.data[bodyKey('a')]).toEqual(expected)
      expect(memory.data[bodyKey('b')]).toEqual(other)
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]], [bodyKey('a')]])
      expect(memory.local.set.mock.calls).toEqual([[{
        [bodyKey('a')]: expected, [SESSION_INDEX_KEY]: [metadata(expected), metadata(other)],
      }]])
    })

    it('updateSessionMeta does not clear unspecified fields in a title-only patch', async () => {
      const original = makeSession('a')
      seedSessions(original)
      await updateSessionMeta('a', { title: 'Title only' })
      // Reason: delta sync reads the index timestamp — metadata edits must
      // advance it or offline devices never receive the rename.
      expect(memory.data[bodyKey('a')]).toEqual({ ...original, title: 'Title only', updatedAt: expect.any(Number) })
      expect((memory.data[bodyKey('a')] as ChatSession).updatedAt).toBeGreaterThan(original.updatedAt)
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata({ ...original, title: 'Title only', updatedAt: expect.any(Number) })])
    })

    it.each(['unindexed', 'missing body'] as const)('updateSessionMeta does not revive a session that is %s', async scenario => {
      const original = makeSession('a')
      seedSessions(original)
      if (scenario === 'unindexed') memory.data[SESSION_INDEX_KEY] = []
      else delete memory.data[bodyKey('a')]
      const before = structuredClone(memory.data)
      await updateSessionMeta('a', { title: 'Do not resurrect', updatedAt: 99 })
      expect(memory.data).toEqual(before)
      expect(memory.local.set).not.toHaveBeenCalled()
      expect(memory.local.remove).not.toHaveBeenCalled()
      expect(memory.local.get).toHaveBeenCalledTimes(scenario === 'unindexed' ? 1 : 2)
    })
  })

  describe('deletion and size', () => {
    it('deleteSession removes the selected index entry and body only', async () => {
      const a = makeSession('a')
      const b = makeSession('b')
      seedSessions(a, b)
      await deleteSession('a')
      expect(memory.data).toEqual({ [SESSION_INDEX_KEY]: [metadata(b)], [bodyKey('b')]: b })
      expect(memory.local.set.mock.calls).toEqual([[{ [SESSION_INDEX_KEY]: [metadata(b)], [DELETES_KEY]: ['a'] }]])
      expect(memory.local.remove.mock.calls).toEqual([[[bodyKey('a'), 'sidekick_canvas:a', DELETES_KEY]]])
    })

    it('deleteSessions removes a batch with one index write and removes every requested body', async () => {
      const a = makeSession('a')
      const b = makeSession('b')
      const c = makeSession('c')
      seedSessions(a, b, c)
      memory.data[bodyKey('orphan')] = makeSession('orphan')
      memory.data.unrelated = 'keep'
      await deleteSessions(['a', 'c', 'orphan', 'absent'])
      expect(memory.data).toEqual({
        [SESSION_INDEX_KEY]: [metadata(b)], [bodyKey('b')]: b, unrelated: 'keep',
      })
      expect(memory.events).toEqual([
        { operation: 'get', keys: [SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY] },
        { operation: 'set', values: { [SESSION_INDEX_KEY]: [metadata(b)], [DELETES_KEY]: ['a', 'c', 'orphan', 'absent'] } },
        { operation: 'remove', keys: [bodyKey('a'), bodyKey('c'), bodyKey('orphan'), bodyKey('absent'), 'sidekick_canvas:a', 'sidekick_canvas:c', 'sidekick_canvas:orphan', 'sidekick_canvas:absent', DELETES_KEY] },
      ])
      expect(memory.local.set).toHaveBeenCalledTimes(1)
      expect(memory.local.remove).toHaveBeenCalledTimes(1)
    })

    it('deleteSessions with empty ids never touches storage or acquires a lock', async () => {
      await deleteSessions([])
      expect(memory.events).toEqual([])
      expect(memory.local.get).not.toHaveBeenCalled()
      expect(memory.local.set).not.toHaveBeenCalled()
      expect(memory.local.remove).not.toHaveBeenCalled()
      expect(locks.request).not.toHaveBeenCalled()
    })

    it('getSessionSize returns getBytesInUse for the exact body key without reading the body', async () => {
      seedSessions(makeSession('a'), makeSession('b'))
      memory.local.getBytesInUse.mockResolvedValueOnce(12345)
      expect(await getSessionSize('a')).toBe(12345)
      expect(memory.local.getBytesInUse.mock.calls).toEqual([[bodyKey('a')]])
      expect(memory.local.get.mock.calls).toEqual([[[SESSION_INDEX_KEY, PENDING_KEY, DELETES_KEY, SESSION_MIGRATION_KEY]]])
      expect(memory.local.set).not.toHaveBeenCalled()
    })

    it('getSessionSize returns zero for an absent body', async () => {
      seedSessions()
      expect(await getSessionSize('absent')).toBe(0)
      expect(memory.local.getBytesInUse).toHaveBeenCalledWith(bodyKey('absent'))
    })
  })

  describe('shared locking', () => {
    it('withSessionStorage holds one named lock across independent module instances until the callback finishes', async () => {
      seedSessions()
      const [first, second] = await separateStorageInstances()
      const entered = deferred()
      const release = deferred()
      const added = makeSession('a')
      const observe = vi.fn(async (index: unknown[]) => index.length)
      const write = first.withSessionStorage(async index => {
        entered.resolve()
        await release.promise
        await chrome.storage.local.set({
          [bodyKey('a')]: added, [SESSION_INDEX_KEY]: [...index, metadata(added)],
        })
        return 'committed'
      })
      await entered.promise
      const read = second.withSessionStorage(observe)
      let results: unknown[]
      try {
        await locks.request('independent-probe', () => {})
        expect(observe).not.toHaveBeenCalled()
        expect(memory.local.get).toHaveBeenCalledTimes(1)
        expect(locks.request.mock.calls.slice(0, 2).map(([name]) => name))
          .toEqual(['sidekick-session-storage', 'sidekick-session-storage'])
      } finally {
        release.resolve()
        results = await Promise.all([write, read])
      }
      expect(results).toEqual(['committed', 1])
      expect(observe).toHaveBeenCalledWith([metadata(added)])
    })

    it('preserves concurrent saves of different sessions across module instances', async () => {
      const a = makeSession('a')
      const b = makeSession('b')
      seedSessions()
      const [first, second] = await separateStorageInstances()
      await Promise.all([first.saveSession(a), second.saveSession(b)])
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(a), metadata(b)])
      expect(await loadSessions()).toEqual([a, b])
    })

    it.each([
      ['save', 'delete', 'rename'],
      ['delete', 'rename', 'save'],
      ['rename', 'save', 'delete'],
    ] as const)('does not lose index entries with concurrent %s / %s / %s', async (...order) => {
      const a = makeSession('a')
      const b = makeSession('b')
      const keep = makeSession('keep')
      const added = makeSession('added')
      seedSessions(a, b, keep)
      const [first, second] = await separateStorageInstances()
      const operations = {
        save: () => first.saveSession(added),
        delete: () => second.deleteSessions(['b']),
        rename: () => second.updateSessionMeta('a', { title: 'Concurrent rename', updatedAt: 100 }),
      }
      await Promise.all(order.map(name => operations[name]()))
      const renamed = { ...a, title: 'Concurrent rename', updatedAt: 100 }
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(renamed), metadata(keep), metadata(added)])
      expect(memory.data[bodyKey('a')]).toEqual(renamed)
      expect(memory.data[bodyKey('keep')]).toEqual(keep)
      expect(memory.data[bodyKey('added')]).toEqual(added)
      expect(memory.data).not.toHaveProperty(bodyKey('b'))
    })

    it('does not resurrect a session when a concurrent rename is queued behind deletion', async () => {
      seedSessions(makeSession('a'))
      const [first, second] = await separateStorageInstances()
      await Promise.all([
        first.deleteSessions(['a']),
        second.updateSessionMeta('a', { title: 'Too late' }),
      ])
      expect(memory.data).toEqual({ [SESSION_INDEX_KEY]: [] })
      expect(memory.local.set).toHaveBeenCalledTimes(1)
    })

    it('migrates only once while another module saves a new session', async () => {
      const legacy = makeSession('legacy')
      const added = makeSession('added')
      memory.data[LEGACY_KEY] = [structuredClone(legacy)]
      const [first, second] = await separateStorageInstances()
      await Promise.all([first.loadSessionIndex(), second.saveSession(added)])
      expect(await loadSessions()).toEqual([legacy, added])
      expect(memory.local.get.mock.calls.filter(([keys]) => keys === LEGACY_KEY)).toHaveLength(1)
      expect(memory.local.set.mock.calls.filter(([values]) => Object.hasOwn(values, bodyKey('legacy')))).toHaveLength(1)
      expect(memory.local.remove).toHaveBeenCalledTimes(1)
    })

    it('propagates a callback error and releases the lock for the next module', async () => {
      seedSessions()
      const [first, second] = await separateStorageInstances()
      const error = new Error('synthetic callback failure')
      const failed = first.withSessionStorage(async () => { throw error })
      const next = second.saveSession(makeSession('a'))
      await expect(failed).rejects.toBe(error)
      await expect(next).resolves.toBeUndefined()
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(makeSession('a'))])
    })
  })

  describe('error propagation', () => {
    it('rejects when the index read fails without invoking the operation or writing anything', async () => {
      seedSessions()
      const error = new Error('synthetic index read failure')
      memory.local.get.mockRejectedValueOnce(error)
      const operation = vi.fn(async () => 'not run')
      await expect(withSessionStorage(operation)).rejects.toBe(error)
      expect(operation).not.toHaveBeenCalled()
      expect(memory.local.set).not.toHaveBeenCalled()
      expect(memory.local.remove).not.toHaveBeenCalled()
    })

    it('rejects a legacy read failure without publishing an empty index', async () => {
      memory.data[LEGACY_KEY] = [makeSession('a')]
      const error = new Error('synthetic legacy read failure')
      memory.local.get.mockResolvedValueOnce({}).mockRejectedValueOnce(error)
      await expect(loadSessionIndex()).rejects.toBe(error)
      expect(memory.data[LEGACY_KEY]).toEqual([makeSession('a')])
      expect(memory.local.set).not.toHaveBeenCalled()
      expect(memory.local.remove).not.toHaveBeenCalled()
    })

    it.each(['loadSession', 'loadSessions', 'updateSessionMeta'] as const)('%s rejects body read errors', async operation => {
      seedSessions(makeSession('a'))
      const error = new Error('synthetic body read failure')
      memory.local.get.mockImplementationOnce(memory.local.get.getMockImplementation()!).mockRejectedValueOnce(error)
      const operations = {
        loadSession: () => loadSession('a'),
        loadSessions: () => loadSessions(),
        updateSessionMeta: () => updateSessionMeta('a', { title: 'Rename' }),
      }
      await expect(operations[operation]()).rejects.toBe(error)
      expect(memory.local.set).not.toHaveBeenCalled()
      expect(memory.local.remove).not.toHaveBeenCalled()
    })

    it.each(['saveSession', 'updateSessionMeta'] as const)('%s rejects write errors and a subsequent save can succeed', async operation => {
      const original = makeSession('a')
      seedSessions(original)
      const before = structuredClone(memory.data)
      const error = new Error('synthetic write failure')
      memory.local.set.mockRejectedValueOnce(error)
      const failed = operation === 'saveSession'
        ? saveSession({ ...original, title: 'Changed' })
        : updateSessionMeta('a', { title: 'Changed' })
      await expect(failed).rejects.toBe(error)
      expect(memory.data).toEqual(before)
      await saveSession({ ...original, title: 'Retry' })
      expect(memory.data[bodyKey('a')]).toEqual({ ...original, title: 'Retry' })
    })

    it.each(['save', 'pending deletion'] as const)('does not alter retained migration completion after a normal %s failure', async operation => {
      const session = makeSession('a')
      seedSessions(session)
      const completion = { status: 'complete', completed: 1, total: 1 }
      memory.data[SESSION_MIGRATION_KEY] = completion
      const error = new Error('normal storage operation failed')
      if (operation === 'save') memory.local.set.mockRejectedValueOnce(error)
      else {
        memory.data[DELETES_KEY] = ['orphan']
        memory.local.remove.mockRejectedValueOnce(error)
      }
      await expect(saveSession({ ...session, title: 'Changed' })).rejects.toBe(error)
      expect(memory.data[SESSION_MIGRATION_KEY]).toEqual(completion)
      expect(migrationWrites()).toEqual([])
      expect(memory.local.set.mock.calls.some(([values]) => Object.hasOwn(values, SESSION_MIGRATION_KEY))).toBe(false)
    })

    it('deleteSessions rejects index write errors without removing bodies', async () => {
      seedSessions(makeSession('a'))
      const before = structuredClone(memory.data)
      const error = new Error('synthetic delete index failure')
      memory.local.set.mockRejectedValueOnce(error)
      await expect(deleteSessions(['a'])).rejects.toBe(error)
      expect(memory.local.remove).not.toHaveBeenCalled()
      expect(memory.data).toEqual(before)
    })

    it('deleteSessions rejects body removal errors and a retry can finish cleanup', async () => {
      seedSessions(makeSession('a'), makeSession('b'))
      const error = new Error('synthetic body removal failure')
      memory.local.remove.mockRejectedValueOnce(error)
      await expect(deleteSessions(['a'])).rejects.toBe(error)
      expect(memory.data[SESSION_INDEX_KEY]).toEqual([metadata(makeSession('b'))])
      expect(memory.data[bodyKey('a')]).toEqual(makeSession('a'))
      await deleteSessions(['a'])
      expect(memory.data).not.toHaveProperty(bodyKey('a'))
      expect(await loadSessions()).toEqual([makeSession('b')])
    })

    it('finishes failed body deletion on a fresh module load without needing the deleted id', async () => {
      seedSessions(makeSession('a'), makeSession('b'))
      memory.local.remove.mockRejectedValueOnce(new Error('remove failed'))
      await expect(deleteSessions(['a'])).rejects.toThrow('remove failed')
      expect(memory.data[DELETES_KEY]).toEqual(['a'])
      const [restarted] = await separateStorageInstances()
      expect(await restarted.loadSessionIndex()).toEqual([{ ...metadata(makeSession('b')), messages: [] }])
      expect(memory.data).not.toHaveProperty(bodyKey('a'))
      expect(memory.data).not.toHaveProperty(DELETES_KEY)
      expect(memory.data[bodyKey('b')]).toEqual(makeSession('b'))
    })

    it('retains the cleanup record if recovery fails again and allows a later retry', async () => {
      seedSessions(makeSession('a'))
      memory.local.remove.mockRejectedValueOnce(new Error('remove failed'))
      await expect(deleteSession('a')).rejects.toThrow('remove failed')
      memory.local.remove.mockRejectedValueOnce(new Error('still unavailable'))
      await expect(loadSessionIndex()).rejects.toThrow('still unavailable')
      expect(memory.data[DELETES_KEY]).toEqual(['a'])
      expect(memory.data[bodyKey('a')]).toEqual(makeSession('a'))
      expect(await loadSessionIndex()).toEqual([])
      expect(memory.data).toEqual({ [SESSION_INDEX_KEY]: [] })
    })

    it('getSessionSize rejects getBytesInUse errors', async () => {
      seedSessions(makeSession('a'))
      const error = new Error('synthetic size failure')
      memory.local.getBytesInUse.mockRejectedValueOnce(error)
      await expect(getSessionSize('a')).rejects.toBe(error)
    })

    it('rejects lock acquisition errors without accessing storage', async () => {
      const error = new Error('synthetic lock failure')
      locks.request.mockRejectedValueOnce(error)
      await expect(loadSessionIndex()).rejects.toBe(error)
      expect(memory.events).toEqual([])
    })
  })
})
