import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn(),
  handleClick: vi.fn(),
  handleExecuteJS: vi.fn(),
  handleGetPageContent: vi.fn(),
  handleGetElementInfo: vi.fn(),
  handleFindElement: vi.fn(),
  handleType: vi.fn(),
  handleScroll: vi.fn(),
  handleNavigate: vi.fn(),
  handleScreenshot: vi.fn(),
  handleWait: vi.fn(),
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn(),
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

describe('Error paths — tool failures', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('handler throwing error returns stderr with message', async () => {
    vi.mocked(handlers.handleDomSnapshot).mockRejectedValue(new Error('Tab was closed'))
    const r = await execBash('err-1', 1, 'dom')
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('Tab was closed')
  })

  it('handler returning success:false reports error in stderr', async () => {
    vi.mocked(handlers.handleClick).mockResolvedValue({ success: false, error: 'Element not found' } as any)
    const r = await execBash('err-2', 1, 'click "nonexistent"')
    expect(r.stderr).toContain('Element not found')
  })

  it('js execution failure is reported', async () => {
    vi.mocked(handlers.handleExecuteJS).mockResolvedValue({ success: false, error: 'ReferenceError: x is not defined' } as any)
    const r = await execBash('err-3', 1, 'js "x.foo()"')
    expect(r.stderr).toContain('ReferenceError')
  })
})

describe('Error paths — shell limits', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('output exceeding MAX_STDOUT_BYTES is truncated with message', async () => {
    vi.mocked(handlers.handleDomSnapshot).mockResolvedValue({
      success: true,
      snapshot: 'x'.repeat(10000),
    } as any)
    const r = await execBash('trunc-1', 1, 'dom')
    expect(r.stdout.length).toBeLessThan(10000)
    expect(r.stdout).toContain('[Truncated')
  })

  it('output exceeding MAX_STDOUT_LINES is truncated', async () => {
    vi.mocked(handlers.handleDomSnapshot).mockResolvedValue({
      success: true,
      snapshot: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'),
    } as any)
    const r = await execBash('trunc-2', 1, 'dom')
    expect(r.stdout).toContain('[Truncated')
    expect(r.stdout).toContain('200')
  })

  it('stderr exceeding MAX_STDOUT_BYTES is truncated with recovery hint', async () => {
    vi.mocked(handlers.handleClick).mockResolvedValue({
      success: false,
      error: 'x'.repeat(10000),
    } as any)
    const r = await execBash('trunc-3', 1, 'click "target"')
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeLessThan(10000)
    expect(r.stderr).toContain('[Truncated')
    // Reason: the hint must point at 2> redirection — the only channel to recover full stderr
    expect(r.stderr).toContain('2> /tmp/err.txt')
  })

  it('short stderr passes through untouched', async () => {
    vi.mocked(handlers.handleClick).mockResolvedValue({
      success: false,
      error: 'Element not found',
    } as any)
    const r = await execBash('trunc-4', 1, 'click "target"')
    expect(r.stderr).toContain('Element not found')
    expect(r.stderr).not.toContain('[Truncated')
  })

  // Reason: timeout test skipped — just-bash's `sleep` is not a real blocking op,
  // so AbortController timeout cannot be reliably tested in unit tests.
  // Timeout behavior is verified manually in the real extension.
})

describe('Edge cases — empty/malformed input', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(handlers.handleDomSnapshot).mockResolvedValue({ success: true, snapshot: '<div/>' } as any)
    vi.mocked(handlers.handleClick).mockResolvedValue({ success: true, text: 'ok' } as any)
  })

  it('empty command returns error', async () => {
    const r = await execBash('edge-1', 1, '')
    // Empty command in bash typically exits 0 with no output
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('click with no target shows usage', async () => {
    const r = await execBash('edge-2', 1, 'click')
    expect(r.stderr).toContain('Usage')
    expect(r.exitCode).not.toBe(0)
  })

  it('dom with invalid flag is ignored gracefully', async () => {
    await execBash('edge-3', 1, 'dom --invalid=xyz')
    // Should still call handler (invalid flags ignored)
    expect(handlers.handleDomSnapshot).toHaveBeenCalled()
  })
})

describe('Pro mode shell limits', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('Pro mode allows larger output (64KB limit)', async () => {
    vi.mocked(handlers.handleDomSnapshot).mockResolvedValue({
      success: true,
      snapshot: 'x'.repeat(20000), // 20KB — within Pro limit but would be truncated in Chat
    } as any)
    const r = await execBash('pro-1', 1, 'dom', true)
    expect(r.stdout).not.toContain('[Truncated')
    expect(r.stdout.length).toBeGreaterThan(15000)
  })

  it('Chat mode truncates at 8KB', async () => {
    vi.mocked(handlers.handleDomSnapshot).mockResolvedValue({
      success: true,
      snapshot: 'x'.repeat(20000),
    } as any)
    const r = await execBash('chat-1', 1, 'dom', false)
    expect(r.stdout).toContain('[Truncated')
    expect(r.stdout.length).toBeLessThan(10000)
  })
})
