import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'

vi.mock('../../src/background/tool-handlers', () => ({
  requireConsent: vi.fn().mockResolvedValue(true),
  // Reason: tab commands move the turn's tab stack, whose page-lock indicator
  // goes through the real execScript path.
  execScript: vi.fn().mockResolvedValue([{ result: { ok: true, seq: 1 } }]),
  ScriptDeadlineError: class ScriptDeadlineError extends Error {},
}))

import { createChromeCommand } from '../../src/background/chrome-commands'
import { requireConsent } from '../../src/background/tool-handlers'
import { operatingTabOf, __resetTabLocks } from '../../src/background/tab-locks'

function makeBash(sessionId = '') {
  // Reason: this harness has no tab id; consent routing is asserted via the mock.
  return new Bash({
    files: {},
    cwd: '/',
    customCommands: [createChromeCommand(undefined as unknown as number, sessionId)],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetTabLocks()
  vi.mocked(requireConsent).mockResolvedValue(true)

  // Reason: reset chrome tab mocks to a consistent known state
  vi.mocked(chrome.tabs.query).mockResolvedValue([
    { id: 1, url: 'https://example.com', title: 'Example', active: true, groupId: -1 },
    { id: 2, url: 'https://test.com', title: 'Test Page', active: false, groupId: -1 },
  ] as chrome.tabs.Tab[])
  vi.mocked(chrome.tabGroups.query).mockResolvedValue([])
  vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) => {
    const tabs = [
      { id: 1, url: 'https://example.com', title: 'Example', active: true, groupId: -1 },
      { id: 2, url: 'https://test.com', title: 'Test Page', active: false, groupId: -1 },
    ] as chrome.tabs.Tab[]
    const tab = tabs.find(t => t.id === id)
    if (!tab) throw new Error(`No tab with id ${id}`)
    return tab
  })
  vi.mocked(chrome.tabs.update).mockResolvedValue({} as chrome.tabs.Tab)
  vi.mocked(chrome.tabs.create).mockResolvedValue({ id: 3 } as chrome.tabs.Tab)
  vi.mocked(chrome.tabs.remove).mockResolvedValue(undefined)
  vi.mocked(chrome.bookmarks.search).mockResolvedValue([
    { id: '10', title: 'Test Bookmark', url: 'https://test.com' },
  ] as chrome.bookmarks.BookmarkTreeNode[])
  vi.mocked(chrome.history.search).mockResolvedValue([
    { id: '1', url: 'https://history.com', title: 'History Item', lastVisitTime: Date.now() },
  ] as chrome.history.HistoryItem[])
  vi.mocked(chrome.downloads.search).mockResolvedValue([
    { id: 1, filename: '/path/to/file.pdf', fileSize: 2048, state: 'complete', url: 'https://dl.com/file.pdf' },
  ] as unknown as chrome.downloads.DownloadItem[])
  vi.mocked(chrome.topSites.get).mockResolvedValue([
    { title: 'Popular Site', url: 'https://popular.com' },
  ] as chrome.topSites.MostVisitedURL[])
})

describe('Chrome commands', () => {
  describe('chrome tabs', () => {
    it('lists tabs from mock', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome tabs')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Example')
      expect(r.stdout).toContain('Test Page')
    })

    it('chrome tabs --switch=#1 requires consent and switches', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome tabs --switch="#1"')
      expect(requireConsent).toHaveBeenCalledWith('tab-switch', expect.stringContaining('#1'), undefined)
      expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Switched to')
    })

    it('chrome tabs --switch makes the target the operating tab', async () => {
      const bash = makeBash('session-tabs')
      const r = await bash.exec('chrome tabs --switch="#2"')
      expect(r.exitCode).toBe(0)
      expect(operatingTabOf('session-tabs')).toBe(2)
    })

    it('refuses to switch to a tab another session is operating, leaving its own top alone', async () => {
      const a = makeBash('session-a')
      await a.exec('chrome tabs --switch="#1"')
      expect(operatingTabOf('session-a')).toBe(1)

      const b = makeBash('session-b')
      const r = await b.exec('chrome tabs --switch="#1"')
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('another background task')
      expect(operatingTabOf('session-b')).toBeNull()
    })

    it('chrome tabs --new="https://x.com" requires consent and creates tab', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome tabs --new="https://x.com"')
      expect(requireConsent).toHaveBeenCalledWith('tab-new', 'https://x.com', undefined)
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://x.com' })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Opened tab')
    })

    it('chrome tabs --new makes the created tab the operating tab', async () => {
      const bash = makeBash('session-tabs')
      await bash.exec('chrome tabs --new="https://x.com"')
      expect(operatingTabOf('session-tabs')).toBe(3)
    })

    it('chrome tabs --close=#1 requires consent and removes tab', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome tabs --close="#1"')
      expect(requireConsent).toHaveBeenCalledWith('tab-close', expect.stringContaining('#1'), undefined)
      expect(chrome.tabs.remove).toHaveBeenCalledWith(1)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Closed')
    })
  })

  describe('chrome bookmarks', () => {
    it('chrome bookmarks --search="test" calls chrome.bookmarks.search', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome bookmarks --search="test"')
      expect(chrome.bookmarks.search).toHaveBeenCalledWith('test')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Test Bookmark')
    })
  })

  describe('chrome history', () => {
    it('chrome history "query" calls chrome.history.search', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome history "query"')
      expect(chrome.history.search).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'query' }),
      )
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('History Item')
    })

    it('chrome history --full returns untruncated URL', async () => {
      const longUrl = 'https://example.com/very/long/path?with=many&query=parameters&that=exceeds&sixty=characters&for=testing'
      vi.mocked(chrome.history.search).mockResolvedValueOnce([
        { id: '2', url: longUrl, title: 'Long URL Item', lastVisitTime: Date.now() },
      ] as chrome.history.HistoryItem[])
      const bash = makeBash()
      const r = await bash.exec('chrome history --full')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain(longUrl)
    })

    it('chrome history truncates URL by default', async () => {
      const longUrl = 'https://example.com/very/long/path?with=many&query=parameters&that=exceeds&sixty=characters&for=testing'
      vi.mocked(chrome.history.search).mockResolvedValueOnce([
        { id: '3', url: longUrl, title: 'Long URL Item', lastVisitTime: Date.now() },
      ] as chrome.history.HistoryItem[])
      const bash = makeBash()
      const r = await bash.exec('chrome history')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).not.toContain(longUrl)
      expect(r.stdout).toContain(longUrl.slice(0, 60))
    })
  })

  describe('chrome downloads', () => {
    it('lists downloads', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome downloads')
      expect(chrome.downloads.search).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('file.pdf')
    })
  })

  describe('chrome top-sites', () => {
    it('lists top sites', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome top-sites')
      expect(chrome.topSites.get).toHaveBeenCalled()
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('Popular Site')
    })
  })

  describe('chrome usage', () => {
    it('no subcommand shows usage with exit 0', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome')
      expect(r.exitCode).toBe(0)
      expect(r.stderr).toContain('Usage:')
    })

    it('unknown subcommand shows usage with exit 1', async () => {
      const bash = makeBash()
      const r = await bash.exec('chrome unknown')
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Usage:')
    })
  })

  describe('consent denied', () => {
    it('returns exit code 126 when consent denied', async () => {
      vi.mocked(requireConsent).mockResolvedValue(false)
      const bash = makeBash()
      const r = await bash.exec('chrome tabs --switch="#1"')
      expect(r.exitCode).toBe(126)
      expect(r.stderr).toContain('denied')
    })
  })
})
