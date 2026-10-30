import { get, set, del, keys } from 'idb-keyval'

const FS_PREFIX = 'shellfs:'
export const MAX_SESSION_SIZE_CHAT = 2 * 1024 * 1024   // 2MB
export const MAX_SESSION_SIZE_PRO = 20 * 1024 * 1024    // 20MB

export type FsSnapshot = Record<string, string>

export async function loadShellFs(sessionId: string): Promise<FsSnapshot | null> {
  return await get(`${FS_PREFIX}${sessionId}`) ?? null
}

export async function saveShellFs(sessionId: string, snapshot: FsSnapshot, maxSize = MAX_SESSION_SIZE_CHAT): Promise<void> {
  const size = Object.values(snapshot).reduce((sum, v) => sum + v.length, 0)
  if (size > maxSize) {
    throw new Error(`Shell filesystem exceeds ${maxSize / 1024}KB limit (current: ${Math.round(size / 1024)}KB)`)
  }
  await set(`${FS_PREFIX}${sessionId}`, snapshot)
  notifyBackup(sessionId, snapshot)
}

function notifyBackup(sessionId: string, snapshot: FsSnapshot | null): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).__backupNotify?.('shellfs', sessionId, snapshot)
  } catch (e) {
    // Reason: notification failure cannot undo an already committed IndexedDB write.
    console.warn('[shell-storage] backup notification failed:', sessionId, e)
  }
}

export async function deleteShellFs(sessionId: string): Promise<void> {
  await del(`${FS_PREFIX}${sessionId}`)
  notifyBackup(sessionId, null)
}

export async function getShellFsSize(sessionId: string): Promise<number> {
  try {
    const snapshot = await get(`${FS_PREFIX}${sessionId}`) as FsSnapshot | undefined
    if (!snapshot) return 0
    return Object.values(snapshot).reduce((sum, v) => sum + v.length, 0)
  } catch (e) {
    console.warn('[shell-storage] getShellFsSize failed:', sessionId, e)
    return 0
  }
}

export async function getAllShellFsSessionIds(): Promise<string[]> {
  try {
    const allKeys = await keys()
    return allKeys
      .filter(k => typeof k === 'string' && k.startsWith(FS_PREFIX))
      .map(k => (k as string).slice(FS_PREFIX.length))
  } catch (e) {
    console.warn('[shell-storage] getAllShellFsSessionIds failed:', e)
    return []
  }
}
