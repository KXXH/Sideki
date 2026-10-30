import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/background/shell', () => ({
  KEEP_SCREENSHOTS: 5,
  execBash: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
  mirrorScreenshotToVfs: vi.fn(),
}))

import { execBash } from '../../src/background/shell'
import { handleToolMessage } from '../../src/background/tool-handlers'

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
})
