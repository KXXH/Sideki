import { get, keys } from 'idb-keyval'
import { SESSION_INDEX_KEY, SESSION_KEY_PREFIX, SESSION_MIGRATION_KEY, sessionIndexEntry, sessionStorageKey, withSessionStorage } from './storage'
import type { ChatSession } from './types'

export interface BackupPayload {
  version: 1
  exportedAt: number
  extensionVersion: string
  chromeStorage: Record<string, unknown>
  indexedDB: Record<string, unknown>
}

export interface ImportResult {
  sessionsImported: number
  sessionsKept: number
  errors: string[]
}

export async function exportAllData(): Promise<Blob> {
  const chromeData = await withSessionStorage(async index => {
    const stored: Record<string, unknown> = await chrome.storage.local.get()
    // Reason: v1 backup files retain the legacy array only at the file boundary.
    stored.sidekick_sessions = index.map(entry => stored[sessionStorageKey(entry.id)])
    delete stored[SESSION_INDEX_KEY]
    delete stored[SESSION_MIGRATION_KEY]
    for (const key of Object.keys(stored)) {
      if (key.startsWith(SESSION_KEY_PREFIX)) delete stored[key]
    }
    return stored
  })

  const idbData: Record<string, unknown> = {}
  const allKeys = await keys()
  for (const k of allKeys) {
    if (typeof k !== 'string') continue
    idbData[k] = await get(k)
  }

  const payload: BackupPayload = {
    version: 1,
    exportedAt: Date.now(),
    extensionVersion: chrome.runtime.getManifest().version,
    chromeStorage: chromeData,
    indexedDB: idbData,
  }

  const json = JSON.stringify(payload)
  const blob = new Blob([json])
  const compressed = blob.stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(compressed).blob()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionArray(value: unknown): value is ChatSession[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  return value.every(session => {
    if (!isRecord(session)
      || typeof session.id !== 'string' || session.id.length === 0
      || typeof session.title !== 'string'
      || typeof session.createdAt !== 'number' || !Number.isFinite(session.createdAt)
      || typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)
      || !Array.isArray(session.messages)
      || ids.has(session.id)) return false
    ids.add(session.id)
    return true
  })
}

export async function importAllData(
  gzBlob: Blob,
  mode: 'replace' | 'merge'
): Promise<ImportResult> {
  const { set: idbSet, del: idbDel } = await import('idb-keyval')
  const result: ImportResult = { sessionsImported: 0, sessionsKept: 0, errors: [] }

  let payload: unknown
  try {
    const decompressed = gzBlob.stream().pipeThrough(new DecompressionStream('gzip'))
    const text = await new Response(decompressed).text()
    payload = JSON.parse(text)
  } catch (e) {
    result.errors.push(`Failed to decompress/parse backup: ${e}`)
    return result
  }

  if (!isRecord(payload) || payload.version !== 1) {
    result.errors.push(`Unsupported backup version: ${isRecord(payload) ? payload.version : undefined}`)
    return result
  }

  const { chromeStorage, indexedDB } = payload
  if (!isRecord(chromeStorage) || !isRecord(indexedDB)) {
    result.errors.push('Invalid backup: chromeStorage and indexedDB must be objects')
    return result
  }
  const incomingSessions = chromeStorage.sidekick_sessions === undefined ? [] : chromeStorage.sidekick_sessions
  // Reason: validate before acquiring the migration lock or writing either store.
  if (!isSessionArray(incomingSessions)) {
    result.errors.push('Invalid backup: sidekick_sessions must contain valid sessions with unique IDs')
    return result
  }
  if (Object.keys(chromeStorage).some(key => key === SESSION_INDEX_KEY || key.startsWith(SESSION_KEY_PREFIX))) {
    result.errors.push('Invalid v1 backup: sessions must use the sidekick_sessions array')
    return result
  }

  await withSessionStorage(async index => {
    if (mode === 'replace') {
      const replacement = { ...chromeStorage }
      delete replacement.sidekick_sessions
      delete replacement[SESSION_MIGRATION_KEY]
      for (const session of incomingSessions) replacement[sessionStorageKey(session.id)] = session
      replacement[SESSION_INDEX_KEY] = incomingSessions.map(sessionIndexEntry)
      // Reason: install first, prune second — a failed set leaves the previous
      // store intact, whereas clear-then-set has no way back.
      const previous = await chrome.storage.local.get()
      await chrome.storage.local.set(replacement)
      const stale = Object.keys(previous).filter(key => !Object.hasOwn(replacement, key))
      if (stale.length > 0) await chrome.storage.local.remove(stale)
      result.sessionsImported = incomingSessions.length
      return
    }

    const currentChrome: Record<string, unknown> = await chrome.storage.local.get()
    const mergedChrome: Record<string, unknown> = {}
    const sessionMap = new Map(index.map(entry => [entry.id, entry]))
    for (const incoming of incomingSessions) {
      const existing = sessionMap.get(incoming.id)
      if (!existing || (incoming.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        sessionMap.set(incoming.id, sessionIndexEntry(incoming))
        mergedChrome[sessionStorageKey(incoming.id)] = incoming
        result.sessionsImported++
      }
    }
    mergedChrome[SESSION_INDEX_KEY] = Array.from(sessionMap.values())
    result.sessionsKept = index.length

    // Reason: merge must leave active config, custom actions and device OAuth tokens untouched.
    for (const [k, v] of Object.entries(chromeStorage)) {
      if (k.startsWith('history:') && !(k in currentChrome)) mergedChrome[k] = v
    }
    if (chromeStorage.userSkills && typeof chromeStorage.userSkills === 'object') {
      const current = (currentChrome.userSkills ?? {}) as Record<string, unknown>
      const incoming = chromeStorage.userSkills as Record<string, unknown>
      mergedChrome.userSkills = { ...incoming, ...current }
    }
    await chrome.storage.local.set(mergedChrome)
  })

  const existingIdbKeys = new Set((await keys()).filter(k => typeof k === 'string'))
  for (const [k, v] of Object.entries(indexedDB)) {
    if (mode === 'replace' || !existingIdbKeys.has(k)) await idbSet(k, v)
  }
  // Reason: same ordering as chrome.storage — a failed write must not leave
  // the backup's data deleted and unreplaced.
  if (mode === 'replace') {
    for (const k of existingIdbKeys) {
      if (!Object.hasOwn(indexedDB, k)) await idbDel(k)
    }
  }

  return result
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}

export function formatBackupFilename(): string {
  const d = new Date()
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `sidekick-backup-${date}.json.gz`
}
