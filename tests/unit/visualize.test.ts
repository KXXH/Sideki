import { buildHtmlPreviewUrl, parseVfsPreviewLink, readHtmlPreviewNetwork } from '../../src/shared/html-artifact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  basenameWithoutExt,
  fnv1a32,
  snapshotPathFor,
  validateSourcePath,
  makeVisualizeTool,
} from '../../src/shared/tools/visualize'

describe('validateSourcePath', () => {
  it('accepts html, htm and svg files under /viz', () => {
    expect(() => validateSourcePath('/viz/chart.html')).not.toThrow()
    expect(() => validateSourcePath('/viz/report.htm')).not.toThrow()
    expect(() => validateSourcePath('/viz/diagram.svg')).not.toThrow()
    expect(() => validateSourcePath('/viz/CHART.HTML')).not.toThrow()
  })

  it('rejects paths outside /viz with a fix', () => {
    for (const path of ['/tmp/chart.html', '/page/chart.html', 'tmp/chart.html', '/notes/chart.html', '/etchtml']) {
      expect(() => validateSourcePath(path)).toThrow(/must start with \/viz\//)
    }
  })

  it('rejects empty paths', () => {
    expect(() => validateSourcePath('')).toThrow(/path is required/)
    expect(() => validateSourcePath('   ')).toThrow(/path is required/)
  })

  it('rejects traversal segments with a fix', () => {
    expect(() => validateSourcePath('/viz/../etc/passwd.html')).toThrow(/must not contain "\.\."/)
    expect(() => validateSourcePath('/viz/../../secret.html')).toThrow(/must not contain "\.\."/)
  })

  it('rejects non-visual extensions', () => {
    expect(() => validateSourcePath('/viz/chart.txt')).toThrow(/\.html, \.htm or \.svg/)
    expect(() => validateSourcePath('/viz/chart')).toThrow(/\.html, \.htm or \.svg/)
  })
})

describe('snapshotPathFor', () => {
  it('uses the known FNV-1a 32-bit hash, zero-padded to 8 hex chars', () => {
    expect(fnv1a32('hello')).toBe('4f9f2cab')
    expect(fnv1a32('a')).toBe('e40c292c')
    expect(fnv1a32('')).toBe('811c9dc5')
  })

  it('builds /viz/<slug>-<hash8>.html from the title', () => {
    expect(snapshotPathFor('Revenue — Q3', '/viz/chart.html', '<div></div>'))
      .toBe('/viz/revenue-q3-67d67536.html')
  })

  it('is deterministic for identical title and content', () => {
    const a = snapshotPathFor('Report', '/viz/a.html', '<p>same</p>')
    const b = snapshotPathFor('Report', '/viz/b.html', '<p>same</p>')
    expect(a).toBe(b)
    expect(a).toMatch(/^\/viz\/report-[0-9a-f]{8}\.html$/)
  })

  it('changes the hash when content changes', () => {
    const a = snapshotPathFor('Report', '/viz/a.html', '<p>one</p>')
    const b = snapshotPathFor('Report', '/viz/a.html', '<p>two</p>')
    expect(a).not.toBe(b)
  })

  it('falls back to the source basename, then to viz for non-ascii names', () => {
    expect(snapshotPathFor(undefined, '/viz/my-chart.html', '<div></div>'))
      .toBe('/viz/my-chart-67d67536.html')
    expect(snapshotPathFor('营收图', '/viz/chart.html', '<div></div>'))
      .toBe('/viz/chart-67d67536.html')
    expect(snapshotPathFor(undefined, '/viz/图表.html', '<div></div>'))
      .toBe('/viz/viz-67d67536.html')
  })

  it('strips the extension from the basename', () => {
    expect(basenameWithoutExt('/viz/my.report.html')).toBe('my.report')
    expect(basenameWithoutExt('/viz/chart')).toBe('chart')
  })
})


describe('visualize preview URL capabilities', () => {
  beforeEach(() => { vi.mocked(chrome.runtime.sendMessage).mockClear() })
  afterEach(() => vi.restoreAllMocks())

  it('gives the same HTML separate snapshots for offline and online modes', () => {
    const html = '<button>Explore</button>'
    const offline = snapshotPathFor('Explore', '/viz/source.html', html)
    const online = snapshotPathFor('Explore', '/viz/source.html', html, true)
    expect(offline).not.toBe(online)
    expect(online).toBe(snapshotPathFor('Explore', '/viz/other.html', html, true))
    expect(online).not.toBe(snapshotPathFor('Explore', '/viz/source.html', `network:true\n${html}`))
  })

  it('returns a shareable previewPath carrying the mode without writing a sidecar', async () => {
    const html = '<!doctype html><html><head><style>button{color:red}</style></head><body><button>Explore</button></body></html>'
    const files = new Map([['/viz/source.html', html]])
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message) => {
      if (message.type === 'dev:cat') return { success: files.has(message.path), content: files.get(message.path) }
      if (message.type === 'vfs:write') { files.set(message.path, message.content); return { success: true } }
      if (message.type === 'viz:probe') return { ok: true, result: { status: 'ok', height: 100 } }
      return undefined
    })
    const tool = makeVisualizeTool({ getSessionId: () => 'session-a' })
    const result = await tool.execute!({ path: '/viz/source.html', title: 'Explore', network: true }, { toolCallId: 'call-a', messages: [] })
    expect(result).toMatchObject({ network: true, render: { status: 'ok' } })
    expect(files.get(result.path)).toBe(html)
    expect([...files.keys()]).toHaveLength(2)
    const target = parseVfsPreviewLink(result.previewPath)!
    expect(target).toEqual({ path: result.path, network: true })
    const url = new URL(buildHtmlPreviewUrl('chrome-extension://id/src/preview/index.html', 'session-a', target.path, target.network))
    const { readHtmlPreview } = await import('../../src/preview/preview-host')
    await expect(readHtmlPreview(chrome.runtime.sendMessage, url.searchParams.get('session')!, url.searchParams.get('file')!, readHtmlPreviewNetwork(url.searchParams)))
      .resolves.toEqual({ html, network: true })
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.every(([message]) => message.sessionId === 'session-a')).toBe(true)
  })

  it('does not advertise a shareable snapshot if its HTML could not be saved', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message) => {
      if (message.type === 'dev:cat') return { success: true, content: '<p>Report</p>' }
      if (message.type === 'vfs:write') return { success: false, error: 'quota exceeded' }
      return undefined
    })
    const tool = makeVisualizeTool({ getSessionId: () => 'session-a' })
    await expect(tool.execute!({ path: '/viz/source.html' }, { toolCallId: 'call-a', messages: [] }))
      .rejects.toThrow(/failed to save the snapshot/)
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([message]) => message.type === 'viz:probe')).toBe(false)
  })
})
