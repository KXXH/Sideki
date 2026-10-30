import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from 'ai'
import type { Mock } from 'vitest'

vi.mock('../../src/shared/ai-provider', () => ({
  compactContext: vi.fn().mockResolvedValue('SUMMARY'),
}))

import { compactContext } from '../../src/shared/ai-provider'
import { SidekickKernel, COMPACT_MSG_ID, ARCHIVE_KEEP_TURNS } from '../../src/shared/kernel/chat-kernel'
import type { ApiConfig } from '../../src/shared/types'

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage
}

function toolMsg(id: string, toolCallId: string, output: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'dynamic-tool', toolName: 'bash', toolCallId, state: 'output-available', input: {}, output }],
  } as unknown as UIMessage
}

const cfg = { labAutoCompress: true, model: 'test' } as unknown as ApiConfig

function makeKernel(config: ApiConfig | null = cfg, sessionId = 's1') {
  return new SidekickKernel({ getConfig: () => config, getSessionId: () => sessionId })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SidekickKernel.compactNow', () => {
  function seed(k: SidekickKernel) {
    // Reason: 4 user turns — findCompactionCutoff keeps the last 3, cutoff = 2
    k.kstate.messages = [
      msg('1', 'user', 'a'), msg('2', 'assistant', 'b'),
      msg('3', 'user', 'c'), msg('4', 'assistant', 'd'),
      msg('5', 'user', 'e'), msg('6', 'assistant', 'f'),
      msg('7', 'user', 'g'), msg('8', 'assistant', 'h'),
    ]
  }

  it('replaces compressed messages with a summary message and keeps the tail', async () => {
    const k = makeKernel()
    seed(k)
    await k.compactNow()
    expect(compactContext).toHaveBeenCalledWith(cfg, 's1', [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    ])
    const msgs = k.kstate.messages
    expect(msgs).toHaveLength(7)
    expect(msgs[0].id).toBe(COMPACT_MSG_ID)
    expect((msgs[0].parts[0] as { text: string }).text).toBe('SUMMARY')
    expect(msgs.slice(1).map(m => m.id)).toEqual(['3', '4', '5', '6', '7', '8'])
    expect(k.compacting).toBe(false)
    expect(k.lastCompactionAt).toBeGreaterThan(0)
  })

  it('appends compressed messages to session history storage', async () => {
    const k = makeKernel()
    seed(k)
    await k.compactNow()
    const setMock = chrome.storage.local.set as Mock
    const arg = setMock.mock.calls.at(-1)![0] as Record<string, Array<{ compressedMessages: unknown[]; marker: { summary: string } }>>
    const entries = arg['history:s1']
    expect(entries).toHaveLength(1)
    expect(entries[0].compressedMessages).toHaveLength(2)
    expect(entries[0].marker.summary).toBe('SUMMARY')
  })

  it('keeps the request and history on the originating session when the active ID changes', async () => {
    let sessionId = 's1'
    const k = new SidekickKernel({ getConfig: () => cfg, getSessionId: () => sessionId })
    seed(k)
    vi.mocked(compactContext).mockImplementationOnce(async () => {
      sessionId = 's2'
      return 'SUMMARY'
    })
    await k.compactNow()
    expect(compactContext).toHaveBeenCalledWith(cfg, 's1', expect.any(Array))
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ 'history:s1': expect.any(Array) })
  })

  it('is a no-op when status is not ready, config missing, or too few turns', async () => {
    const k = makeKernel()
    seed(k)
    k.kstate.status = 'streaming'
    await k.compactNow()
    expect(compactContext).not.toHaveBeenCalled()

    const noCfg = makeKernel(null)
    seed(noCfg)
    await noCfg.compactNow()
    expect(compactContext).not.toHaveBeenCalled()

    const short = makeKernel()
    short.kstate.messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b')]
    await short.compactNow()
    expect(compactContext).not.toHaveBeenCalled()
  })

  it('keeps messages intact and clears the flag when the LLM call fails', async () => {
    ;(compactContext as Mock).mockRejectedValueOnce(new Error('llm down'))
    const k = makeKernel()
    seed(k)
    await k.compactNow()
    expect(k.kstate.messages).toHaveLength(8)
    expect(k.compacting).toBe(false)
  })
})

describe('SidekickKernel.archiveNow', () => {
  const bigOutput = 'x'.repeat(600)

  function seed(k: SidekickKernel) {
    // Reason: roles [a,u,a,u,a] — findArchiveCutoff(keepTurns=2) returns 1,
    // so only the leading assistant tool message is archivable
    k.kstate.messages = [
      toolMsg('t1', 'tc1', bigOutput),
      msg('2', 'user', 'a'), msg('3', 'assistant', 'b'),
      msg('4', 'user', 'c'), msg('5', 'assistant', 'd'),
    ]
  }

  it('writes the tool result to VFS and stubs the part output', async () => {
    ;(chrome.runtime.sendMessage as Mock).mockResolvedValue({ success: true })
    const k = makeKernel()
    seed(k)
    await k.archiveNow()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'vfs:write', sessionId: 's1', path: '/context/tool-tc1.txt', content: bigOutput,
    })
    const part = k.kstate.messages[0].parts[0] as { output: string }
    expect(part.output).toMatch(/^\[archived: \/context\/tool-tc1\.txt \| head: x+\]$/)
  })

  it('keeps the original output when the VFS write fails', async () => {
    ;(chrome.runtime.sendMessage as Mock).mockResolvedValue({ success: false })
    const k = makeKernel()
    seed(k)
    await k.archiveNow()
    const part = k.kstate.messages[0].parts[0] as { output: string }
    expect(part.output).toBe(bigOutput)
  })

  it('skips small outputs and already-archived stubs', async () => {
    ;(chrome.runtime.sendMessage as Mock).mockResolvedValue({ success: true })
    const k = makeKernel()
    k.kstate.messages = [
      toolMsg('t1', 'tc1', 'small'),
      toolMsg('t2', 'tc2', '[archived: /context/tool-old.txt | head: y]'),
      msg('3', 'user', 'a'), msg('4', 'assistant', 'b'),
      msg('5', 'user', 'c'), msg('6', 'assistant', 'd'),
    ]
    await k.archiveNow()
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('is a no-op without labAutoCompress or within the protection window', async () => {
    const k = makeKernel({ labAutoCompress: false } as unknown as ApiConfig)
    seed(k)
    await k.archiveNow()
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()

    const k2 = makeKernel()
    // Reason: only 1 user turn — inside the ARCHIVE_KEEP_TURNS protection window
    expect(ARCHIVE_KEEP_TURNS).toBe(2)
    k2.kstate.messages = [toolMsg('t1', 'tc1', bigOutput), msg('2', 'user', 'a')]
    await k2.archiveNow()
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })
})

// Reason: every turn must seed its tab stack before dispatch — a turn without a
// stable tab reference lets tool targeting drift to whatever tab the user
// activates midway, and the UI cannot show the held state.
describe('SidekickKernel turn-start seeding', () => {
  class ProbeKernel extends SidekickKernel {
    order: string[] = []
    protected async performSend(): Promise<void> {
      this.order.push('send')
    }
  }

  function makeProbe(onTurnStart: () => Promise<void>) {
    return new ProbeKernel({ getConfig: () => cfg, getSessionId: () => 's1', onTurnStart })
  }

  it('awaits onTurnStart before dispatching a direct send', async () => {
    const order: string[] = []
    const k = makeProbe(async () => { order.push('seed') })
    await k.handleSend('hi')
    expect([...order, ...k.order]).toEqual(['seed', 'send'])
  })

  it('seeds queued turns too, once per flush', async () => {
    const seeds: number[] = []
    const k = makeProbe(async () => { seeds.push(1) })
    k.kstate.status = 'streaming'
    await k.handleSend('first')
    await k.handleSend('second')
    // Reason: busy kernel queues both; no turn started yet
    expect(seeds).toHaveLength(0)
    expect(k.queue).toHaveLength(2)

    k.kstate.status = 'ready'
    k.kstate.bump()
    await vi.waitFor(() => expect(seeds).toHaveLength(1))
    expect(k.order).toEqual(['send'])
  })

  it('dispatches anyway when seeding rejects', async () => {
    const k = makeProbe(async () => { throw new Error('tab busy') })
    await k.handleSend('hi')
    expect(k.order).toEqual(['send'])
  })
})
