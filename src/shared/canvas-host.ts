import { canvasRequest } from './canvas-client'
import { canvasStorageKey, validateFollowUp, validateWidgetPatch, type CanvasBinding, type CanvasRecord, type WidgetState } from './canvas-state'

function widgetState(record: CanvasRecord): WidgetState {
  return { modelContent: record.modelContent, privateContent: record.privateContent }
}

// Reason: confirmation lives in the trusted extension document, outside generated HTML.
function confirmFollowUp(binding: CanvasBinding, prompt: string, title?: string) {
  const dialog = document.createElement('dialog')
  dialog.setAttribute('aria-label', '发送画布消息')
  Object.assign(dialog.style, {
    margin: 'auto', padding: '20px', maxWidth: 'min(480px, 90vw)', maxHeight: '80vh', overflow: 'auto',
    background: 'var(--color-surface-raised)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border-subtle)', borderRadius: '12px',
  })
  const heading = document.createElement('h3')
  heading.textContent = title || '发送画布消息'
  const source = document.createElement('p')
  source.textContent = `来自画布：${binding.title} · 发送到会话：${binding.sessionTitle || binding.sessionId}`
  const content = document.createElement('p')
  content.textContent = prompt
  Object.assign(content.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '16px 0' })
  const cancel = document.createElement('button')
  cancel.textContent = '取消'
  const send = document.createElement('button')
  send.textContent = '发送'
  cancel.className = send.className = 'rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm'
  send.style.marginLeft = '12px'
  dialog.append(heading, source, content, cancel, send)
  document.body.append(dialog)
  let finish!: (value: boolean) => void
  const result = new Promise<boolean>(resolve => {
    let settled = false
    finish = value => {
      if (settled) return
      settled = true
      dialog.close()
      dialog.remove()
      resolve(value)
    }
    cancel.addEventListener('click', () => finish(false))
    send.addEventListener('click', () => finish(true))
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false) })
    dialog.showModal()
  })
  return { result, cancel: () => finish(false) }
}

export async function createCanvasHost(binding: CanvasBinding, post: (message: Record<string, unknown>) => void) {
  const send = (message: Record<string, unknown>) => chrome.runtime.sendMessage(message)
  const record = await canvasRequest<CanvasRecord>(send, 'open', { ...binding })
  let disposed = false
  let confirmation: ReturnType<typeof confirmFollowUp> | null = null
  let confirmationId: string | null = null
  let chain = Promise.resolve()
  const replies = new Map<string, Promise<unknown>>()
  const pending = new Set<string>()
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (disposed || area !== 'local') return
    const value = changes[canvasStorageKey(binding.sessionId)]?.newValue as { records?: Record<string, CanvasRecord> } | undefined
    const current = value?.records?.[binding.canvasId]
    if (current) post({ type: 'viz:state', state: widgetState(current), revision: current.revision })
  }
  chrome.storage.onChanged.addListener(changed)
  return {
    initial: { enabled: true, widgetState: widgetState(record), revision: record.revision },
    handle(data: { type?: string; requestId?: unknown; method?: unknown; args?: unknown }): boolean {
      if (data.type === 'viz:cancel') {
        if (data.requestId === confirmationId) confirmation?.cancel()
        return true
      }
      if (data.type !== 'viz:request') return false
      if (disposed || typeof data.requestId !== 'string' || data.requestId.length > 100) return true
      const requestId = data.requestId
      let result = replies.get(requestId)
      if (!result) {
        if (pending.size >= 20) {
          post({ type: 'viz:response', requestId, error: '画布请求过多，请等待上一批完成' })
          return true
        }
        if (replies.size >= 200) {
          const oldest = [...replies.keys()].find(key => !pending.has(key))
          if (oldest) replies.delete(oldest)
        }
        const execute = async () => {
          if (disposed) throw new Error('画布已关闭')
          if (data.method === 'setWidgetState') {
            const state = validateWidgetPatch(data.args)
            const updated = await canvasRequest<CanvasRecord>(send, 'set', { ...binding, state })
            return { revision: updated.revision, widgetState: widgetState(updated) }
          }
          if (data.method === 'sendFollowUpMessage') {
            const args = validateFollowUp(data.args)
            if (confirmation) throw new Error('请先处理上一条画布消息')
            confirmationId = requestId
            confirmation = confirmFollowUp({ ...binding, sessionTitle: record.sessionTitle }, args.prompt, args.title)
            let accepted: boolean
            try { accepted = await confirmation.result } finally { confirmation = null; confirmationId = null }
            if (!accepted || disposed) return { status: 'cancelled' }
            await chain
            return canvasRequest(send, 'follow-up', { ...binding, args })
          }
          throw new Error('未知画布接口')
        }
        // Reason: state writes preserve invocation order; a pending confirmation must not block later state changes.
        if (data.method === 'setWidgetState') {
          result = chain.then(execute)
          chain = result.then(() => {}, () => {})
        } else result = chain.then(execute)
        replies.set(requestId, result)
        pending.add(requestId)
        void result.then(() => pending.delete(requestId), () => pending.delete(requestId))
      }
      void result.then(value => { if (!disposed) post({ type: 'viz:response', requestId, result: value }) })
        .catch(error => { if (!disposed) post({ type: 'viz:response', requestId, error: error instanceof Error ? error.message : String(error) }) })
      return true
    },
    dispose() {
      disposed = true
      confirmation?.cancel()
      chrome.storage.onChanged.removeListener(changed)
      replies.clear()
    },
  }
}

export type CanvasHost = Awaited<ReturnType<typeof createCanvasHost>>
