import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncSnapshot } from '../../src/shared/kernel/sync-protocol'

const harness = vi.hoisted(() => ({ effects: [] as Array<() => (() => void) | undefined> }))
vi.mock('react', () => ({
  useState: <T,>(value: T) => [value, vi.fn()],
  useRef: <T,>(value: T) => ({ current: value }),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => (() => void) | undefined) => harness.effects.push(effect),
}))

import { useKernelMirror } from '../../src/sidepanel/hooks/useKernelMirror'

let receive!: (message: SyncSnapshot) => void
let disconnect!: () => void
let cleanup: (() => void) | undefined
const postMessage = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  harness.effects = []
  postMessage.mockReset()
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: {
      ...chrome.runtime,
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      connect: () => ({
        postMessage, disconnect: vi.fn(),
        onMessage: { addListener: (listener: typeof receive) => { receive = listener } },
        onDisconnect: { addListener: (listener: () => void) => { disconnect = listener } },
      }),
    },
  })
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
})

function snapshot(sessionId: string): SyncSnapshot {
  return { type: 'snapshot', sessionId, rev: 0, messages: [], status: 'ready', errorMessage: undefined, queue: [], compacting: false, preparing: false, dispatching: false }
}

async function connectedMirror() {
  const mirror = useKernelMirror(true) // eslint-disable-line react-hooks/rules-of-hooks -- Reason: React hooks are mocked by this harness.
  cleanup = harness.effects[0]()
  await Promise.resolve()
  await Promise.resolve()
  receive(snapshot('s1'))
  return mirror
}

describe('upload first-hop command failures (mocked React hooks)', () => {
  it('throws a disconnected send error instead of dropping it', () => {
    const mirror = useKernelMirror(true)
    expect(() => mirror.cmd('send', { text: 'draft' })).toThrow('后台未连接')
  })

  it('propagates a postMessage size/port failure to the composer', async () => {
    const mirror = await connectedMirror()
    postMessage.mockImplementationOnce(() => { throw new Error('Message length exceeded maximum allowed length') })
    expect(() => mirror.cmd('send', { text: '', attachments: [] })).toThrow('Message length exceeded')
  })

  it('invalidates the captured target as soon as a session switch is requested', async () => {
    const mirror = await connectedMirror()
    const target = mirror.captureSendTarget()
    expect(target.sessionId).toBe('s1')
    mirror.cmd('select-session', { id: 's2' })
    expect(() => target.assertCurrent()).toThrow('发送已取消')
    expect(() => mirror.captureSendTarget()).toThrow('会话正在切换')
    receive(snapshot('s2'))
    expect(() => target.assertCurrent()).toThrow('发送已取消')
    expect(mirror.captureSendTarget().sessionId).toBe('s2')
  })

  it('invalidates an in-flight upload on disconnect and cannot silently send after it', async () => {
    const mirror = await connectedMirror()
    const target = mirror.captureSendTarget()
    disconnect()
    expect(() => target.assertCurrent()).toThrow('后台连接已断开')
    expect(() => mirror.cmd('send', { text: '' })).toThrow('后台未连接')
  })
})
