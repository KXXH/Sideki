import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: '<div>test</div>' }),
  handleClick: vi.fn().mockResolvedValue({ success: true, text: 'clicked' }),
  handleExecuteJS: vi.fn().mockResolvedValue({ success: true, result: '42', consoleOutput: '' }),
  handleGetPageContent: vi.fn().mockResolvedValue({ success: true, html: '<p>page</p>' }),
  handleGetElementInfo: vi.fn().mockResolvedValue({ success: true, tagName: 'DIV' }),
  handleFindElement: vi.fn().mockResolvedValue({ success: true, output: 'found', count: 1 }),
  handleType: vi.fn().mockResolvedValue({ success: true }),
  handleScroll: vi.fn().mockResolvedValue({ success: true }),
  handleNavigate: vi.fn().mockResolvedValue({ success: true }),
  handleScreenshot: vi.fn().mockResolvedValue({ success: true, dataUrl: 'data:...' }),
  handleWait: vi.fn().mockResolvedValue({ success: true }),
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('../../src/shared/shell-storage', () => ({
  loadShellFs: vi.fn().mockResolvedValue(null),
  saveShellFs: vi.fn().mockResolvedValue(undefined),
  deleteShellFs: vi.fn().mockResolvedValue(undefined),
  MAX_SESSION_SIZE_CHAT: 2 * 1024 * 1024,
  MAX_SESSION_SIZE_PRO: 20 * 1024 * 1024,
}))

vi.mock('../../src/shared/memory-storage', () => ({
  getGlobalMemory: vi.fn().mockResolvedValue(''),
  setGlobalMemory: vi.fn().mockResolvedValue({ ok: true }),
  getSiteMemory: vi.fn().mockResolvedValue(''),
  setSiteMemory: vi.fn().mockResolvedValue({ ok: true }),
  addNote: vi.fn().mockResolvedValue({ id: 'test', content: '', ts: 0 }),
  removeNote: vi.fn().mockResolvedValue(true),
  searchNotes: vi.fn().mockResolvedValue([]),
  getNotes: vi.fn().mockResolvedValue([]),
  getMemoryFiles: vi.fn().mockResolvedValue({ '/memory/global.md': '', '/memory/notes.jsonl': '' }),
  getAllSiteHostnames: vi.fn().mockResolvedValue([]),
  deleteSiteMemory: vi.fn().mockResolvedValue(undefined),
}))

import { execBash } from '../../src/background/shell'
import * as handlers from '../../src/background/tool-handlers'

describe('Tab switching — tool execution target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dom executes on the correct tabId after tab switch', async () => {
    // First call on tab 10
    await execBash('session-1', 10, 'dom')
    expect(handlers.handleDomSnapshot).toHaveBeenLastCalledWith(10, expect.anything())

    // Switch to tab 20
    await execBash('session-1', 20, 'dom')
    expect(handlers.handleDomSnapshot).toHaveBeenLastCalledWith(20, expect.anything())
  })

  it('click targets the new tab after switch', async () => {
    await execBash('session-2', 10, 'click "Submit"')
    expect(handlers.handleClick).toHaveBeenLastCalledWith(10, expect.objectContaining({ target: 'Submit' }))

    // Switch tab
    await execBash('session-2', 30, 'click "Cancel"')
    expect(handlers.handleClick).toHaveBeenLastCalledWith(30, expect.objectContaining({ target: 'Cancel' }))
  })

  it('js executes on the new tab after switch', async () => {
    await execBash('session-3', 10, 'js "document.title"')
    expect(handlers.handleExecuteJS).toHaveBeenLastCalledWith(10, expect.objectContaining({ code: 'document.title' }))

    await execBash('session-3', 50, 'js "location.href"')
    expect(handlers.handleExecuteJS).toHaveBeenLastCalledWith(50, expect.objectContaining({ code: 'location.href' }))
  })

  it('switching back to original tab restores correct target', async () => {
    await execBash('session-4', 10, 'dom')
    expect(handlers.handleDomSnapshot).toHaveBeenLastCalledWith(10, expect.anything())

    await execBash('session-4', 20, 'dom')
    expect(handlers.handleDomSnapshot).toHaveBeenLastCalledWith(20, expect.anything())

    // Switch back to tab 10
    await execBash('session-4', 10, 'dom')
    expect(handlers.handleDomSnapshot).toHaveBeenLastCalledWith(10, expect.anything())
  })

  it('files persist across tab switches within same session', async () => {
    await execBash('session-5', 10, 'echo "hello" > /notes/test.txt')
    // Switch tab
    const result = await execBash('session-5', 20, 'cat /notes/test.txt')
    expect(result.stdout).toContain('hello')
  })

  it('different sessions are isolated even on same tab', async () => {
    await execBash('session-A', 10, 'echo "A-data" > /notes/file.txt')
    await execBash('session-B', 10, 'echo "B-data" > /notes/file.txt')

    const rA = await execBash('session-A', 10, 'cat /notes/file.txt')
    const rB = await execBash('session-B', 10, 'cat /notes/file.txt')
    expect(rA.stdout).toContain('A-data')
    expect(rB.stdout).toContain('B-data')
  })

  it('rapid tab switches do not corrupt sequential commands', async () => {
    // Simulate rapid switching: tab 10 → 20 → 30 → 10
    await execBash('session-6', 10, 'dom')
    await execBash('session-6', 20, 'dom')
    await execBash('session-6', 30, 'dom')
    await execBash('session-6', 10, 'dom')

    const calls = vi.mocked(handlers.handleDomSnapshot).mock.calls
    expect(calls[0][0]).toBe(10)
    expect(calls[1][0]).toBe(20)
    expect(calls[2][0]).toBe(30)
    expect(calls[3][0]).toBe(10)
  })
})
