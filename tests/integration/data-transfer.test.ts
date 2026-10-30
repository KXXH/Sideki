import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportAllData, importAllData } from '../../src/shared/data-transfer'
import type { BackupPayload } from '../../src/shared/data-transfer'
import { SESSION_INDEX_KEY, SESSION_KEY_PREFIX, SESSION_MIGRATION_KEY, loadSessions, saveSession, sessionIndexEntry, sessionStorageKey, withSessionStorage } from '../../src/shared/storage'
import type { ChatSession } from '../../src/shared/types'

const idb = new Map<string | number, unknown>()
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => structuredClone(idb.get(key))),
  keys: vi.fn(async () => [...idb.keys()]),
  set: vi.fn(async (key: string, value: unknown) => { idb.set(key, structuredClone(value)) }),
  del: vi.fn(async (key: string) => { idb.delete(key) }),
}))

const baseChrome = chrome
let local: Record<string, unknown>
let locked: boolean
let queue: Promise<unknown>
let pauseSnapshot: (() => Promise<void>) | undefined

const localGet = vi.fn(async (requested?: string | string[] | null) => {
  expect(locked).toBe(true)
  if (requested == null) {
    if (pauseSnapshot) await pauseSnapshot()
    return structuredClone(local)
  }
  const selected = typeof requested === 'string' ? [requested] : requested
  return structuredClone(Object.fromEntries(selected.filter(key => key in local).map(key => [key, local[key]])))
})
const localSet = vi.fn(async (values: Record<string, unknown>) => {
  expect(locked).toBe(true)
  Object.assign(local, structuredClone(values))
})
const localClear = vi.fn(async () => {
  expect(locked).toBe(true)
  local = {}
})
const localRemove = vi.fn(async (requested: string | string[]) => {
  expect(locked).toBe(true)
  for (const key of typeof requested === 'string' ? [requested] : requested) delete local[key]
})
const requestLock = vi.fn(<T>(name: string, operation: () => Promise<T>): Promise<T> => {
  expect(name).toBe('sidekick-session-storage')
  const result = queue.then(async () => {
    expect(locked).toBe(false)
    locked = true
    try { return await operation() } finally { locked = false }
  })
  queue = result.then(() => undefined, () => undefined)
  return result
})

function session(id: string, updatedAt = 1): ChatSession {
  return {
    id, title: `Session ${id}`, createdAt: 1, updatedAt,
    messages: [{ id: `message-${id}`, role: 'user', parts: [{ type: 'text', text: `Body ${updatedAt}` }] }],
    pageUrl: 'https://example.test/', mode: 'pro', interrupted: true,
  }
}

function seedSessions(sessions: ChatSession[]) {
  local[SESSION_INDEX_KEY] = sessions.map(sessionIndexEntry)
  for (const value of sessions) local[sessionStorageKey(value.id)] = value
}

function backup(chromeStorage: Record<string, unknown>, indexedDB: Record<string, unknown> = {}): BackupPayload {
  return { version: 1, exportedAt: 1, extensionVersion: 'test', chromeStorage, indexedDB }
}

async function gzip(value: unknown): Promise<Blob> {
  return new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

async function decode(blob: Blob): Promise<BackupPayload> {
  return JSON.parse(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text())
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  local = { [SESSION_INDEX_KEY]: [] }
  idb.clear()
  locked = false
  queue = Promise.resolve()
  pauseSnapshot = undefined
  vi.stubGlobal('navigator', { locks: { request: requestLock } })
  vi.stubGlobal('chrome', {
    ...baseChrome,
    storage: { ...baseChrome.storage, local: { get: localGet, set: localSet, clear: localClear, remove: localRemove } },
    runtime: { ...baseChrome.runtime, getManifest: () => ({ version: 'test' }) },
  })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('v1 data transfer with per-session storage', () => {
  it('exports full bodies in index order without leaking internal keys', async () => {
    const sessions = [session('b'), session('a', 2)]
    seedSessions(sessions)
    local[sessionStorageKey('orphan')] = session('orphan')
    local.sidekick_config = { apiKey: 'synthetic-key' }
    local['history:a'] = ['archive']
    local.userSkills = { demo: { content: 'skill' } }
    local.customActions = ['action']
    local.mcp_tokens_demo = 'synthetic-token'
    local[SESSION_MIGRATION_KEY] = { status: 'complete', completed: 2, total: 2 }
    idb.set('shellfs:a', { '/tmp/demo': 'content' })
    idb.set(7, 'non-string key')
    const before = structuredClone(local)

    const payload = await decode(await exportAllData())

    expect(payload).toEqual({
      ...backup({
        sidekick_sessions: sessions,
        sidekick_config: local.sidekick_config,
        'history:a': ['archive'],
        userSkills: local.userSkills,
        customActions: ['action'],
        mcp_tokens_demo: 'synthetic-token',
      }, { 'shellfs:a': { '/tmp/demo': 'content' } }),
      exportedAt: expect.any(Number),
    })
    expect(payload.exportedAt).toBeGreaterThan(1)
    expect(Object.keys(payload.chromeStorage).some(key => key.startsWith(SESSION_KEY_PREFIX))).toBe(false)
    expect(local).toEqual(before)
    expect(localSet).not.toHaveBeenCalled()
    expect(requestLock).toHaveBeenCalledTimes(1)
  })

  it('exports an empty legacy array when no sessions exist', async () => {
    expect((await decode(await exportAllData())).chromeStorage).toEqual({ sidekick_sessions: [] })
  })

  it('exports synthetic legacy storage through the migration contract', async () => {
    const sessions = [session('legacy')]
    local = { sidekick_sessions: sessions }
    const payload = await decode(await exportAllData())
    expect(payload.chromeStorage).toEqual({ sidekick_sessions: sessions })
    expect(local.sidekick_sessions).toBeUndefined()
    expect(local[SESSION_INDEX_KEY]).toEqual(sessions.map(sessionIndexEntry))
  })

  it('replaces chrome and string-keyed IDB data, converting the v1 array', async () => {
    seedSessions([session('old')])
    local.sidekick_config = { apiKey: 'synthetic-current' }
    local['history:old'] = ['old']
    idb.set('shellfs:old', 'old')
    idb.set(7, 'retain non-string key')
    const incoming = [session('new', 5)]
    const chromeStorage = {
      sidekick_sessions: incoming,
      sidekick_config: { apiKey: 'synthetic-backup' },
      userSkills: { demo: { content: 'incoming' } },
      customActions: ['incoming'],
      mcp_tokens_demo: 'synthetic-backup-token',
      'history:new': ['incoming history'],
    }

    expect(await importAllData(await gzip(backup(chromeStorage, { 'shellfs:new': 'new' })), 'replace'))
      .toEqual({ sessionsImported: 1, sessionsKept: 0, errors: [] })
    const { sidekick_sessions: legacy, ...other } = chromeStorage
    expect(local).toEqual({ ...other, [SESSION_INDEX_KEY]: legacy.map(sessionIndexEntry), [sessionStorageKey('new')]: incoming[0] })
    expect(idb).toEqual(new Map<string | number, unknown>([[7, 'retain non-string key'], ['shellfs:new', 'new']]))
    expect(await loadSessions()).toEqual(incoming)
  })

  it('installs the replacement before pruning stale keys', async () => {
    seedSessions([session('old')])
    local['history:old'] = ['old']
    expect(await importAllData(await gzip(backup({ sidekick_sessions: [session('new')] })), 'replace'))
      .toEqual({ sessionsImported: 1, sessionsKept: 0, errors: [] })
    expect(localClear).not.toHaveBeenCalled()
    expect(localSet).toHaveBeenCalledTimes(1)
    expect(localRemove).toHaveBeenCalledTimes(1)
    expect(localRemove.mock.invocationCallOrder[0]).toBeGreaterThan(localSet.mock.invocationCallOrder[0])
    expect(localRemove.mock.calls[0][0]).toEqual(expect.arrayContaining([sessionStorageKey('old'), 'history:old']))
    expect(local).not.toHaveProperty(sessionStorageKey('old'))
    expect(local).not.toHaveProperty('history:old')
    expect(local[sessionStorageKey('new')]).toEqual(session('new'))
  })

  it('leaves the current store intact when the replacement write fails', async () => {
    seedSessions([session('old')])
    local.sidekick_config = { apiKey: 'synthetic-current' }
    const before = structuredClone(local)
    const error = new Error('synthetic quota failure')
    localSet.mockRejectedValueOnce(error)
    await expect(importAllData(await gzip(backup({ sidekick_sessions: [session('new')] })), 'replace')).rejects.toBe(error)
    expect(local).toEqual(before)
    expect(localClear).not.toHaveBeenCalled()
    expect(localRemove).not.toHaveBeenCalled()
  })

  it('merges only newer sessions and preserves config, archives, skills and IDB conflicts', async () => {
    const current = [session('newer-local', 9), session('equal', 5), session('older-local', 1), session('local-only')]
    seedSessions(current)
    Object.assign(local, {
      sidekick_config: { apiKey: 'synthetic-current' },
      customActions: ['current'], mcp_tokens_demo: 'synthetic-current-token',
      userSkills: { conflict: 'current', local: 'local' }, 'history:equal': ['current archive'],
    })
    idb.set('memory:global', 'current')
    const incoming = [session('newer-local', 1), session('equal', 5), session('older-local', 8), session('incoming')]
    const blob = await gzip(backup({
      sidekick_sessions: incoming,
      sidekick_config: { apiKey: 'synthetic-backup' }, customActions: ['incoming'],
      mcp_tokens_demo: 'synthetic-backup-token', mcp_client_new: 'ignore', unrelated: 'ignore',
      userSkills: { conflict: 'incoming', added: 'added' },
      'history:equal': ['incoming archive'], 'history:incoming': ['added archive'],
    }, { 'memory:global': 'incoming', 'shellfs:incoming': 'added' }))

    expect(await importAllData(blob, 'merge')).toEqual({ sessionsImported: 2, sessionsKept: 4, errors: [] })
    const merged = [current[0], current[1], incoming[2], current[3], incoming[3]]
    expect(await loadSessions()).toEqual(merged)
    expect(local[SESSION_INDEX_KEY]).toEqual(merged.map(sessionIndexEntry))
    expect(localSet).toHaveBeenCalledTimes(1)
    expect(Object.keys(localSet.mock.calls[0][0]).filter(key => key.startsWith(SESSION_KEY_PREFIX)))
      .toEqual([sessionStorageKey('older-local'), sessionStorageKey('incoming')])
    expect(local).toMatchObject({
      sidekick_config: { apiKey: 'synthetic-current' }, customActions: ['current'],
      mcp_tokens_demo: 'synthetic-current-token', userSkills: { conflict: 'current', local: 'local', added: 'added' },
      'history:equal': ['current archive'], 'history:incoming': ['added archive'],
    })
    expect(local.sidekick_sessions).toBeUndefined()
    expect(local.mcp_client_new).toBeUndefined()
    expect(local.unrelated).toBeUndefined()
    expect(idb).toEqual(new Map([['memory:global', 'current'], ['shellfs:incoming', 'added']]))
  })

  it('does not import config or device tokens into an empty store during merge', async () => {
    await importAllData(await gzip(backup({ sidekick_config: {}, mcp_tokens_demo: 'synthetic', customActions: [] })), 'merge')
    expect(local).toEqual({ [SESSION_INDEX_KEY]: [] })
  })

  it.each(['replace', 'merge'] as const)('excludes incoming migration status in %s backups without changing the v1 format', async mode => {
    for (const status of ['running', 'complete', 'error']) {
      const incoming = session(status)
      const payload = backup({
        sidekick_sessions: [incoming],
        [SESSION_MIGRATION_KEY]: { status, completed: 1, total: 10, error: 'other device error' },
      })
      const result = await importAllData(await gzip(payload), mode)
      expect(result.errors).toEqual([])
      expect(result.sessionsImported).toBe(1)
      expect(local).not.toHaveProperty(SESSION_MIGRATION_KEY)
      expect(local[sessionStorageKey(incoming.id)]).toEqual(incoming)
      expect(localSet.mock.calls.some(([values]) => Object.hasOwn(values, SESSION_MIGRATION_KEY))).toBe(false)
      expect((await decode(await exportAllData())).version).toBe(1)
    }
  })

  it('preserves the local completion notice during merge instead of restoring remote progress', async () => {
    seedSessions([session('local')])
    const completion = { status: 'complete', completed: 1, total: 1 }
    local[SESSION_MIGRATION_KEY] = completion
    const payload = backup({
      sidekick_sessions: [session('incoming')],
      [SESSION_MIGRATION_KEY]: { status: 'running', completed: 3, total: 20 },
    })
    expect(await importAllData(await gzip(payload), 'merge')).toEqual({ sessionsImported: 1, sessionsKept: 1, errors: [] })
    expect(local[SESSION_MIGRATION_KEY]).toEqual(completion)
    expect(localSet.mock.calls.some(([values]) => Object.hasOwn(values, SESSION_MIGRATION_KEY))).toBe(false)
  })

  it('merges after migrating synthetic legacy sessions without losing existing bodies', async () => {
    const existing = session('legacy', 10)
    local = { sidekick_sessions: [existing] }
    const incoming = session('added')
    expect(await importAllData(await gzip(backup({ sidekick_sessions: [session('legacy', 1), incoming] })), 'merge'))
      .toEqual({ sessionsImported: 1, sessionsKept: 1, errors: [] })
    expect(await loadSessions()).toEqual([existing, incoming])
    expect(local.sidekick_sessions).toBeUndefined()
  })

  it('round-trips a v1 export through replace', async () => {
    const sessions = [session('roundtrip')]
    seedSessions(sessions)
    idb.set('memory:global', 'memory')
    const blob = await exportAllData()
    local = { [SESSION_INDEX_KEY]: [] }
    idb.clear()
    expect(await importAllData(blob, 'replace')).toEqual({ sessionsImported: 1, sessionsKept: 0, errors: [] })
    expect(await loadSessions()).toEqual(sessions)
    expect(idb.get('memory:global')).toBe('memory')
  })

  it.each(['replace', 'merge'] as const)('accepts missing sessions in %s backups', async mode => {
    expect(await importAllData(await gzip(backup({})), mode)).toEqual({ sessionsImported: 0, sessionsKept: 0, errors: [] })
    expect(local[SESSION_INDEX_KEY]).toEqual([])
  })

  it.each([
    ['null payload', null],
    ['unknown version', { version: 2 }],
    ['null chromeStorage', { ...backup({}), chromeStorage: null }],
    ['array chromeStorage', { ...backup({}), chromeStorage: [] }],
    ['missing indexedDB', { version: 1, chromeStorage: {} }],
    ['array indexedDB', { ...backup({}), indexedDB: [] }],
    ['non-array sessions', backup({ sidekick_sessions: {} })],
    ['null sessions', backup({ sidekick_sessions: null })],
    ['null session', backup({ sidekick_sessions: [null] })],
    ['missing ID', backup({ sidekick_sessions: [{ ...session('a'), id: undefined }] })],
    ['empty ID', backup({ sidekick_sessions: [session('')] })],
    ['invalid title', backup({ sidekick_sessions: [{ ...session('a'), title: null }] })],
    ['invalid createdAt', backup({ sidekick_sessions: [{ ...session('a'), createdAt: '1' }] })],
    ['invalid updatedAt', backup({ sidekick_sessions: [{ ...session('a'), updatedAt: '1' }] })],
    ['invalid messages', backup({ sidekick_sessions: [{ ...session('a'), messages: {} }] })],
    ['duplicate IDs', backup({ sidekick_sessions: [session('a'), session('a', 2)] })],
    ['internal index', backup({ [SESSION_INDEX_KEY]: [] })],
    ['internal record', backup({ [sessionStorageKey('a')]: session('a') })],
  ])('rejects %s before migration or destructive writes', async (_name, value) => {
    local = { sidekick_sessions: [session('untouched')] }
    idb.set('memory:global', 'untouched')
    const before = structuredClone(local)
    for (const mode of ['replace', 'merge'] as const) {
      const result = await importAllData(await gzip(value), mode)
      expect(result.errors).toHaveLength(1)
      expect(result.sessionsImported).toBe(0)
    }
    expect(local).toEqual(before)
    expect(idb.get('memory:global')).toBe('untouched')
    expect(requestLock).not.toHaveBeenCalled()
    expect(localClear).not.toHaveBeenCalled()
    expect(localSet).not.toHaveBeenCalled()
  })

  it('reports invalid gzip without touching either store', async () => {
    expect((await importAllData(new Blob(['not gzip']), 'replace')).errors[0]).toContain('Failed to decompress/parse backup')
    expect(requestLock).not.toHaveBeenCalled()
  })

  it('waits for a concurrent writer before taking the export snapshot', async () => {
    seedSessions([session('a')])
    const entered = deferred()
    const release = deferred()
    const updated = session('a', 10)
    const writing = withSessionStorage(async () => {
      await chrome.storage.local.set({ [sessionStorageKey('a')]: updated })
      entered.resolve()
      await release.promise
      await chrome.storage.local.set({ [SESSION_INDEX_KEY]: [sessionIndexEntry(updated)] })
    })
    await entered.promise
    const exporting = exportAllData()
    expect(localGet.mock.calls.filter(call => call[0] === undefined)).toHaveLength(0)
    release.resolve()
    await writing
    expect((await decode(await exporting)).chromeStorage.sidekick_sessions).toEqual([updated])
  })

  it.each(['replace', 'merge'] as const)('serializes %s import with a concurrent save', async mode => {
    seedSessions([session('old')])
    const entered = deferred()
    const release = deferred()
    pauseSnapshot = async () => { entered.resolve(); await release.promise }
    const incoming = session('imported')
    const importing = importAllData(await gzip(backup({ sidekick_sessions: [incoming] })), mode)
    await entered.promise
    const concurrent = session('saved')
    const saving = saveSession(concurrent)
    release.resolve()
    await Promise.all([importing, saving])
    const expected = mode === 'replace' ? [incoming, concurrent] : [session('old'), incoming, concurrent]
    expect(await loadSessions()).toEqual(expected)
    expect(local[SESSION_INDEX_KEY]).toEqual(expected.map(sessionIndexEntry))
  })
})
