import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendToolMessage, setLockedTabId, setFallbackTabProvider } from '../../src/shared/tools/bridge'

// Reason: offscreen documents only expose chrome.runtime — sendToolMessage
// must survive environments where chrome.tabs is undefined.
const realChrome = globalThis.chrome

function stubChrome(withTabs: boolean) {
  const sendMessage = vi.fn().mockImplementation(async (msg: { type: string }) => {
    if (msg.type === 'env:active-tab') return { tabId: 77 }
    return { success: true, echo: msg }
  })
  const stub: Record<string, unknown> = {
    runtime: { sendMessage, lastError: null },
  }
  if (withTabs) {
    stub.tabs = { query: vi.fn().mockResolvedValue([{ id: 5, active: true }]) }
  }
  vi.stubGlobal('chrome', stub)
  return { sendMessage }
}

beforeEach(() => {
  setLockedTabId(null)
  setFallbackTabProvider(null)
})

afterEach(() => {
  vi.stubGlobal('chrome', realChrome)
})

describe('sendToolMessage tab resolution', () => {
  it('uses chrome.tabs.query when available (panel environment)', async () => {
    const { sendMessage } = stubChrome(true)
    await sendToolMessage('click', { target: 'x' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 5 })
  })

  it('falls back to the injected provider when chrome.tabs is missing (offscreen)', async () => {
    const { sendMessage } = stubChrome(false)
    setFallbackTabProvider(() => 42)
    await sendToolMessage('click', { target: 'x' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 42 })
  })

  it('falls back to env:active-tab when no provider is set (offscreen cold path)', async () => {
    const { sendMessage } = stubChrome(false)
    await sendToolMessage('click', { target: 'x' })
    expect(sendMessage).toHaveBeenCalledWith({ type: 'env:active-tab' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 77 })
  })

  it('locked tab id always wins', async () => {
    const { sendMessage } = stubChrome(false)
    setLockedTabId(9)
    setFallbackTabProvider(() => 42)
    await sendToolMessage('click', { target: 'x' })
    const call = sendMessage.mock.calls.find(c => (c[0] as { type: string }).type === 'tool:click')
    expect(call![0]).toMatchObject({ tabId: 9 })
  })

  it('throws a clear error when no tab can be resolved', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ tabId: null })
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: null } })
    await expect(sendToolMessage('click', { target: 'x' })).rejects.toThrow('No active tab found')
  })
})

describe('kernel compact history append without chrome.storage', () => {
  it('routes history persistence through env:history-append', async () => {
    vi.resetModules()
    vi.doMock('../../src/shared/ai-provider', () => ({
      compactContext: vi.fn().mockResolvedValue('SUMMARY'),
    }))
    const { SidekickKernel } = await import('../../src/shared/kernel/chat-kernel')
    const sendMessage = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: null } })

    const k = new SidekickKernel({
      getConfig: () => ({ model: 'test' }) as never,
      getSessionId: () => 's1',
    })
    k.kstate.messages = Array.from({ length: 8 }, (_, i) => ({
      id: `${i}`, role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `m${i}` }],
    })) as never
    await k.compactNow()
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'env:history-append', key: 'history:s1' }),
    )
    expect(k.kstate.messages[0].id).toBe('__context_summary__')
    vi.doUnmock('../../src/shared/ai-provider')
  })
})

describe('loadUserSkills without chrome.storage (offscreen)', () => {
  it('falls back to env:get-user-skills proxy', async () => {
    vi.resetModules()
    const sendMessage = vi.fn().mockResolvedValue({
      userSkills: {
        'my-skill': { description: 'a user skill', content: 'body text', createdAt: 1 },
      },
    })
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: null } })
    const { loadUserSkills, skillRegistry } = await import('../../src/shared/skills')
    await loadUserSkills()
    expect(sendMessage).toHaveBeenCalledWith({ type: 'env:get-user-skills' })
    expect(skillRegistry.get('my-skill')).toMatchObject({ isUser: true, content: 'body text' })
  })

  it('uses chrome.storage.local directly when available (panel/SW)', async () => {
    vi.resetModules()
    const get = vi.fn().mockResolvedValue({
      userSkills: { 'local-skill': { description: 'd', content: 'c', createdAt: 1 } },
    })
    const sendMessage = vi.fn()
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: null }, storage: { local: { get } } })
    const { loadUserSkills, skillRegistry } = await import('../../src/shared/skills')
    await loadUserSkills()
    expect(get).toHaveBeenCalledWith('userSkills')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(skillRegistry.get('local-skill')).toMatchObject({ isUser: true })
  })
})


it('never falls back from a missing scheduled target to the active tab', async () => {
  const { sendMessage } = stubChrome(true)
  await expect(sendToolMessage('click', { target: 'x' }, undefined, {
    getSessionId: () => 'scheduled-session', getTabId: () => 42, isPinned: () => true,
  })).rejects.toThrow('目标页面不可用')
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'env:operating-tab', anchorTabId: 42, pinned: true, strict: true }))
  expect(sendMessage.mock.calls.some(call => call[0].type === 'tool:click')).toBe(false)
  expect(chrome.tabs.query).not.toHaveBeenCalled()
})
