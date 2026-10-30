import { loadConfig, SESSION_KEY_PREFIX, sessionStorageKey, withSessionStorage } from '../shared/storage'
import { keys as idbKeys, get as idbGet } from 'idb-keyval'

const BACKUP_URL = 'ws://127.0.0.1:9333/backup'
const ALARM_NAME = 'backup-reconnect'
const PROBE_TIMEOUT = 2000
const BACKUP_KEY_STORAGE = 'sidekick_backup_key'
// Reason: VFS changes are bursty (each keystroke triggers a save) — debounce to
// avoid flooding the daemon with per-character pushes.
const VFS_DEBOUNCE_MS = 2000

export type BackupStatus = 'connected' | 'connecting' | 'disconnected' | 'suspended'
export type SyncPhase = 'idle' | 'preparing' | 'syncing' | 'done' | 'error'

export interface SyncState {
  phase: SyncPhase
  total: number
  done: number
  errors: number
  lastSyncAt: number   // timestamp of last successful sync completion
}

let ws: WebSocket | null = null
let paired = false
let backupKey: string | null = null
let currentStatus: BackupStatus = 'disconnected'

const syncState: SyncState = { phase: 'idle', total: 0, done: 0, errors: 0, lastSyncAt: 0 }

const statusListeners = new Set<(status: BackupStatus) => void>()

export function getBackupStatus(): BackupStatus { return currentStatus }
export function isPaired(): boolean { return paired }
export function getSyncState(): SyncState { return { ...syncState } }

export function onBackupStatusChange(cb: (status: BackupStatus) => void) {
  statusListeners.add(cb)
  return () => { statusListeners.delete(cb) }
}

function setStatus(status: BackupStatus) {
  if (status === currentStatus) return
  currentStatus = status
  for (const cb of statusListeners) cb(status)
}

function handleDisconnect() {
  ws = null
  if (syncState.phase === 'syncing') {
    syncState.phase = 'error'
    notifySyncProgress()
  }
  if (paired) setStatus('disconnected')
}

// --- Startup probe ---

export async function probeAndConnect(): Promise<void> {
  const stored = await chrome.storage.local.get(BACKUP_KEY_STORAGE)
  backupKey = stored[BACKUP_KEY_STORAGE] ?? null
  paired = !!backupKey

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        ws.close()
        ws = null
      }
      resolve()
    }, PROBE_TIMEOUT)

    try {
      ws = new WebSocket(BACKUP_URL)
    } catch {
      clearTimeout(timer)
      resolve()
      return
    }

    ws.onopen = () => {
      clearTimeout(timer)
      setStatus('connecting')
      sendHello()
      resolve()
    }

    ws.onclose = () => {
      handleDisconnect()
    }

    ws.onerror = () => {
      clearTimeout(timer)
      ws?.close()
      ws = null
      resolve()
    }

    ws.onmessage = (event) => {
      handleMessage(event.data as string)
    }
  })
}

// --- Reconnection via chrome.alarms ---

function enableReconnect() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.1 })
}

function disableReconnect() {
  chrome.alarms.clear(ALARM_NAME)
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  if (!paired) { disableReconnect(); return }
  if (!ws || ws.readyState === WebSocket.CLOSED) connect()
})

export function connect() {
  if (ws && ws.readyState !== WebSocket.CLOSED) return
  setStatus('connecting')

  try {
    ws = new WebSocket(BACKUP_URL)
  } catch {
    ws = null
    return
  }

  ws.onopen = () => {
    sendHello()
  }

  ws.onmessage = (event) => {
    handleMessage(event.data as string)
  }

  ws.onclose = () => {
    handleDisconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }
}

// Reason: UI calls this to ensure a live connection before discover/pair.
// Resolves immediately if already connected, otherwise attempts and waits.
export function ensureConnected(timeoutMs = 3000): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve()
  connect()
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        clearTimeout(timer)
        clearInterval(check)
        resolve()
      }
    }, 50)
    const timer = setTimeout(() => {
      clearInterval(check)
      reject(new Error('连接超时'))
    }, timeoutMs)
  })
}

// --- Protocol handlers ---

function send(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function sendHello() {
  send({
    type: 'hello',
    protocolVersion: 1,
    extensionVersion: chrome.runtime.getManifest().version,
    backupKey,
  })
}

// Reason: keyed by expected response type to avoid collision when
// discover/pair/unpair/restore run close together.
const pendingResolvers = new Map<string, (msg: Record<string, unknown>) => void>()

function handleMessage(raw: string) {
  let msg: Record<string, unknown>
  try { msg = JSON.parse(raw) } catch { return }
  switch (msg.type) {
    case 'welcome':
      setStatus('connected')
      if (paired) {
        enableReconnect()
        deltaSync(msg.knownSessions as Record<string, { ts: number }> | undefined)
      }
      break

    case 'backup_exists':
      // Reason: daemon rejected our backupKey (mismatch) — either we reinstalled
      // or another instance paired. Invalidate local pairing so UI can re-discover.
      paired = false
      backupKey = null
      chrome.storage.local.remove(BACKUP_KEY_STORAGE)
      for (const [, t] of vfsTimers) { clearTimeout(t) }
      vfsTimers.clear()
      setStatus('connected')
      chrome.runtime.sendMessage({
        type: 'backup:exists',
        sessionCount: msg.sessionCount,
        totalSize: msg.totalSize,
        lastModified: msg.lastModified,
      }).catch(() => {})
      break

    case 'suspended':
      setStatus('suspended')
      break

    case 'pair:ok':
      paired = true
      setStatus('connected')
      enableReconnect()
      pendingResolvers.get('pair:ok')?.(msg)
      pendingResolvers.delete('pair:ok')
      // Reason: first pair happens after welcome (which skipped deltaSync
      // because paired was false at that point), so trigger a full sync now.
      deltaSync({})
      break

    case 'unpair:ok':
      paired = false
      backupKey = null
      chrome.storage.local.remove(BACKUP_KEY_STORAGE)
      disableReconnect()
      for (const [, t] of vfsTimers) { clearTimeout(t) }
      vfsTimers.clear()
      setStatus('disconnected')
      pendingResolvers.get('unpair:ok')?.(msg)
      pendingResolvers.delete('unpair:ok')
      break

    case 'discover:response':
      pendingResolvers.get('discover:response')?.(msg)
      pendingResolvers.delete('discover:response')
      break

    case 'restore:data':
      pendingResolvers.get('restore:data')?.(msg)
      pendingResolvers.delete('restore:data')
      break

    case 'ack':
      if (syncState.phase === 'syncing') {
        if (msg.ok) syncState.done++
        else syncState.errors++
        if (syncState.done + syncState.errors >= syncState.total) {
          syncState.phase = syncState.errors > 0 ? 'error' : 'done'
          if (syncState.phase === 'done') syncState.lastSyncAt = Date.now()
        }
        notifySyncProgress()
      } else {
        if (msg.ok) syncState.lastSyncAt = Date.now()
      }
      break

    case 'update:available':
      chrome.runtime.sendMessage({
        type: 'backup:update-available',
        latest: msg.latest,
        current: msg.current,
        releaseUrl: msg.releaseUrl,
      }).catch(() => {})
      break

    case 'error':
      if (msg.code === 'PROTOCOL_MISMATCH') {
        console.warn('[backup] protocol mismatch:', msg.message)
        ws?.close()
      }
      break
  }
}

// --- Public API for UI (called via chrome.runtime messages) ---

export async function discover(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('not connected'))
      return
    }
    pendingResolvers.set('discover:response', resolve)
    send({ type: 'discover' })
    setTimeout(() => {
      if (pendingResolvers.get('discover:response') === resolve) {
        pendingResolvers.delete('discover:response')
        reject(new Error('discover timeout'))
      }
    }, 5000)
  })
}

export async function pair(): Promise<void> {
  const key = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    pendingResolvers.set('pair:ok', () => {
      // Reason: only persist after daemon confirms — avoids phantom pairing
      // if the server rejects or network drops before pair:ok.
      backupKey = key
      chrome.storage.local.set({ [BACKUP_KEY_STORAGE]: key })
      resolve()
    })
    send({ type: 'pair', backupKey: key, extensionVersion: chrome.runtime.getManifest().version })
    setTimeout(() => {
      if (pendingResolvers.has('pair:ok')) {
        pendingResolvers.delete('pair:ok')
        reject(new Error('pair timeout'))
      }
    }, 5000)
  })
}

export async function unpair(): Promise<void> {
  if (ws?.readyState !== WebSocket.OPEN) {
    await ensureConnected(3000)
  }
  return new Promise((resolve, reject) => {
    pendingResolvers.set('unpair:ok', () => resolve())
    send({ type: 'unpair' })
    setTimeout(() => {
      if (pendingResolvers.has('unpair:ok')) {
        pendingResolvers.delete('unpair:ok')
        reject(new Error('unpair timeout'))
      }
    }, 5000)
  })
}

export async function requestRestore(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('not connected'))
      return
    }
    pendingResolvers.set('restore:data', resolve)
    send({ type: 'restore:request' })
    setTimeout(() => {
      if (pendingResolvers.get('restore:data') === resolve) {
        pendingResolvers.delete('restore:data')
        reject(new Error('restore timeout'))
      }
    }, 30000)
  })
}

// --- Push: send data changes to daemon ---

function push(category: string, key: string, data: unknown, deleted = false) {
  if (!paired || !ws || ws.readyState !== WebSocket.OPEN) return
  send({ type: 'push', category, key, data, deleted: deleted || undefined })
}

export function handleStorageChange(changes: Record<string, chrome.storage.StorageChange>) {
  if (!paired) return

  if (changes.sidekick_config) {
    push('config', 'config', changes.sidekick_config.newValue)
  }

  if (changes.userSkills) {
    push('userSkills', 'userSkills', changes.userSkills.newValue)
  }

  if (changes.customActions) {
    push('customActions', 'customActions', changes.customActions.newValue)
  }

  for (const key of Object.keys(changes)) {
    const deleted = changes[key].newValue === undefined
    if (key.startsWith('mcp_tokens_') || key.startsWith('mcp_client_') || key.startsWith('mcp_as_')) {
      push('mcpAuth', key, changes[key].newValue, deleted)
    }
    if (key.startsWith('history:')) {
      const sessionId = key.slice('history:'.length)
      push('history', sessionId, changes[key].newValue, deleted)
    }
    // Reason: legacy-array cleanup during migration is not a session deletion.
    if (key.startsWith(SESSION_KEY_PREFIX)) {
      const sessionId = key.slice(SESSION_KEY_PREFIX.length)
      push('session', sessionId, deleted ? null : changes[key].newValue, deleted)
    }
  }
}

// VFS debounce per session
const vfsTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function handleBackupNotify(category: string, key: string, data: unknown) {
  if (!paired) return
  const deleted = data === null || data === undefined

  if (category === 'shellfs') {
    const existing = vfsTimers.get(key)
    if (existing) clearTimeout(existing)
    vfsTimers.set(key, setTimeout(() => {
      vfsTimers.delete(key)
      push('shellfs', key, data, deleted)
    }, VFS_DEBOUNCE_MS))
  } else {
    push(category, key, data, deleted)
  }
}

function notifySyncProgress() {
  chrome.runtime.sendMessage({
    type: 'backup:sync-progress',
    sync: { ...syncState },
  }).catch(() => {})
}

// --- Delta sync: push all data the daemon doesn't have or that is newer ---

async function deltaSync(knownSessions?: Record<string, { ts: number }>) {
  if (!knownSessions) return
  try {
    syncState.phase = 'preparing'
    syncState.total = 0
    syncState.done = 0
    syncState.errors = 0
    notifySyncProgress()

    const pushItems: Array<{ category: string; key: string; data: unknown; deleted?: boolean }> = []

    // Reason: reuse the chrome snapshot for bodies while keeping index and records consistent.
    const allStorage = await withSessionStorage(async index => {
      const stored: Record<string, unknown> = await chrome.storage.local.get()
      const localIds = new Set(index.map(entry => entry.id))
      for (const entry of index) {
        const known = knownSessions[entry.id]
        if (!known || (entry.updatedAt ?? 0) > known.ts) {
          pushItems.push({ category: 'session', key: entry.id, data: stored[sessionStorageKey(entry.id)] })
        }
      }
      // Reason: a deletion leaves no timestamp to compare — reconcile by
      // absence, or sessions removed while the daemon was offline survive
      // there forever and come back on the next restore.
      for (const id of Object.keys(knownSessions)) {
        if (!localIds.has(id)) pushItems.push({ category: 'session', key: id, data: null, deleted: true })
      }
      return stored
    })

    // 2. Config
    const config = await loadConfig()
    if (config) pushItems.push({ category: 'config', key: 'config', data: config })

    // 3. chrome.storage: userSkills, customActions, history:*, mcp_*
    if (allStorage.userSkills) pushItems.push({ category: 'userSkills', key: 'userSkills', data: allStorage.userSkills })
    if (allStorage.customActions) pushItems.push({ category: 'customActions', key: 'customActions', data: allStorage.customActions })
    for (const k of Object.keys(allStorage)) {
      if (k.startsWith('history:')) {
        pushItems.push({ category: 'history', key: k.slice('history:'.length), data: allStorage[k] })
      }
      if (k.startsWith('mcp_tokens_') || k.startsWith('mcp_client_') || k.startsWith('mcp_as_')) {
        pushItems.push({ category: 'mcpAuth', key: k, data: allStorage[k] })
      }
    }

    // 4. IndexedDB: shellfs:*, memory:*
    const allIdbKeys = await idbKeys()
    for (const k of allIdbKeys) {
      if (typeof k !== 'string') continue
      if (k.startsWith('shellfs:')) {
        const data = await idbGet(k)
        pushItems.push({ category: 'shellfs', key: k.slice('shellfs:'.length), data })
      } else if (k.startsWith('memory:')) {
        const data = await idbGet(k)
        pushItems.push({ category: 'memory', key: k.slice('memory:'.length), data })
      }
    }

    if (pushItems.length === 0) {
      syncState.phase = 'done'
      syncState.lastSyncAt = Date.now()
      notifySyncProgress()
      return
    }

    syncState.phase = 'syncing'
    syncState.total = pushItems.length
    syncState.done = 0
    syncState.errors = 0
    notifySyncProgress()
    for (const item of pushItems) {
      push(item.category, item.key, item.data, item.deleted)
    }
  } catch (e) {
    console.warn('[backup] deltaSync failed:', e)
    syncState.phase = 'error'
  }
}
