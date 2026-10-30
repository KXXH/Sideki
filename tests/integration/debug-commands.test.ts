import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'

vi.mock('../../src/background/debug-session', () => ({
  debugSession: {
    isAttached: vi.fn().mockReturnValue(true),
    attach: vi.fn().mockResolvedValue(undefined),
    getComputedStyles: vi.fn().mockResolvedValue({ display: 'flex', width: '200px', height: '40px' }),
    getEventListeners: vi.fn().mockResolvedValue([
      { type: 'click', handler: 'function() {}', scriptId: '42', lineNumber: 10 },
    ]),
    getBoxModel: vi.fn().mockResolvedValue({
      content: [0, 0, 200, 40], padding: [0, 0, 200, 40],
      border: [0, 0, 200, 40], margin: [0, 0, 200, 40],
      width: 200, height: 40,
    }),
    startNetworkCapture: vi.fn().mockResolvedValue(undefined),
    stopNetworkCapture: vi.fn().mockResolvedValue([
      { requestId: '1', url: 'https://api.com/data', method: 'GET', status: 200, startTime: 1000, endTime: 1234, size: 1024 },
    ]),
    getNetworkBuffer: vi.fn().mockReturnValue([]),
    clearNetworkBuffer: vi.fn(),
    startConsoleCapture: vi.fn().mockResolvedValue(undefined),
    stopConsoleCapture: vi.fn().mockResolvedValue([
      { level: 'error', text: 'TypeError', timestamp: 1000, stackTrace: '  at app.js:1:234' },
    ]),
    getConsoleBuffer: vi.fn().mockReturnValue([]),
    clearConsoleBuffer: vi.fn(),
    getScripts: vi.fn().mockResolvedValue([
      { scriptId: '42', url: 'https://example.com/app.js', startLine: 0, endLine: 100 },
    ]),
    getScriptSource: vi.fn().mockResolvedValue('function hello() { return "world"; }\nfunction foo() { return "bar"; }'),
    getPerformanceMetrics: vi.fn().mockResolvedValue({
      Timestamp: 1000, Documents: 5, Nodes: 150, JSHeapUsedSize: 10485760,
    }),
    addScriptOnNewDocument: vi.fn().mockResolvedValue('script-1'),
    removeScriptOnNewDocument: vi.fn().mockResolvedValue(undefined),
  },
}))

import { createDebugCommand } from '../../src/background/debug-commands'
import { debugSession } from '../../src/background/debug-session'

function makeBash() {
  return new Bash({ files: {}, cwd: '/', customCommands: [createDebugCommand()] })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(debugSession.isAttached).mockReturnValue(true)
  vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1 }] as chrome.tabs.Tab[])
})

describe('Debug commands', () => {
  describe('debug (no subcommand)', () => {
    it('shows usage', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Usage: debug')
      expect(r.stdout).toContain('elements')
      expect(r.stdout).toContain('network')
    })
  })

  describe('auto-attach', () => {
    it('attaches debugger when not attached', async () => {
      vi.mocked(debugSession.isAttached).mockReturnValue(false)
      const bash = makeBash()
      await bash.exec('debug perf')
      expect(debugSession.attach).toHaveBeenCalledWith(1)
    })
  })

  describe('debug elements', () => {
    it('returns box model + styles + listeners', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug elements "button"')
      expect(r.exitCode).toBe(0)
      expect(debugSession.getBoxModel).toHaveBeenCalledWith('button')
      expect(debugSession.getComputedStyles).toHaveBeenCalledWith('button')
      expect(debugSession.getEventListeners).toHaveBeenCalledWith('button')
      expect(r.stdout).toContain('Box Model')
      expect(r.stdout).toContain('width: 200px')
      expect(r.stdout).toContain('Computed Styles')
      expect(r.stdout).toContain('display: flex')
      expect(r.stdout).toContain('Event Listeners')
      expect(r.stdout).toContain('click')
    })
  })

  describe('debug network', () => {
    it('start calls startNetworkCapture', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug network start')
      expect(debugSession.startNetworkCapture).toHaveBeenCalledWith(undefined)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Network capture started')
    })

    it('start --filter=api passes filter', async () => {
      const bash = makeBash()
      await bash.exec('debug network start --filter=api')
      expect(debugSession.startNetworkCapture).toHaveBeenCalledWith('api')
    })

    it('stop returns JSONL', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug network stop')
      expect(debugSession.stopNetworkCapture).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      // Reason: stop outputs JSON lines
      expect(r.stdout).toContain('"requestId":"1"')
      expect(r.stdout).toContain('https://api.com/data')
    })

    it('list calls getNetworkBuffer', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug network list')
      expect(debugSession.getNetworkBuffer).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
    })

    it('clear calls clearNetworkBuffer', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug network clear')
      expect(debugSession.clearNetworkBuffer).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('cleared')
    })
  })

  describe('debug console', () => {
    it('start calls startConsoleCapture', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug console start')
      expect(debugSession.startConsoleCapture).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Console capture started')
    })

    it('stop returns entries', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug console stop')
      expect(debugSession.stopConsoleCapture).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('TypeError')
    })

    it('list calls getConsoleBuffer', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug console list')
      expect(debugSession.getConsoleBuffer).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
    })

    it('clear calls clearConsoleBuffer', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug console clear')
      expect(debugSession.clearConsoleBuffer).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('cleared')
    })
  })

  describe('debug scripts', () => {
    it('lists scripts', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug scripts')
      expect(debugSession.getScripts).toHaveBeenCalledWith(undefined)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('42')
      expect(r.stdout).toContain('app.js')
    })

    it('--filter=app passes filter', async () => {
      const bash = makeBash()
      await bash.exec('debug scripts --filter=app')
      expect(debugSession.getScripts).toHaveBeenCalledWith('app')
    })

    it('long URLs are output in full for pipe/grep', async () => {
      const longUrl = 'https://g.alicdn.com/uniapp/uniapp/0.0.168/static/js/chunk-vendors.abcdef1234567890.js'
      vi.mocked(debugSession.getScripts).mockResolvedValueOnce([
        { scriptId: '99', url: longUrl, startLine: 0, endLine: 1 },
      ])
      const bash = makeBash()
      const r = await bash.exec('debug scripts')
      expect(r.exitCode).toBe(0)
      // Reason: truncated URLs made same-prefix bundle chunks indistinguishable
      expect(r.stdout).toContain(longUrl)
      expect(r.stdout).not.toContain('...')
    })
  })

  describe('debug source', () => {
    it('returns full raw source with metadata on stderr', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug source 42')
      expect(debugSession.getScriptSource).toHaveBeenCalledWith('42')
      expect(r.exitCode).toBe(0)
      // Reason: stdout must be the untouched source so redirection captures the full file
      expect(r.stdout).toBe('function hello() { return "world"; }\nfunction foo() { return "bar"; }\n')
      expect(r.stderr).toContain('script:42')
    })

    it('--search=hello finds match with col offset', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug source 42 --search=hello')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('search "hello"')
      expect(r.stdout).toContain('[col:')
    })

    it('--search with CJK matches \\uXXXX escaped source', async () => {
      // Reason: bundlers emit CJK as \uXXXX escapes — the literal query must still match
      vi.mocked(debugSession.getScriptSource).mockResolvedValueOnce(
        'var label="\\u7559\\u89c2\\u4eba\\u5458";var other="plain";'
      )
      const bash = makeBash()
      const r = await bash.exec('debug source 42 --search=留观')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('1 matches')
      expect(r.stdout).toContain('\\u7559\\u89c2')
    })

    it('--search with CJK also matches literal UTF-8 source', async () => {
      vi.mocked(debugSession.getScriptSource).mockResolvedValueOnce(
        'var label="留观人员";'
      )
      const bash = makeBash()
      const r = await bash.exec('debug source 42 --search=留观')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('1 matches')
      expect(r.stdout).toContain('留观人员')
    })

    it('space-form "--search value" works like "--search=value"', async () => {
      // Reason: agents write the space form — it used to silently fall through to full dump
      vi.mocked(debugSession.getScriptSource).mockResolvedValueOnce(
        'var label="\\u7559\\u89c2";'
      )
      const bash = makeBash()
      const r = await bash.exec('debug source 42 --search 留观')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('1 matches')
    })

    it('--col=15 extracts context around column', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug source 42 --col=15')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('col:15')
      expect(r.stdout).toContain('^')
    })

    it('--beautify returns raw for non-minified source', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug source 42 --beautify')
      expect(r.exitCode).toBe(0)
      // Reason: the mock source is multi-line (not minified), so it returns raw
      expect(r.stdout).toContain('function hello() { return "world"; }')
    })
  })

  describe('debug inject', () => {
    it('calls addScriptOnNewDocument', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug inject "console.log(\'hi\')"')
      expect(debugSession.addScriptOnNewDocument).toHaveBeenCalledWith("console.log('hi')")
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('script-1')
    })

    it('--remove=script-1 calls removeScriptOnNewDocument', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug inject --remove=script-1')
      expect(debugSession.removeScriptOnNewDocument).toHaveBeenCalledWith('script-1')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Removed')
    })
  })

  describe('debug perf', () => {
    it('returns formatted performance metrics', async () => {
      const bash = makeBash()
      const r = await bash.exec('debug perf')
      expect(debugSession.getPerformanceMetrics).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Performance Metrics')
      expect(r.stdout).toContain('Documents: 5')
      expect(r.stdout).toContain('Nodes: 150')
      // Reason: JSHeapUsedSize should be formatted as MB
      expect(r.stdout).toContain('MB')
    })
  })
})
