import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: '' }),
  handleClick: vi.fn().mockResolvedValue({ success: true, text: 'ok' }),
  handleExecuteJS: vi.fn().mockResolvedValue({ success: true, result: '' }),
  handleGetPageContent: vi.fn().mockResolvedValue({ success: true, html: '' }),
  handleGetElementInfo: vi.fn().mockResolvedValue({ success: true }),
  handleFindElement: vi.fn().mockResolvedValue({ success: true, output: '', count: 0 }),
  handleType: vi.fn().mockResolvedValue({ success: true }),
  handleScroll: vi.fn().mockResolvedValue({ success: true }),
  handleNavigate: vi.fn().mockResolvedValue({ success: true }),
  handleScreenshot: vi.fn().mockResolvedValue({ success: true, dataUrl: '' }),
  handleWait: vi.fn().mockResolvedValue({ success: true }),
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn(),
}))

import { createPageCommands } from '../../src/background/shell-commands'
import * as handlers from '../../src/background/tool-handlers'

describe('locate command', () => {
  let bash: Bash

  beforeEach(() => {
    bash = new Bash({
      files: {},
      cwd: '/',
      customCommands: createPageCommands(1),
    })
    vi.clearAllMocks()
  })

  it('locates element and returns position info', async () => {
    vi.mocked(handlers.execInTab).mockResolvedValue({
      success: true,
      selector: '#submit-btn',
      visible: true,
      obscured: false,
      x: 450, y: 320, width: 120, height: 40,
    })
    const r = await bash.exec('locate "#submit-btn"')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('#submit-btn')
    expect(r.stdout).toContain('Visible: true')
    expect(r.stdout).toContain('(450, 320)')
    expect(r.stdout).toContain('120×40')
  })

  it('quiet mode outputs only selector', async () => {
    vi.mocked(handlers.execInTab).mockResolvedValue({
      success: true, selector: '#btn', visible: true, obscured: false, x: 0, y: 0, width: 100, height: 40,
    })
    const r = await bash.exec('locate "#btn" -q')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('#btn')
  })

  it('pipe: locate -q | click', async () => {
    vi.mocked(handlers.execInTab).mockResolvedValue({
      success: true, selector: '#target', visible: true, obscured: false, x: 0, y: 0, width: 100, height: 40,
    })
    vi.mocked(handlers.handleClick).mockResolvedValue({ success: true, text: 'clicked' } as any)
    const r = await bash.exec('locate "#target" -q | click')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '#target' }))
  })

  it('reports obscured element', async () => {
    vi.mocked(handlers.execInTab).mockResolvedValue({
      success: true, selector: '#hidden', visible: true, obscured: true, obscuredBy: 'div.modal',
      x: 100, y: 200, width: 80, height: 30,
    })
    const r = await bash.exec('locate "#hidden"')
    expect(r.stdout).toContain('obscured by div.modal')
  })

  it('returns error when element not found', async () => {
    vi.mocked(handlers.execInTab).mockResolvedValue({
      success: false, error: 'Element not found: #nonexistent',
    })
    const r = await bash.exec('locate "#nonexistent"')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('not found')
  })

  it('resolves text target (not just CSS selector)', async () => {
    vi.mocked(handlers.execInTab).mockResolvedValue({
      success: true, selector: 'button', visible: true, obscured: false, x: 50, y: 60, width: 80, height: 32,
    })
    const r = await bash.exec('locate "Submit"')
    expect(r.exitCode).toBe(0)
    expect(handlers.execInTab).toHaveBeenCalledWith(1, expect.any(Function), ['Submit'])
  })

  it('reads selector from stdin', async () => {
    vi.mocked(handlers.execInTab).mockResolvedValue({
      success: true, selector: '.piped', visible: true, obscured: false, x: 0, y: 0, width: 50, height: 50,
    })
    const r = await bash.exec('echo ".piped" | locate -q')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('.piped')
  })

  it('no args and no stdin shows usage', async () => {
    const r = await bash.exec('locate')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Usage')
  })
})
