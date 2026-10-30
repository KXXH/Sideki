import type { SendItem } from './kernel/chat-kernel'
import type { CanvasSnapshot } from './canvas-state'

export async function canvasRequest<T>(send: (message: Record<string, unknown>) => Promise<unknown>, op: string, args: Record<string, unknown>): Promise<T> {
  const result = await send({ type: 'canvas:request', op, ...args }) as { success?: boolean; result?: T; error?: string } | undefined
  if (!result?.success) throw new Error(result?.error ?? '画布服务不可用')
  return result.result as T
}

export function canvasSendHooks(send: (message: Record<string, unknown>) => Promise<unknown>) {
  const owner = crypto.randomUUID()
  return {
    prepareSend: async (sessionId: string, item: SendItem, liveClaims: string[]): Promise<SendItem> => {
      if (item.opts?.timer || item.opts?.fromBridge) return item
      try {
        const canvasContext = await canvasRequest<CanvasSnapshot[]>(send, 'capture', {
          sessionId, owner, claimId: item.id, forceId: item.opts?.canvasSource?.canvasId, liveClaims,
        })
        return { ...item, opts: { ...item.opts, canvasContext } }
      } catch (error) {
        void canvasRequest(send, 'release', { sessionId, claimId: item.id }).catch(() => {})
        throw error
      }
    },
    discardSend: (sessionId: string, item: SendItem) => {
      if (item.opts?.canvasContext) void canvasRequest(send, 'release', { sessionId, claimId: item.id }).catch(() => {})
    },
  }
}
