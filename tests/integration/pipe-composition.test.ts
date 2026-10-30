import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: '#submit-btn\n.nav-link\n.footer' }),
  handleClick: vi.fn().mockResolvedValue({ success: true, text: 'clicked' }),
  handleExecuteJS: vi.fn().mockResolvedValue({ success: true, result: '42', consoleOutput: '' }),
  handleGetPageContent: vi.fn().mockResolvedValue({ success: true, html: '<p>page</p>' }),
  handleGetElementInfo: vi.fn().mockResolvedValue({ success: true, tagName: 'BUTTON', text: 'Submit', visible: true, boundingRect: { x: 10, y: 20, width: 100, height: 40 } }),
  handleFindElement: vi.fn().mockResolvedValue({ success: true, output: '#submit-btn', count: 1 }),
  handleType: vi.fn().mockResolvedValue({ success: true }),
  handleScroll: vi.fn().mockResolvedValue({ success: true }),
  handleNavigate: vi.fn().mockResolvedValue({ success: true }),
  handleScreenshot: vi.fn().mockResolvedValue({ success: true, dataUrl: 'data:...' }),
  handleWait: vi.fn().mockResolvedValue({ success: true }),
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn().mockResolvedValue({ success: true }),
}))

import { createPageCommands } from '../../src/background/shell-commands'
import * as handlers from '../../src/background/tool-handlers'

describe('Pipe composition — stdin as target', () => {
  let bash: Bash

  beforeEach(() => {
    bash = new Bash({
      files: { '/tmp/.keep': '' },
      cwd: '/',
      customCommands: createPageCommands(1),
    })
    vi.clearAllMocks()
    vi.mocked(handlers.requireConsent).mockResolvedValue(true)
  })

  it('echo selector | click — reads target from stdin', async () => {
    const r = await bash.exec('echo "#submit-btn" | click')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '#submit-btn' }))
  })

  it('echo selector | element-info — reads target from stdin', async () => {
    const r = await bash.exec('echo ".nav-link" | element-info')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleGetElementInfo).toHaveBeenCalledWith(1, { target: '.nav-link' })
  })

  it('echo code | js — reads code from stdin', async () => {
    const r = await bash.exec('echo "document.title" | js')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleExecuteJS).toHaveBeenCalledWith(1, expect.objectContaining({ code: 'document.title' }))
  })

  it('piped non-ASCII code reaches js without mojibake', async () => {
    // Reason: just-bash stdin is latin1-packed UTF-8 bytes — js must decode it
    await bash.exec('echo \'console.log("首批留观 ≥30 分钟 ✅")\' | js')
    expect(handlers.handleExecuteJS).toHaveBeenCalledWith(1, expect.objectContaining({ code: 'console.log("首批留观 ≥30 分钟 ✅")' }))
  })

  it('multiline file with non-ASCII piped to js', async () => {
    await bash.exec('printf \'const msg = "中文测试";\\nconsole.log(msg)\' > /tmp/code.js')
    const r = await bash.exec('cat /tmp/code.js | js')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleExecuteJS).toHaveBeenCalledWith(1, expect.objectContaining({ code: 'const msg = "中文测试";\nconsole.log(msg)' }))
  })

  it('echo url | navigate — reads url from stdin', async () => {
    const r = await bash.exec('echo "https://example.com" | navigate')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleNavigate).toHaveBeenCalledWith(1, { url: 'https://example.com' })
  })

  it('echo selector | screenshot — reads target from stdin', async () => {
    const r = await bash.exec('echo "#hero" | screenshot')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleScreenshot).toHaveBeenCalledWith(1, { target: '#hero' })
  })

  it('find-element outputs can be piped to click', async () => {
    vi.mocked(handlers.handleFindElement).mockResolvedValue({
      success: true, output: '✓ button "Submit" → #submit-btn', selectors: ['#submit-btn'], count: 1,
    } as any)
    const r = await bash.exec('find-element "Submit" | click')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '#submit-btn' }))
  })

  it('file content piped to click', async () => {
    await bash.exec('echo "#saved-selector" > /tmp/target.txt')
    const r = await bash.exec('cat /tmp/target.txt | click')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '#saved-selector' }))
  })

  it('grep output piped to element-info', async () => {
    await bash.exec('echo "#btn-1\n#btn-2\n#btn-3" > /tmp/elements.txt')
    const r = await bash.exec('grep "btn-2" /tmp/elements.txt | element-info')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleGetElementInfo).toHaveBeenCalledWith(1, { target: '#btn-2' })
  })

  it('echo target | type-text "hello" — target from stdin, text from arg', async () => {
    const r = await bash.exec('echo "#input-field" | type-text "hello world"')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleType).toHaveBeenCalledWith(1, expect.objectContaining({ target: '#input-field', text: 'hello world' }))
  })

  it('explicit arg takes precedence over stdin', async () => {
    await bash.exec('echo "stdin-target" | click "explicit-target"')
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: 'explicit-target' }))
  })

  it('multi-line stdin uses only first line', async () => {
    await bash.exec('echo "#first\n#second\n#third" | click')
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '#first' }))
  })

  it('non-ASCII target piped to click survives without mojibake', async () => {
    // Reason: stdinTarget must decode latin1-packed UTF-8 bytes before trim
    await bash.exec('echo \'[aria-label="提交订单"]\' | click')
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '[aria-label="提交订单"]' }))
  })

  it('non-ASCII target ending in multibyte char is not corrupted by trim', async () => {
    // Reason: trailing 0xA0 continuation bytes look like whitespace to trim()
    await bash.exec('printf \'等待确认\' > /tmp/cn-target.txt')
    await bash.exec('cat /tmp/cn-target.txt | click')
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '等待确认' }))
  })

  it('non-ASCII file through head pipe reaches js intact (just-bash >= 3.0.2)', async () => {
    // Reason: 3.0.1 head/tail double-encoded byte-shaped stdin on pipe handoff
    await bash.exec('printf \'console.log("底层路线😀")\' > /tmp/head-code.js')
    const r = await bash.exec('cat /tmp/head-code.js | head -1 | js')
    expect(r.exitCode).toBe(0)
    expect(handlers.handleExecuteJS).toHaveBeenCalledWith(1, expect.objectContaining({ code: 'console.log("底层路线😀")' }))
  })

  it('command substitution passes non-ASCII argv intact (just-bash >= 3.0.2)', async () => {
    // Reason: 3.0.1 $(...) injected latin1-packed bytes into argv
    await bash.exec('printf \'底层路线\' > /tmp/cn-arg.txt')
    await bash.exec('click "$(cat /tmp/cn-arg.txt)"')
    expect(handlers.handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: '底层路线' }))
  })
})
