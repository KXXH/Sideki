import { canvasStore, commitCanvasMessageState } from '../shared/canvas-storage'
import { loadConfig, loadSession, loadSessionIndex } from '../shared/storage'
import { parseVfsPreviewLink } from '../shared/html-artifact'
import { canvasStorageKey, validateFollowUp, type CanvasBinding } from '../shared/canvas-state'

function bindingOf(raw: Record<string, unknown>): CanvasBinding {
  if (typeof raw.sessionId !== 'string' || typeof raw.canvasId !== 'string' || !raw.canvasId || raw.canvasId.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(raw.canvasId)) throw new Error('画布来源无效')
  if (typeof raw.path !== 'string' || parseVfsPreviewLink(raw.path)?.path !== raw.path) throw new Error('画布路径无效')
  return { sessionId: raw.sessionId, canvasId: raw.canvasId, path: raw.path, title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '画布' }
}

export function registerCanvasRequests(ensureOffscreen: () => Promise<void>): void {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'canvas:request') return undefined
    if (sender.id !== chrome.runtime.id) { respond({ success: false, error: '画布来源无效' }); return undefined }
    void (async () => {
      if (typeof message.sessionId !== 'string') throw new Error('缺少来源会话')
      const session = (await loadSessionIndex()).find(s => s.id === message.sessionId)
      if (!session) throw new Error('来源会话不存在，请恢复会话后重试')
      if (message.op === 'validate-target') {
        if (!Number.isInteger(message.tabId)) return false
        const tab = await chrome.tabs.get(message.tabId).catch(() => null)
        return !!tab && !!tab.url && !tab.url.startsWith(chrome.runtime.getURL('src/preview/'))
      }
      if (message.op === 'open') return { ...await canvasStore.open(bindingOf(message)), sessionTitle: session.title }
      if (message.op === 'set') return canvasStore.set(bindingOf(message), message.state)
      if (message.op === 'capture') {
        if (typeof message.owner !== 'string' || typeof message.claimId !== 'string' || !/^[\w-]{1,100}$/.test(message.claimId) || !/^[\w-]{1,100}$/.test(message.owner)) throw new Error('发送标识无效')
        const key = canvasStorageKey(message.sessionId)
        const previous = (await chrome.storage.local.get(key))[key] as { owner?: string; records?: Record<string, unknown> } | undefined
        if (previous?.owner !== message.owner && previous?.records && Object.keys(previous.records).length) {
          // Reason: recover a crash between saving the user message and acknowledging its canvas versions, once per runtime.
          const saved = await loadSession(message.sessionId)
          if (!saved) throw new Error('来源会话不存在')
          await commitCanvasMessageState(message.sessionId, saved.messages)
        }
        if (message.liveClaims !== undefined && (!Array.isArray(message.liveClaims) || message.liveClaims.some((id: unknown) => typeof id !== 'string'))) throw new Error('队列预留标识无效')
        return canvasStore.capture(message.sessionId, message.owner, message.claimId, message.forceId, message.liveClaims)
      }
      if (message.op === 'release') {
        if (typeof message.claimId !== 'string' || !/^[\w-]{1,100}$/.test(message.claimId)) throw new Error('发送标识无效')
        return canvasStore.release(message.sessionId, message.claimId)
      }
      if (message.op === 'follow-up') {
        const binding = bindingOf(message)
        await canvasStore.open(binding)
        const args = validateFollowUp(message.args)
        const config = await loadConfig()
        if (config?.labKernelHost !== 'panel') await ensureOffscreen()
        const result = await chrome.runtime.sendMessage({
          type: config?.labKernelHost === 'panel' ? 'canvas:enqueue-panel' : 'canvas:enqueue-offscreen',
          sessionId: binding.sessionId, canvasId: binding.canvasId, title: binding.title, prompt: args.prompt,
        }) as { accepted?: boolean; error?: string; messageId?: string } | undefined
        if (!result?.accepted) throw new Error(result?.error ?? '请打开来源会话并恢复执行页面绑定后重试')
        return { status: 'queued', messageId: result.messageId }
      }
      throw new Error('未知画布请求')
    })().then(result => respond({ success: true, result })).catch(error => respond({ success: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  })
}
