import { describe, it, expect, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { KernelChatState, SidekickKernel, COMMAND_DEDUP_CAP } from '../../src/shared/kernel/chat-kernel'
import type { SendItem } from '../../src/shared/kernel/chat-kernel'

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))

// Reason: performSend is the only side-effecting boundary — the test kernel
// records calls so queue/scheduler semantics are verified without a transport.
class TestKernel extends SidekickKernel {
  sent: SendItem[] = []
  sendImpl: () => Promise<void> = async () => {}
  protected override async performSend(item: SendItem): Promise<void> {
    this.sent.push(item)
    return this.sendImpl()
  }
  setCompactingForTest(v: boolean) { this.setCompacting(v) }
}

function makeKernel() {
  return new TestKernel({})
}

describe('KernelChatState', () => {
  it('starts ready with empty messages, no error, rev 0', () => {
    const s = new KernelChatState<UIMessage>()
    expect(s.status).toBe('ready')
    expect(s.error).toBeUndefined()
    expect(s.messages).toEqual([])
    expect(s.rev).toBe(0)
  })

  it('setting messages copies the array, bumps rev once, notifies once', () => {
    const s = new KernelChatState<UIMessage>()
    const listener = vi.fn()
    s.subscribe(listener)
    const arr = [msg('1', 'user', 'hi')]
    s.messages = arr
    expect(s.messages).toEqual(arr)
    expect(s.messages).not.toBe(arr)
    expect(s.rev).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('pushMessage / popMessage mutate and bump rev', () => {
    const s = new KernelChatState<UIMessage>()
    s.pushMessage(msg('1', 'user', 'a'))
    s.pushMessage(msg('2', 'assistant', 'b'))
    expect(s.messages.map(m => m.id)).toEqual(['1', '2'])
    expect(s.rev).toBe(2)
    s.popMessage()
    expect(s.messages.map(m => m.id)).toEqual(['1'])
    expect(s.rev).toBe(3)
  })

  it('replaceMessage deep-clones — later mutation of the source does not leak in', () => {
    const s = new KernelChatState<UIMessage>()
    s.pushMessage(msg('1', 'user', 'a'))
    const next = msg('1', 'user', 'edited')
    s.replaceMessage(0, next)
    ;(next.parts[0] as { text: string }).text = 'mutated'
    expect((s.messages[0].parts[0] as { text: string }).text).toBe('edited')
  })

  it('status and error setters bump rev and notify', () => {
    const s = new KernelChatState<UIMessage>()
    const listener = vi.fn()
    s.subscribe(listener)
    s.status = 'streaming'
    expect(s.rev).toBe(1)
    s.error = new Error('boom')
    expect(s.rev).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe stops notifications', () => {
    const s = new KernelChatState<UIMessage>()
    const listener = vi.fn()
    const off = s.subscribe(listener)
    s.status = 'streaming'
    off()
    s.status = 'ready'
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rev is strictly monotonic across mixed mutations', () => {
    const s = new KernelChatState<UIMessage>()
    const revs: number[] = [s.rev]
    s.pushMessage(msg('1', 'user', 'a')); revs.push(s.rev)
    s.status = 'submitted'; revs.push(s.rev)
    s.messages = []; revs.push(s.rev)
    s.error = undefined; revs.push(s.rev)
    for (let i = 1; i < revs.length; i++) expect(revs[i]).toBe(revs[i - 1] + 1)
  })

  it('snapshot returns a deep clone', () => {
    const s = new KernelChatState<UIMessage>()
    const original = msg('1', 'user', 'a')
    const copy = s.snapshot(original)
    expect(copy).toEqual(original)
    expect(copy).not.toBe(original)
    expect(copy.parts).not.toBe(original.parts)
  })
})

describe('SidekickKernel queue', () => {
  it('handleSend sends immediately when ready', async () => {
    const k = makeKernel()
    await k.handleSend('hello')
    expect(k.sent.map(s => s.text)).toEqual(['hello'])
    expect(k.queue).toEqual([])
  })

  it('handleSend enqueues while streaming and bumps rev', async () => {
    const k = makeKernel()
    k.kstate.status = 'streaming'
    const before = k.rev
    await k.handleSend('queued')
    expect(k.sent).toEqual([])
    expect(k.queue.map(q => q.text)).toEqual(['queued'])
    expect(k.rev).toBeGreaterThan(before)
  })

  it('handleSend enqueues while compacting even if status is ready', async () => {
    const k = makeKernel()
    k.setCompactingForTest(true)
    await k.handleSend('during-compact')
    expect(k.sent).toEqual([])
    expect(k.queue.map(q => q.text)).toEqual(['during-compact'])
  })

  it('queues a second send while the first is still in handoff', async () => {
    const k = makeKernel()
    let release: () => void = () => {}
    k.sendImpl = () => new Promise<void>(r => { release = r })
    const first = k.handleSend('a')
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['a'])

    // Reason: status is still 'ready' during the handoff — the guard, not the
    // status, is what keeps the second send from racing into the SDK.
    await k.handleSend('b')
    expect(k.queue.map(q => q.text)).toEqual(['b'])
    expect(k.sent.map(s => s.text)).toEqual(['a'])

    k.sendImpl = async () => {}
    release()
    await first
    // Reason: status never left ready in this harness, so the queue drains on
    // the next real ready handoff just like any other queued continuation.
    k.kstate.status = 'submitted'
    k.kstate.status = 'ready'
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['a', 'b'])
    expect(k.queue).toEqual([])
  })

  it('a handoff that ends without a turn lets the queued continuation drain', async () => {
    const k = makeKernel()
    let release: () => void = () => {}
    k.sendImpl = () => new Promise<void>(r => { release = r })
    const first = k.handleSend('a')
    await flush()
    await k.handleSend('b')
    expect(k.queue.map(q => q.text)).toEqual(['b'])

    // Reason: this is the missing-config/no-transport exit — no turn starts,
    // so the guard must release the item that queued behind the handoff.
    k.releaseHandoff()
    k.sendImpl = async () => {}
    release()
    await first
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['a', 'b'])
    expect(k.queue).toEqual([])
  })

  it('removeQueued deletes one item; takeQueued returns and removes it', async () => {
    const k = makeKernel()
    k.kstate.status = 'streaming'
    await k.handleSend('a')
    await k.handleSend('b')
    const [qa, qb] = k.queue
    k.removeQueued(qa.id)
    expect(k.queue.map(q => q.text)).toEqual(['b'])
    const taken = k.takeQueued(qb.id)
    expect(taken?.text).toBe('b')
    expect(k.queue).toEqual([])
    expect(k.takeQueued('missing')).toBeNull()
  })

  it('clearQueue empties the queue', async () => {
    const k = makeKernel()
    k.kstate.status = 'streaming'
    await k.handleSend('a')
    k.clearQueue()
    expect(k.queue).toEqual([])
  })

  it('tracks queued continuation before and during ready handoff', async () => {
    const k = makeKernel()
    expect(k.hasQueuedContinuation).toBe(false)
    k.kstate.status = 'streaming'
    await k.handleSend('queued')
    expect(k.hasQueuedContinuation).toBe(true)
    k.kstate.status = 'ready'
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['queued'])
    expect(k.queue).toEqual([])
    expect(k.hasQueuedContinuation).toBe(true)
    k.kstate.status = 'streaming'
    expect(k.hasQueuedContinuation).toBe(false)
  })
})

describe('SidekickKernel turn-boundary flush', () => {
  it('flushes exactly one item per ready window, FIFO order', async () => {
    const k = makeKernel()
    k.kstate.status = 'streaming'
    await k.handleSend('first')
    await k.handleSend('second')

    k.kstate.status = 'ready'
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['first'])
    expect(k.queue.map(q => q.text)).toEqual(['second'])

    // Reason: guard resets when status leaves ready — next window flushes next item
    k.kstate.status = 'streaming'
    k.kstate.status = 'ready'
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['first', 'second'])
    expect(k.queue).toEqual([])
  })

  it('does not flush while compacting; flushes when compaction ends', async () => {
    const k = makeKernel()
    k.kstate.status = 'streaming'
    await k.handleSend('waiting')
    k.setCompactingForTest(true)
    k.kstate.status = 'ready'
    await flush()
    expect(k.sent).toEqual([])
    k.setCompactingForTest(false)
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['waiting'])
  })

  it('flushing guard blocks a second dequeue while a send is in flight', async () => {
    const k = makeKernel()
    let release: () => void = () => {}
    k.sendImpl = () => new Promise<void>(r => { release = r })
    k.kstate.status = 'streaming'
    await k.handleSend('a')
    await k.handleSend('b')
    k.kstate.status = 'ready'
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['a'])
    // Reason: a redundant ready notification (e.g. error clear) must not double-dequeue
    k.kstate.error = undefined
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['a'])
    release()
    expect(k.queue.map(q => q.text)).toEqual(['b'])
  })

  it('a failed send resets the guard so the next window can flush', async () => {
    const k = makeKernel()
    k.sendImpl = async () => { throw new Error('send failed') }
    k.kstate.status = 'streaming'
    await k.handleSend('a')
    await k.handleSend('b')
    k.kstate.status = 'ready'
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['a'])
    k.sendImpl = async () => {}
    k.kstate.status = 'streaming'
    k.kstate.status = 'ready'
    await flush()
    expect(k.sent.map(s => s.text)).toEqual(['a', 'b'])
  })
})

describe('SidekickKernel command dedup', () => {
  it('executes a command once per id', () => {
    const k = makeKernel()
    const fn = vi.fn()
    expect(k.runCommand('cmd-1', fn)).toBe(true)
    expect(k.runCommand('cmd-1', fn)).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('different ids execute independently', () => {
    const k = makeKernel()
    const fn = vi.fn()
    k.runCommand('a', fn)
    k.runCommand('b', fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('dedup set is bounded — oldest ids are evicted past the cap', () => {
    const k = makeKernel()
    const fn = vi.fn()
    for (let i = 0; i < COMMAND_DEDUP_CAP + 1; i++) k.runCommand(`c-${i}`, () => {})
    // Reason: c-0 evicted → runs again; recent id still deduped
    expect(k.runCommand('c-0', fn)).toBe(true)
    expect(k.runCommand(`c-${COMMAND_DEDUP_CAP}`, fn)).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})


describe('scheduled turn completion boundary', () => {
  it('holds queued user sends until the scheduled outcome has been committed', async () => {
    const kernel = makeKernel()
    kernel.holdScheduleBoundary(true)
    await kernel.handleSend('user follow-up')
    expect(kernel.sent).toHaveLength(0)
    expect(kernel.queue).toHaveLength(1)
    kernel.kstate.status = 'streaming'
    kernel.kstate.status = 'ready'
    expect(kernel.sent).toHaveLength(0)
    kernel.holdScheduleBoundary(false)
    await flush()
    expect(kernel.sent.map(item => item.text)).toEqual(['user follow-up'])
  })
})
