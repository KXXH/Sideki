import type { ApiConfig, ChatSession } from './types'
import { resolveDefaultPermissionMode } from './permission-mode'
import { commitCanvasMessageState } from './canvas-storage'
import { canvasStorageKey } from './canvas-state'

const CONFIG_KEY = 'sidekick_config'
const SESSIONS_KEY = 'sidekick_sessions'

export async function loadConfig(): Promise<ApiConfig | null> {
  const result = await chrome.storage.local.get(CONFIG_KEY)
  const config = result[CONFIG_KEY] as (ApiConfig & { proMode?: boolean; yoloMode?: boolean }) | undefined
  if (!config) return null
  if (config.yoloMode === undefined && typeof config.proMode === 'boolean') {
    const { proMode: legacyProMode, ...rest } = config
    const migrated = { ...rest, yoloMode: legacyProMode } as ApiConfig
    return { ...migrated, defaultPermissionMode: resolveDefaultPermissionMode(migrated) }
  }
  return { ...config, yoloMode: config.yoloMode ?? false, defaultPermissionMode: resolveDefaultPermissionMode(config) } as ApiConfig
}

export async function saveConfig(config: ApiConfig): Promise<void> {
  const clean = { ...config } as ApiConfig & { proMode?: boolean }
  delete clean.proMode
  await chrome.storage.local.set({ [CONFIG_KEY]: clean })
}

// Reason: single source of truth for "switch active profile" — copies profile
// fields to the top-level ApiConfig mirror that all consumers read.
export function applyProfile(config: ApiConfig, profileId: string): ApiConfig {
  const profile = config.profiles?.find(p => p.id === profileId)
  if (!profile) return config
  return {
    ...config,
    activeProfileId: profileId,
    apiProtocol: profile.apiProtocol ?? 'chat-completions',
    endpoint: profile.endpoint,
    apiKey: profile.apiKey,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    supportsImages: profile.supportsImages,
    modelParams: profile.modelParams,
    // Reason: legacy profiles predate per-profile contextWindow — keep global value
    contextWindow: profile.contextWindow ?? config.contextWindow,
  }
}

export const SESSION_INDEX_KEY = 'sidekick_session_index'
export const SESSION_KEY_PREFIX = 'sidekick_session:'
export const SESSION_MIGRATION_KEY = 'sidekick_session_migration_status'
const MIGRATION_PENDING_KEY = 'sidekick_session_migration_pending'
const PENDING_DELETES_KEY = 'sidekick_session_pending_deletes'

export type SessionMigrationStatus = {
  status: 'running' | 'complete' | 'error'
  completed: number
  total: number
  error?: string
}

export type SessionIndexEntry = Omit<ChatSession, 'messages'> & { messageCount: number }

export function sessionStorageKey(id: string): string {
  return `${SESSION_KEY_PREFIX}${id}`
}

export function sessionIndexEntry(session: ChatSession): SessionIndexEntry {
  const { messages, ...metadata } = session
  return { ...metadata, messageCount: messages.length }
}

export function withSessionStorage<T>(operation: (index: SessionIndexEntry[]) => Promise<T>): Promise<T> {
  // Reason: panel and worker writes must share one lock, including import and migration.
  return navigator.locks.request('sidekick-session-storage', async () => {
    const stored = await chrome.storage.local.get([SESSION_INDEX_KEY, MIGRATION_PENDING_KEY, PENDING_DELETES_KEY, SESSION_MIGRATION_KEY])
    let index = stored[SESSION_INDEX_KEY] as SessionIndexEntry[] | undefined
    let cleanup = stored[MIGRATION_PENDING_KEY] === true
    const previous = stored[SESSION_MIGRATION_KEY] as SessionMigrationStatus | undefined
    let migration: SessionMigrationStatus | undefined
    try {
      if (index === undefined) {
        const legacy = await chrome.storage.local.get(SESSIONS_KEY)
        const sessions = (legacy[SESSIONS_KEY] ?? []) as ChatSession[]
        cleanup = Array.isArray(legacy[SESSIONS_KEY])
        if (cleanup) {
          migration = { status: 'running', completed: 0, total: sessions.length }
          await chrome.storage.local.set({ [SESSION_MIGRATION_KEY]: migration })
        }
        for (const session of sessions) {
          const progress = migration ? { ...migration, completed: migration.completed + 1 } : undefined
          await chrome.storage.local.set({
            [sessionStorageKey(session.id)]: session,
            ...(progress ? { [SESSION_MIGRATION_KEY]: progress } : {}),
          })
          migration = progress
        }
        index = sessions.map(sessionIndexEntry)
        // Reason: publish the index only after every body is durable; interrupted copies can be retried.
        await chrome.storage.local.set({
          [SESSION_INDEX_KEY]: index,
          ...(cleanup ? { [MIGRATION_PENDING_KEY]: true } : {}),
        })
      } else if (cleanup || previous?.status === 'running' || previous?.status === 'error') {
        // Reason: a durable index permits finalization without recopying bodies after a restart.
        migration = { status: 'running', completed: index.length, total: index.length }
      }
      if (cleanup) await chrome.storage.local.remove([SESSIONS_KEY, MIGRATION_PENDING_KEY])
      if (migration) {
        await chrome.storage.local.set({ [SESSION_MIGRATION_KEY]: { ...migration, status: 'complete' } })
      }
    } catch (error) {
      if (migration) {
        try {
          // Reason: storage errors may contain session data, so persist only a safe diagnostic.
          await chrome.storage.local.set({
            [SESSION_MIGRATION_KEY]: { ...migration, status: 'error', error: '会话存储迁移未完成，请重试。' },
          })
        } catch {
          // Reason: status persistence must never mask the original storage failure.
        }
      }
      throw error
    }
    const pendingDeletes = stored[PENDING_DELETES_KEY] as string[] | undefined
    if (pendingDeletes) {
      await chrome.storage.local.remove([...pendingDeletes.map(sessionStorageKey), ...pendingDeletes.map(canvasStorageKey), PENDING_DELETES_KEY])
    }
    return operation(index)
  })
}

export function loadSessionIndex(): Promise<ChatSession[]> {
  return withSessionStorage(async index => index.map(entry => ({ ...entry, messages: [] })))
}

export function loadSession(id: string): Promise<ChatSession | null> {
  return withSessionStorage(async index => {
    if (!index.some(entry => entry.id === id)) return null
    const key = sessionStorageKey(id)
    const stored = await chrome.storage.local.get(key)
    return stored[key] ?? null
  })
}

export function loadSessions(): Promise<ChatSession[]> {
  return withSessionStorage(async index => {
    if (index.length === 0) return []
    const stored = await chrome.storage.local.get(index.map(entry => sessionStorageKey(entry.id)))
    return index.map(entry => stored[sessionStorageKey(entry.id)] as ChatSession)
  })
}

async function writeSession(session: ChatSession, index: SessionIndexEntry[]): Promise<void> {
  const metadata = sessionIndexEntry(session)
  const position = index.findIndex(entry => entry.id === session.id)
  const changed = position < 0 || JSON.stringify(index[position]) !== JSON.stringify(metadata)
  const values: Record<string, unknown> = { [sessionStorageKey(session.id)]: session }
  if (changed) {
    const next = [...index]
    if (position < 0) next.push(metadata)
    else next[position] = metadata
    values[SESSION_INDEX_KEY] = next
  }
  await chrome.storage.local.set(values)
}

export function saveSession(session: ChatSession): Promise<void> {
  return withSessionStorage(async index => {
    await writeSession(session, index)
    await commitCanvasMessageState(session.id, session.messages)
  })
}

export function updateSessionMeta(id: string, patch: Partial<Pick<ChatSession, 'title' | 'updatedAt' | 'permissionMode'>>): Promise<void> {
  return withSessionStorage(async index => {
    if (!index.some(entry => entry.id === id)) return
    const key = sessionStorageKey(id)
    const stored = await chrome.storage.local.get(key)
    const session = stored[key] as ChatSession | undefined
    // Reason: delta sync compares index timestamps — a metadata edit that
    // keeps the old one is invisible to devices that were offline for it.
    if (session) await writeSession({ ...session, ...patch, updatedAt: patch.updatedAt ?? Date.now() }, index)
  })
}

export function deleteSession(id: string): Promise<void> {
  return deleteSessions([id])
}

export async function deleteSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const drop = new Set(ids)
  await withSessionStorage(async index => {
    // Reason: a restart after index removal must still finish deleting the hidden bodies.
    await chrome.storage.local.set({
      [SESSION_INDEX_KEY]: index.filter(entry => !drop.has(entry.id)),
      [PENDING_DELETES_KEY]: ids,
    })
    await chrome.storage.local.remove([...ids.map(sessionStorageKey), ...ids.map(canvasStorageKey), PENDING_DELETES_KEY])
  })
}

export function getSessionSize(id: string): Promise<number> {
  return withSessionStorage(() => chrome.storage.local.getBytesInUse(sessionStorageKey(id)))
}
