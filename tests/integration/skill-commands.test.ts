import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'

vi.mock('../../src/shared/memory-storage', () => ({
  getGlobalMemory: vi.fn().mockResolvedValue(''),
  setGlobalMemory: vi.fn().mockResolvedValue({ ok: true }),
  getSiteMemory: vi.fn().mockResolvedValue(''),
  setSiteMemory: vi.fn().mockResolvedValue({ ok: true }),
  addNote: vi.fn().mockResolvedValue({ id: 'test', content: '', ts: 0 }),
  removeNote: vi.fn().mockResolvedValue(true),
  searchNotes: vi.fn().mockResolvedValue([]),
  getNotes: vi.fn().mockResolvedValue([]),
  getMemoryFiles: vi.fn().mockResolvedValue({}),
  getAllSiteHostnames: vi.fn().mockResolvedValue([]),
  deleteSiteMemory: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: '<div/>' }),
  handleClick: vi.fn().mockResolvedValue({ success: true, text: 'ok' }),
  handleExecuteJS: vi.fn().mockResolvedValue({ success: true, result: '' }),
  handleGetPageContent: vi.fn().mockResolvedValue({ success: true, html: '' }),
  handleGetElementInfo: vi.fn().mockResolvedValue({ success: true }),
  handleFindElement: vi.fn().mockResolvedValue({ success: true, output: '', selectors: [], count: 0 }),
  handleType: vi.fn().mockResolvedValue({ success: true }),
  handleScroll: vi.fn().mockResolvedValue({ success: true }),
  handleNavigate: vi.fn().mockResolvedValue({ success: true }),
  handleScreenshot: vi.fn().mockResolvedValue({ success: true, dataUrl: '' }),
  handleWait: vi.fn().mockResolvedValue({ success: true }),
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn(),
}))

import { createPageCommands } from '../../src/background/shell-commands'

function makeBash() {
  return new Bash({ files: {}, cwd: '/', customCommands: createPageCommands(1) })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('skill command', () => {
  it('skill list returns skill names and descriptions', async () => {
    const bash = makeBash()
    const r = await bash.exec('skill list')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('seo-audit')
    expect(r.stdout).toContain('accessibility')
    expect(r.stdout).toContain('performance')
    expect(r.stdout).toContain('debug')
    expect(r.stdout).toContain('chrome')
  })

  it('skill with no subcommand shows usage', async () => {
    const bash = makeBash()
    const r = await bash.exec('skill')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('skill list')
    expect(r.stderr).toContain('skill create')
  })

  it('skill with unknown subcommand shows usage', async () => {
    const bash = makeBash()
    const r = await bash.exec('skill unknown')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('skill list')
  })
})

describe('useSkill bash command', () => {
  it('returns guidance to use the native tool instead', async () => {
    const bash = makeBash()
    const r = await bash.exec('useSkill')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('native tool')
    expect(r.stderr).toContain('useSkill tool directly')
  })
})
