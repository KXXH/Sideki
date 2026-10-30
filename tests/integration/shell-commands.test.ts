import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: '<div>\n  <button>Submit</button>\n</div>' }),
  handleGetPageContent: vi.fn().mockResolvedValue({ success: true, html: '<p>page content</p>' }),
  handleGetElementInfo: vi.fn().mockResolvedValue({
    success: true, tagName: 'BUTTON', text: 'Submit', visible: true,
    boundingRect: { x: 10, y: 20, width: 100, height: 40 },
  }),
  handleFindElement: vi.fn().mockResolvedValue({
    success: true, output: '✓ /body/button  button "Submit"  → button.submit\n✓ /body/button  button "Cancel"  → button.cancel',
    selectors: ['button.submit', 'button.cancel'], count: 2,
  }),
  handleExecuteJS: vi.fn().mockResolvedValue({ success: true, result: '42' }),
  handleClick: vi.fn().mockResolvedValue({ success: true, text: 'Submit' }),
  handleType: vi.fn().mockResolvedValue({ success: true }),
  handleScroll: vi.fn().mockResolvedValue({ success: true }),
  handleNavigate: vi.fn().mockResolvedValue({ success: true }),
  handleScreenshot: vi.fn().mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,abc' }),
  handleWait: vi.fn().mockResolvedValue({ success: true }),
  INJECT_HEADROOM_MS: 1500,
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn().mockResolvedValue({ success: true }),
}))

// Reason: http-put gates on labFetch — default to enabled, cases override
vi.mock('../../src/shared/storage', () => ({
  loadConfig: vi.fn().mockResolvedValue({ labFetch: true }),
}))

import { createPageCommands } from '../../src/background/shell-commands'
import {
  handleDomSnapshot, handleGetPageContent, handleGetElementInfo,
  handleFindElement, handleExecuteJS, handleClick, handleType,
  handleScroll, handleNavigate, handleScreenshot, handleWait,
  requireConsent,
} from '../../src/background/tool-handlers'
import { loadConfig } from '../../src/shared/storage'

function makeBash() {
  return new Bash({ files: {}, cwd: '/', customCommands: createPageCommands(1) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireConsent).mockResolvedValue(true)
  vi.mocked(loadConfig).mockResolvedValue({ labFetch: true } as never)
})

describe('Page commands (shell-commands)', () => {
  describe('dom', () => {
    it('calls handleDomSnapshot and returns snapshot', async () => {
      const bash = makeBash()
      const r = await bash.exec('dom')
      expect(handleDomSnapshot).toHaveBeenCalledWith(1, expect.objectContaining({ maxNodes: Infinity }))
      expect(r.stdout).toContain('<div>')
      expect(r.stdout).toContain('<button>Submit</button>')
      expect(r.exitCode).toBe(0)
    })

    it('dom --all passes includeAll=true', async () => {
      const bash = makeBash()
      await bash.exec('dom --all')
      expect(handleDomSnapshot).toHaveBeenCalledWith(1, expect.objectContaining({ includeAll: true }))
    })

    it('dom --root=nav passes root="nav"', async () => {
      const bash = makeBash()
      await bash.exec('dom --root=nav')
      expect(handleDomSnapshot).toHaveBeenCalledWith(1, expect.objectContaining({ root: 'nav' }))
    })

    it('dom --flat passes flat=true', async () => {
      const bash = makeBash()
      await bash.exec('dom --flat')
      expect(handleDomSnapshot).toHaveBeenCalledWith(1, expect.objectContaining({ flat: true }))
    })
  })

  describe('page-content', () => {
    it('calls handleGetPageContent and returns content', async () => {
      // Reason: page-content runs executeScript to convert HTML→text;
      // mock it to return the plain text extraction result
      vi.mocked(chrome.scripting.executeScript as Function).mockResolvedValueOnce([{ result: 'page content' }])
      const bash = makeBash()
      const r = await bash.exec('page-content')
      expect(handleGetPageContent).toHaveBeenCalledWith(1, expect.objectContaining({}))
      expect(r.stdout).toContain('page content')
      expect(r.exitCode).toBe(0)
    })

    it('page-content --html returns raw html', async () => {
      const bash = makeBash()
      const r = await bash.exec('page-content --html')
      expect(r.stdout).toContain('<p>page content</p>')
      expect(r.exitCode).toBe(0)
    })
  })

  describe('element-info', () => {
    it('calls handleGetElementInfo with target', async () => {
      const bash = makeBash()
      const r = await bash.exec('element-info "button"')
      expect(handleGetElementInfo).toHaveBeenCalledWith(1, { target: 'button' })
      expect(r.stdout).toContain('Tag: BUTTON')
      expect(r.stdout).toContain('Text: Submit')
      expect(r.exitCode).toBe(0)
    })
  })

  describe('find-element', () => {
    it('calls handleFindElement with text', async () => {
      const bash = makeBash()
      const r = await bash.exec('find-element "Submit"')
      expect(handleFindElement).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Submit' }))
      expect(r.stdout).toContain('button.submit')
      expect(r.stderr).toContain('button "Submit"')
      expect(r.exitCode).toBe(0)
    })

    it('find-element --selector=".btn" passes selector', async () => {
      const bash = makeBash()
      await bash.exec('find-element --selector=".btn"')
      expect(handleFindElement).toHaveBeenCalledWith(1, expect.objectContaining({ selector: '.btn' }))
    })
  })

  describe('js', () => {
    it('calls handleExecuteJS and requires consent', async () => {
      const bash = makeBash()
      const r = await bash.exec('js "1+1"')
      expect(requireConsent).toHaveBeenCalledWith('js', '1+1', 1)
      expect(handleExecuteJS).toHaveBeenCalledWith(1, expect.objectContaining({ code: '1+1' }))
      expect(r.stdout).toContain('42')
      expect(r.exitCode).toBe(0)
    })

    it('js --b decodes base64 with non-ASCII payload as UTF-8', async () => {
      const bash = makeBash()
      // Reason: atob returns latin1 bytes — without UTF-8 decoding CJK turns to mojibake
      const b64 = Buffer.from('console.log("中文测试")').toString('base64')
      const r = await bash.exec(`echo "${b64}" | js --b`)
      expect(r.exitCode).toBe(0)
      expect(handleExecuteJS).toHaveBeenCalledWith(1, expect.objectContaining({ code: 'console.log("中文测试")' }))
    })

    it('js --b rejects invalid base64', async () => {
      const bash = makeBash()
      const r = await bash.exec('js --b "not-valid-base64!!!"')
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Invalid base64')
    })
  })

  describe('click', () => {
    it('requires consent and calls handleClick', async () => {
      const bash = makeBash()
      const r = await bash.exec('click "Submit"')
      expect(requireConsent).toHaveBeenCalledWith('click', 'Submit', 1, { tabId: 1, target: 'Submit' })
      expect(handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ target: 'Submit' }))
      expect(r.stdout).toContain('Clicked: Submit')
      expect(r.exitCode).toBe(0)
    })

    it('click --real passes real=true', async () => {
      const bash = makeBash()
      await bash.exec('click "Submit" --real')
      expect(handleClick).toHaveBeenCalledWith(1, expect.objectContaining({ real: true }))
    })
  })

  describe('type-text', () => {
    it('requires consent and calls handleType', async () => {
      const bash = makeBash()
      const r = await bash.exec('type-text "input" "hello"')
      expect(requireConsent).toHaveBeenCalledWith('type', 'input: "hello"', 1, { tabId: 1, target: 'input' })
      expect(handleType).toHaveBeenCalledWith(1, expect.objectContaining({
        target: 'input', text: 'hello', clear: true,
      }))
      expect(r.stdout).toContain('OK')
      expect(r.exitCode).toBe(0)
    })
  })

  describe('navigate', () => {
    it('requires consent and calls handleNavigate', async () => {
      const bash = makeBash()
      const r = await bash.exec('navigate "https://example.com"')
      expect(requireConsent).toHaveBeenCalledWith('navigate', 'https://example.com', 1)
      expect(handleNavigate).toHaveBeenCalledWith(1, { url: 'https://example.com' })
      expect(r.stdout).toContain('Navigated to https://example.com')
      expect(r.exitCode).toBe(0)
    })
  })

  describe('scroll', () => {
    it('requires consent and calls handleScroll', async () => {
      const bash = makeBash()
      const r = await bash.exec('scroll down')
      expect(requireConsent).toHaveBeenCalledWith('scroll', 'down 500px', 1)
      expect(handleScroll).toHaveBeenCalledWith(1, expect.objectContaining({ direction: 'down', amount: 500 }))
      expect(r.stdout).toContain('Scrolled down 500px')
      expect(r.exitCode).toBe(0)
    })
  })

  describe('screenshot', () => {
    it('calls handleScreenshot', async () => {
      const bash = makeBash()
      const r = await bash.exec('screenshot')
      expect(handleScreenshot).toHaveBeenCalledWith(1, expect.objectContaining({}))
      expect(r.stdout).toContain('Screenshot captured')
      expect(r.exitCode).toBe(0)
    })

    it('forwards sessionId for the labImageFs VFS mirror', async () => {
      const bash = new Bash({ files: {}, cwd: '/', customCommands: createPageCommands(1, 'chat', undefined, 'sess-1') })
      await bash.exec('screenshot')
      expect(handleScreenshot).toHaveBeenCalledWith(1, expect.objectContaining({ sessionId: 'sess-1' }))
    })

    it('surfaces the mirror path from handleScreenshot message', async () => {
      vi.mocked(handleScreenshot).mockResolvedValueOnce({
        success: true, message: 'Screenshot captured. Saved: /tmp/screenshots/1-000.jpeg (42KB)', dataUrl: 'data:image/jpeg;base64,abc',
      } as never)
      const bash = makeBash()
      const r = await bash.exec('screenshot')
      expect(r.stdout).toContain('Saved: /tmp/screenshots/1-000.jpeg')
    })
  })

  describe('http-put', () => {
    // Reason: 16-byte full-range sample (0x00, high bytes, valid/invalid UTF-8
    // sequences) — the exact corruption class that broke curl's binary body
    const BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x7f, 0xe4, 0xb8, 0xad, 0x01]
    const B64 = 'iVBORw0KGgoA/4B/5LitAQ=='

    function stubFetch(status = 200, body = '{"ok":true}') {
      const captured: { url?: string; init?: RequestInit } = {}
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        captured.url = url
        captured.init = init
        return new Response(body, { status })
      }))
      return captured
    }

    it('uploads piped binary bytes intact with method and content-type', async () => {
      const captured = stubFetch()
      const bash = makeBash()
      const r = await bash.exec(`echo "${B64}" | base64 -d | http-put https://oss.example.com/up --type=image/png`)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('HTTP 200')
      expect(captured.url).toBe('https://oss.example.com/up')
      expect(captured.init?.method).toBe('PUT')
      expect((captured.init?.headers as Record<string, string>)['Content-Type']).toBe('image/png')
      const body = captured.init?.body as Uint8Array
      expect(body).toBeInstanceOf(Uint8Array)
      expect(Array.from(body)).toEqual(BYTES)
      expect(requireConsent).toHaveBeenCalledWith('http-put', expect.stringContaining('PUT https://oss.example.com/up'), 1)
      vi.unstubAllGlobals()
    })

    it('supports --method=POST and extra headers', async () => {
      const captured = stubFetch()
      const bash = makeBash()
      await bash.exec(`echo "${B64}" | base64 -d | http-put https://api.example.com/x --method=POST --header="X-Token: abc"`)
      expect(captured.init?.method).toBe('POST')
      const headers = captured.init?.headers as Record<string, string>
      expect(headers['X-Token']).toBe('abc')
      expect(headers['Content-Type']).toBe('application/octet-stream')
      vi.unstubAllGlobals()
    })

    it('fails fast when labFetch is off without calling fetch', async () => {
      vi.mocked(loadConfig).mockResolvedValue({} as never)
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      const bash = makeBash()
      const r = await bash.exec(`echo x | http-put https://oss.example.com/up`)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Network requests are disabled')
      expect(fetchSpy).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('returns exit 1 on non-2xx responses', async () => {
      stubFetch(403, 'AccessDenied')
      const bash = makeBash()
      const r = await bash.exec(`echo x | http-put https://oss.example.com/up`)
      expect(r.exitCode).toBe(1)
      expect(r.stdout).toContain('HTTP 403')
      expect(r.stdout).toContain('AccessDenied')
      vi.unstubAllGlobals()
    })

    it('denies on consent rejection with exit 126', async () => {
      vi.mocked(requireConsent).mockResolvedValue(false)
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      const bash = makeBash()
      const r = await bash.exec(`echo x | http-put https://oss.example.com/up`)
      expect(r.exitCode).toBe(126)
      expect(fetchSpy).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('rejects non-http URLs and disallowed methods', async () => {
      const bash = makeBash()
      const r1 = await bash.exec(`echo x | http-put ftp://x.com/f`)
      expect(r1.exitCode).toBe(1)
      expect(r1.stderr).toContain('http(s)')
      const r2 = await bash.exec(`echo x | http-put https://x.com/f --method=DELETE`)
      expect(r2.exitCode).toBe(1)
      expect(r2.stderr).toContain('PUT and POST')
    })

    it('shows usage without stdin', async () => {
      const bash = makeBash()
      const r = await bash.exec('http-put https://x.com/f')
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Usage:')
    })
  })

  describe('page-wait', () => {
    it('page-wait "target" is consent-free and calls handleWait with target', async () => {
      const bash = makeBash()
      const r = await bash.exec('page-wait ".spinner"')
      expect(requireConsent).not.toHaveBeenCalled()
      expect(handleWait).toHaveBeenCalledWith(1, { target: '.spinner', timeout: 3000, maxMs: 4000 })
      expect(r.stdout).toContain('Found: .spinner')
      expect(r.exitCode).toBe(0)
    })

    it('page-wait "target" --timeout=N passes custom timeout', async () => {
      const bash = makeBash()
      await bash.exec('page-wait ".btn" --timeout=10000')
      expect(handleWait).toHaveBeenCalledWith(1, { target: '.btn', timeout: 10000, maxMs: 4000 })
    })

    it('page-wait --duration=N calls handleWait with duration', async () => {
      const bash = makeBash()
      const r = await bash.exec('page-wait --duration=2000')
      expect(requireConsent).not.toHaveBeenCalled()
      expect(handleWait).toHaveBeenCalledWith(1, { timeout: 5000, duration: 2000 })
      expect(r.stdout).toContain('Waited 2000ms')
      expect(r.exitCode).toBe(0)
    })

    it('page-wait --idle calls execInTab for DOM stabilization', async () => {
      const { execInTab } = await import('../../src/background/tool-handlers')
      vi.mocked(execInTab).mockResolvedValue({ success: true, waited: 120 })
      const bash = makeBash()
      const r = await bash.exec('page-wait --idle')
      expect(requireConsent).not.toHaveBeenCalled()
      expect(execInTab).toHaveBeenCalledWith(1, expect.any(Function), [3000], undefined, 4500)
      expect(r.stdout).toContain('Idle after 120ms')
      expect(r.exitCode).toBe(0)
    })

    it('page-wait --idle --timeout=N passes custom timeout to execInTab', async () => {
      const { execInTab } = await import('../../src/background/tool-handlers')
      vi.mocked(execInTab).mockResolvedValue({ success: true, waited: 50 })
      const bash = makeBash()
      await bash.exec('page-wait --idle --timeout=5000')
      expect(execInTab).toHaveBeenCalledWith(1, expect.any(Function), [5000], undefined, 6500)
    })

    it('page-wait with no args returns usage error', async () => {
      const bash = makeBash()
      const r = await bash.exec('page-wait')
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Usage:')
    })

    it('page-wait reads target from stdin', async () => {
      const bash = makeBash()
      const r = await bash.exec('echo ".modal" | page-wait')
      expect(handleWait).toHaveBeenCalledWith(1, { target: '.modal', timeout: 3000, maxMs: 4000 })
      expect(r.stdout).toContain('Found: .modal')
      expect(r.exitCode).toBe(0)
    })
  })

  describe('consent denied', () => {
    it('returns exit code 126 and denied message', async () => {
      vi.mocked(requireConsent).mockResolvedValue(false)
      const bash = makeBash()
      const r = await bash.exec('click "Submit"')
      expect(r.exitCode).toBe(126)
      expect(r.stderr).toContain('denied')
    })
  })
})
