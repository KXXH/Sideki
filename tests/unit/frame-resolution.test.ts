import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/background/shell', () => ({ execBash: vi.fn(), mirrorScreenshotToVfs: vi.fn(), KEEP_SCREENSHOTS: 3 }))
import { resolveFrameId } from '../../src/background/tool-handlers'

const frame = (frameId: number, parentFrameId: number, url: string) => ({ frameId, parentFrameId, url, errorOccurred: false })
beforeEach(() => vi.resetAllMocks())

describe('explicit iframe resolution', () => {
  it('resolves numeric nested frames and refuses missing frame IDs', async () => {
    vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([frame(7, 3, 'https://child.test/')])
    expect(await resolveFrameId(42, '#7')).toBe(7)
    expect(await resolveFrameId(42, '8')).toEqual(expect.objectContaining({ success: false }))
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
  })
  it('matches a CSS-selected iframe only among top-document children', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: -1 }] as any).mockResolvedValueOnce([{ result: 'https://child.test/' }] as any)
    vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([
      frame(0, -1, 'https://child.test/'), frame(9, 3, 'https://child.test/'), frame(7, 0, 'https://child.test/'),
    ])
    expect(await resolveFrameId(42, '#agent')).toBe(7)
  })
  it('rejects ambiguous URLs rather than installing in an arbitrary iframe', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: -1 }] as any).mockResolvedValueOnce([{ result: 'https://child.test/' }] as any)
    vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([
      frame(7, 0, 'https://child.test/'), frame(8, 0, 'https://child.test/'),
    ])
    expect(await resolveFrameId(42, '#agent')).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('numeric frameId') }))
  })
})
