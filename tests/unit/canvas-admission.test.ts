import { describe, expect, it, vi } from 'vitest'
import { SidekickKernel, type SendItem } from '../../src/shared/kernel/chat-kernel'
import { CanvasStateStore } from '../../src/shared/canvas-state'

describe('canvas snapshot admission', () => {
  it('stops pending capture without launching a late model turn', async () => {
    let resolve!: (value: SendItem) => void
    let pending!: SendItem
    const discard = vi.fn()
    const kernel = new SidekickKernel({ getSessionId: () => 's', prepareSend: async (_id, item) => {
      pending = item
      return new Promise<SendItem>(r => { resolve = r })
    }, discardSend: discard })
    const sending = kernel.handleSend('message')
    const cancelled = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(kernel.cancelPreparation()).toBe(true)
    resolve({ ...pending, opts: { canvasContext: [] } })
    await cancelled
    expect(discard).toHaveBeenCalled()
    expect(kernel.kstate.messages).toEqual([])
    expect(kernel.dispatching).toBe(false)
    expect(kernel.kstate.error).toBeUndefined()
  })
  it('pins snapshots at enqueue time, deduplicates reservations and releases a cancelled item', async () => {
    let document: unknown
    const store = new CanvasStateStore({ read: async () => structuredClone(document) as never, write: async (_id, value) => { document = structuredClone(value) }, lock: async (_id, work) => work() })
    const binding = { sessionId: 's', canvasId: 'a', title: 'A', path: '/viz/a.html' }
    await store.open(binding)
    await store.set(binding, { modelContent: { budget: 3000 } })
    const kernel = new SidekickKernel({
      getSessionId: () => 's',
      prepareSend: async (id, item) => ({ ...item, opts: { canvasContext: await store.capture(id, 'runtime', item.id) } }),
      discardSend: (id, item) => { void store.release(id, item.id) },
    })
    kernel.kstate.status = 'streaming'
    await kernel.handleSend('first')
    const first = kernel.queue[0]
    expect(first.opts?.canvasContext?.[0].modelContent).toEqual({ budget: 3000 })
    await kernel.handleSend('second')
    expect(kernel.queue[1].opts?.canvasContext).toEqual([])
    await store.set(binding, { modelContent: { budget: 5000 } })
    expect(first.opts?.canvasContext?.[0].modelContent).toEqual({ budget: 3000 })
    kernel.removeQueued(first.id)
    await kernel.handleSend('third')
    expect(kernel.queue.at(-1)?.opts?.canvasContext?.[0].modelContent).toEqual({ budget: 5000 })
    kernel.clearQueue()
  })

  it('shows pending capture as busy and discards a late result after a session switch', async () => {
    let resolve!: (value: SendItem) => void
    let pending!: SendItem
    const discarded = vi.fn()
    let sessionId = 'a'
    const kernel = new SidekickKernel({
      getSessionId: () => sessionId,
      prepareSend: async (_id, item) => { pending = item; return new Promise<SendItem>(r => { resolve = r }) },
      discardSend: discarded,
    })
    const sending = kernel.handleSend('message')
    const rejected = expect(sending).rejects.toThrow('会话已切换')
    expect(kernel.dispatching).toBe(true)
    expect(kernel.hasQueuedContinuation).toBe(true)
    await Promise.resolve()
    sessionId = 'b'
    kernel.clearQueue()
    resolve({ ...pending, opts: { canvasContext: [] } })
    await rejected
    expect(discarded).toHaveBeenCalledWith('a', expect.objectContaining({ text: 'message' }))
    expect(kernel.dispatching).toBe(false)
    expect(kernel.queue).toEqual([])
  })
})
