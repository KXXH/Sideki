import type { UIMessage } from 'ai'
import { CanvasStateStore, canvasStorageKey, type CanvasSnapshot } from './canvas-state'

export const canvasStore = new CanvasStateStore({
  read: async sessionId => (await chrome.storage.local.get(canvasStorageKey(sessionId)))[canvasStorageKey(sessionId)],
  write: async (sessionId, value) => { await chrome.storage.local.set({ [canvasStorageKey(sessionId)]: value }) },
  lock: (sessionId, work) => navigator.locks.request(`sidekick-canvas:${sessionId}`, work),
})

export async function commitCanvasMessageState(sessionId: string, messages: unknown[]): Promise<void> {
  const snapshots = (messages as UIMessage[]).filter(m => m?.role === 'user' && Array.isArray(m.parts)).flatMap(m => m.parts.flatMap(part => {
    if (part.type !== 'data-canvas-context') return []
    const data = (part as unknown as { data: CanvasSnapshot[] }).data
    return Array.isArray(data) ? data : []
  }))
  if (snapshots.length) await canvasStore.commit(sessionId, snapshots)
}
