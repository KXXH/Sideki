import { describe, it, expect, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { SidekickKernel } from '../../src/shared/kernel/chat-kernel'
import { KernelSyncHost, type PortLike } from '../../src/shared/kernel/kernel-host'
import { applySnapshot, applyPatch, type PanelMirror, type SyncSnapshot, type SyncPatch } from '../../src/shared/kernel/sync-protocol'
import type { ApiConfig } from '../../src/shared/types'

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage
}

interface MockPort extends PortLike {
  sent: unknown[]
  emit: (msg: unknown) => void
  disconnect: () => void
}

function mockPort(): MockPort {
  const listeners: ((msg: unknown) => void)[] = []
  const disconnects: (() => void)[] = []
  const port: MockPort = {
    sent: [],
    postMessage(m: unknown) { port.sent.push(m) },
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.push(fn) },
    emit(m: unknown) { listeners.forEach(f => f(m)) },
    disconnect() { disconnects.forEach(f => f()) },
  }
  return port
}

function makeHost(commands: Record<string, (args: unknown) => void> = {}) {
  const kernel = new SidekickKernel({
    getConfig: () => ({ model: 'test' } as unknown as ApiConfig),
    getSessionId: () => 's1',
  })
  // Reason: throttleMs 0 → synchronous dispatch, deterministic tests
  const host = new KernelSyncHost(kernel, { throttleMs: 0, commands })
  return { kernel, host }
}

// Reason: panel-side reference loop — apply everything the port received,
// resyncing on gaps exactly as the real client will.
function mirrorFrom(port: MockPort): PanelMirror {
  let mirror: PanelMirror | null = null
  for (const raw of port.sent) {
    const m = raw as SyncSnapshot | SyncPatch
    if (m.type === 'snapshot') mirror = applySnapshot(m)
    else if (mirror) mirror = applyPatch(mirror, m)
    if (!mirror) throw new Error('gap without snapshot')
  }
  if (!mirror) throw new Error('no messages received')
  return mirror
}

describe('KernelSyncHost handshake', () => {
  it('answers sync with a full snapshot of current state', () => {
    const { kernel, host } = makeHost()
    kernel.kstate.pushMessage(msg('1', 'user', 'hi'))
    const port = mockPort()
    host.attachPort(port)
    port.emit({ type: 'sync' })
    const snap = port.sent[0] as SyncSnapshot
    expect(snap.type).toBe('snapshot')
    expect(snap.rev).toBe(kernel.rev)
    expect(snap.sessionId).toBe('s1')
    expect(snap.messages.map(m => m.id)).toEqual(['1'])
  })
})

describe('KernelSyncHost broadcast', () => {
  it('streams patches after handshake; mirror converges to kernel state', () => {
    const { kernel, host } = makeHost()
    const port = mockPort()
    host.attachPort(port)
    port.emit({ type: 'sync' })

    kernel.kstate.pushMessage(msg('1', 'user', 'hello'))
    kernel.kstate.status = 'streaming'
    kernel.kstate.pushMessage(msg('2', 'assistant', 'part'))
    kernel.kstate.replaceMessage(1, msg('2', 'assistant', 'partial answer'))
    kernel.kstate.status = 'ready'

    const mirror = mirrorFrom(port)
    expect(mirror.rev).toBe(kernel.rev)
    expect(mirror.messages).toEqual(kernel.kstate.messages)
    expect(mirror.status).toBe('ready')
  })

  it('broadcasts to every synced port', () => {
    const { kernel, host } = makeHost()
    const a = mockPort()
    const b = mockPort()
    host.attachPort(a)
    host.attachPort(b)
    a.emit({ type: 'sync' })
    b.emit({ type: 'sync' })
    kernel.kstate.pushMessage(msg('1', 'user', 'x'))
    expect(mirrorFrom(a).messages).toEqual(kernel.kstate.messages)
    expect(mirrorFrom(b).messages).toEqual(kernel.kstate.messages)
  })

  it('stops sending to disconnected ports', () => {
    const { kernel, host } = makeHost()
    const port = mockPort()
    host.attachPort(port)
    port.emit({ type: 'sync' })
    port.disconnect()
    const before = port.sent.length
    kernel.kstate.pushMessage(msg('1', 'user', 'x'))
    expect(port.sent.length).toBe(before)
  })

  it('does not send patches to a port that never synced', () => {
    const { kernel, host } = makeHost()
    const port = mockPort()
    host.attachPort(port)
    kernel.kstate.pushMessage(msg('1', 'user', 'x'))
    expect(port.sent).toEqual([])
  })
})

describe('KernelSyncHost reconnect', () => {
  it('a late port snapshots current state and follows subsequent patches', () => {
    const { kernel, host } = makeHost()
    const first = mockPort()
    host.attachPort(first)
    first.emit({ type: 'sync' })
    kernel.kstate.pushMessage(msg('1', 'user', 'a'))
    first.disconnect()

    // Reason: kernel keeps mutating while no panel is connected
    kernel.kstate.pushMessage(msg('2', 'assistant', 'b'))

    const second = mockPort()
    host.attachPort(second)
    second.emit({ type: 'sync' })
    kernel.kstate.pushMessage(msg('3', 'user', 'c'))

    const mirror = mirrorFrom(second)
    expect(mirror.messages.map(m => m.id)).toEqual(['1', '2', '3'])
    expect(mirror.rev).toBe(kernel.rev)
  })

  it('re-sync on the same port replaces mirror state cleanly', () => {
    const { kernel, host } = makeHost()
    const port = mockPort()
    host.attachPort(port)
    port.emit({ type: 'sync' })
    kernel.kstate.pushMessage(msg('1', 'user', 'a'))
    // Reason: simulated gap recovery — client requests a fresh snapshot
    port.emit({ type: 'sync' })
    const last = port.sent.at(-1) as SyncSnapshot
    expect(last.type).toBe('snapshot')
    expect(last.rev).toBe(kernel.rev)
    expect(last.messages.map(m => m.id)).toEqual(['1'])
  })
})

describe('KernelSyncHost commands', () => {
  it('dispatches a command once and dedups retries by id', () => {
    const send = vi.fn()
    const { host } = makeHost({ send })
    const port = mockPort()
    host.attachPort(port)
    port.emit({ type: 'cmd', id: 'c1', name: 'send', args: { text: 'hi' } })
    port.emit({ type: 'cmd', id: 'c1', name: 'send', args: { text: 'hi' } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ text: 'hi' })
  })

  it('ignores unknown command names', () => {
    const { host } = makeHost({})
    const port = mockPort()
    host.attachPort(port)
    expect(() => port.emit({ type: 'cmd', id: 'c2', name: 'nope', args: {} })).not.toThrow()
  })
})

describe('KernelSyncHost throttling', () => {
  it('coalesces rapid mutations into one trailing patch', () => {
    vi.useFakeTimers()
    try {
      const kernel = new SidekickKernel({ getSessionId: () => 's1' })
      const host = new KernelSyncHost(kernel, { throttleMs: 80 })
      const port = mockPort()
      host.attachPort(port)
      port.emit({ type: 'sync' })

      for (let i = 0; i < 10; i++) kernel.kstate.pushMessage(msg(`${i}`, 'user', 'x'))
      // Reason: the leading dispatch waits for the next macrotask, so a burst
      // publishes nothing until the timer runs
      const midway = port.sent.length
      expect(midway).toBeLessThanOrEqual(2)

      vi.advanceTimersByTime(100)
      const mirror = mirrorFrom(port)
      expect(mirror.messages).toHaveLength(10)
      expect(mirror.rev).toBe(kernel.rev)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes the settled state of a one-tick burst, never the intermediate one', async () => {
    const kernel = new SidekickKernel({ getSessionId: () => 's1' })
    const host = new KernelSyncHost(kernel, { throttleMs: 80 })
    const port = mockPort()
    host.attachPort(port)
    port.emit({ type: 'sync' })

    // Reason: the send path writes several fields inside one synchronous block
    // (bubble push → busy flag → SDK status). Publishing after the first write
    // is what made the panel flash the status line out and back in.
    kernel.kstate.pushMessage(msg('1', 'user', 'hi'))
    kernel.kstate.status = 'submitted'
    expect(port.sent).toHaveLength(1) // only the handshake snapshot so far

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(port.sent).toHaveLength(2)
    const patch = port.sent[1] as SyncPatch
    expect(patch.type).toBe('patch')
    expect(patch.status).toBe('submitted')
    expect(patch.changed.map(c => c.message.id)).toEqual(['1'])
    expect(mirrorFrom(port).status).toBe('submitted')
  })
})
