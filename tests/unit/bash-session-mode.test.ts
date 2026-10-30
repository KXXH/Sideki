import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/background/shell', () => ({
  KEEP_SCREENSHOTS: 5,
  execBash: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
  mirrorScreenshotToVfs: vi.fn(),
}))

import { execBash } from '../../src/background/shell'
import { handleToolMessage, requireConsent } from '../../src/background/tool-handlers'
import type { ExecutionApproval } from '../../src/shared/approval-types'

describe('bash capability mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
      if (Array.isArray(key) && key.includes('sidekick_session_index')) {
        return {
          sidekick_session_index: [
            { id: 'chat-s', title: 'Chat', createdAt: 1, updatedAt: 1, mode: 'chat', messageCount: 0 },
            { id: 'pro-s', title: 'Pro', createdAt: 1, updatedAt: 1, mode: 'pro', messageCount: 0 },
          ],
        }
      }
      if (key === 'sidekick_config') return { sidekick_config: { yoloMode: true } }
      return {}
    })
  })

  it('does not give chat sessions pro bash capabilities even when yoloMode is on', async () => {
    await handleToolMessage('tool:bash', 1, { sessionId: 'chat-s', command: 'debug' })
    expect(execBash).toHaveBeenCalledWith('chat-s', 1, 'debug', false)
  })

  it('gives pro sessions pro bash capabilities', async () => {
    await handleToolMessage('tool:bash', 1, { sessionId: 'pro-s', command: 'debug' })
    expect(execBash).toHaveBeenCalledWith('pro-s', 1, 'debug', true)
  })

  it('passes the owning call capability into Bash without using a model-supplied session', async () => {
    const authorization: ExecutionApproval = { mode: 'auto', sessionId: 'chat-s', toolCallId: 'call', isActive: () => true }
    await handleToolMessage('tool:bash', 1, { sessionId: 'pro-s', command: 'echo ok' }, authorization)
    expect(execBash).toHaveBeenCalledWith('chat-s', 1, 'echo ok', false, authorization)
  })

  it('keeps manual and automatic consent scopes isolated despite legacy full access', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, windowId: 2, url: 'https://example.test' } as chrome.tabs.Tab)
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ granted: true })
    const scope = (mode: 'ask' | 'auto'): ExecutionApproval => ({ mode, sessionId: mode, toolCallId: mode, isActive: () => true })
    expect(await Promise.all([
      requireConsent('js', 'read()', 1, undefined, scope('ask')),
      requireConsent('js', 'read()', 1, undefined, scope('auto')),
    ])).toEqual([true, true])
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'request-action-consent' }))
  })

  it('does not honor a human answer arriving after call cancellation', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, windowId: 2, url: 'https://example.test' } as chrome.tabs.Tab)
    let answer!: (value: { granted: boolean }) => void
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(resolve => { answer = resolve }))
    let active = true
    const authorization: ExecutionApproval = { mode: 'ask', sessionId: 's', toolCallId: 'c', isActive: () => active }
    const pending = requireConsent('js', 'read()', 1, undefined, authorization)
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    active = false
    answer({ granted: true })
    expect(await pending).toBe(false)
  })
})
