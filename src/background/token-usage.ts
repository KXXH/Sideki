import { isUsageEvent, pruneUsage, recordUsage, USAGE_ENABLED_KEY, USAGE_STORAGE_KEY, type UsageEvent, type UsageStore } from '../shared/token-usage'

export async function persistUsage(event: UsageEvent): Promise<void> {
  // Reason: one durable read-modify-write transaction serves concurrent panel and offscreen calls.
  await navigator.locks.request(USAGE_STORAGE_KEY, async () => {
    const stored = await chrome.storage.local.get([USAGE_STORAGE_KEY, USAGE_ENABLED_KEY])
    if (stored[USAGE_ENABLED_KEY] === false) return
    const next = recordUsage(stored[USAGE_STORAGE_KEY] as UsageStore | undefined, event)
    await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: next })
  })
}

export function registerTokenUsage(): void {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'usage:record') return
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || !isUsageEvent(message.event)) {
      respond({ success: false })
      return
    }
    persistUsage(message.event).then(() => respond({ success: true }), () => respond({ success: false }))
    return true
  })
  // Reason: prune even when no further model calls occur; worker startup needs no timer.
  void navigator.locks.request(USAGE_STORAGE_KEY, async () => {
    const stored = await chrome.storage.local.get(USAGE_STORAGE_KEY)
    if (stored[USAGE_STORAGE_KEY]) {
      await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: pruneUsage(stored[USAGE_STORAGE_KEY]) })
    }
  }).catch(error => console.warn('[usage] cleanup failed', error))
}
