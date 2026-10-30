import { describe, expect, it, vi } from 'vitest'
import type { PageViewport } from 'pdfjs-dist'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import { buildPageTextIndex } from '../../src/shared/pdf-anchor'
import type { PdfNote } from '../../src/shared/pdf-note-store'
import { computeNoteBands, hitTestNote, selectionToDraft } from '../../src/reader/annotation-layer'
import { advanceNoteJump, type PendingNoteJump } from '../../src/reader/note-navigation'
import { indexTextContent, type PageData } from '../../src/reader/use-doc-index'

function selectionPage(text: string, page: number) {
  const node = { nodeType: 3, textContent: text }
  const span = { dataset: { item: '0' }, firstChild: node, textContent: text }
  const pageEl = {
    querySelectorAll: () => [span],
    contains: (n: unknown) => n === node || n === span || n === pageEl,
    closest: () => pageEl,
  }
  const index = buildPageTextIndex([{
    str: text, width: 240, height: 12, hasEOL: false, transform: [12, 0, 0, 12, 20, 100],
  }], page)
  return { node, span, pageEl: pageEl as unknown as HTMLElement, data: { index, items: index.items } as PageData }
}

function selection(start: unknown, end: unknown, startOffset: number, endOffset: number) {
  const range = { startContainer: start, endContainer: end, startOffset, endOffset, intersectsNode: () => true }
  return {
    rangeCount: 1, isCollapsed: false, getRangeAt: () => range, removeAllRanges: vi.fn(),
  } as unknown as Selection
}

describe('reader selection boundaries', () => {
  it('rejects a cross-page selection instead of saving only the release page', () => {
    const first = selectionPage('First page selected evidence.', 1)
    const second = selectionPage('Second page selected evidence.', 2)
    const sel = selection(first.node, second.node, 0, 20)
    expect(selectionToDraft(sel, second.pageEl, second.data)).toBeNull()
    expect(selectionToDraft(sel, first.pageEl, first.data)).toBeNull()
    expect(sel.removeAllRanges).not.toHaveBeenCalled()
  })

  it('keeps a same-page partial-item quote and its disambiguating context', () => {
    const page = selectionPage('WWWWWWWWiiiiiiii after', 1)
    const sel = selection(page.node, page.node, 8, 16)
    expect(selectionToDraft(sel, page.pageEl, page.data)).toEqual({
      page: 1, quote: 'iiiiiiii', prefix: 'WWWWWWWW', suffix: ' after',
    })
  })

  it('rejects multiple ranges on different pages without clearing them', () => {
    const first = selectionPage('First selected evidence.', 1)
    const second = selectionPage('Second selected evidence.', 2)
    const ranges = [selection(first.node, first.node, 0, 20), selection(second.node, second.node, 0, 20)]
    const sel = { rangeCount: 2, isCollapsed: false, getRangeAt: (i: number) => ranges[i].getRangeAt(0) } as Selection
    expect(selectionToDraft(sel, first.pageEl, first.data)).toBeNull()
  })
})

function textItem(str: string, x = 20, hasEOL = false): TextItem {
  return { str, width: x ? 240 : 4, height: 12, hasEOL, transform: [12, 0, 0, 12, x, 100], fontName: 'serif', dir: 'ltr' }
}

function note(page = 1, extra: Partial<PdfNote> = {}): PdfNote {
  return { id: 'test-note', author: 'user', page, quote: 'iiiiiiii', color: 'yellow', ts: 0, ...extra }
}

describe('reader text-layer index and Range mapping', () => {
  it('retains font styles, direction, empty items and identity after gutter filtering', () => {
    const gutter = textItem('12', 0)
    const empty = textItem('', 20, true)
    const body = { ...textItem('WWWWWWWWiiiiiiii'), dir: 'rtl' }
    const tc: TextContent = {
      items: [gutter, empty, body], lang: 'en',
      styles: { serif: { fontFamily: 'serif', ascent: 0.9, descent: -0.1, vertical: false } },
    }
    const { index, textContent } = indexTextContent(tc, 1)
    expect(index.items).toEqual([empty, body])
    expect(textContent.items[0]).toBe(empty)
    expect(textContent.items[1]).toBe(body)
    expect(textContent.styles).toBe(tc.styles)
    expect(textContent.lang).toBe('en')
    expect(index.itemRanges).toEqual([{ start: 0, end: 1 }, { start: 1, end: 17 }])
  })

  it('uses the filtered text node and Range offsets, not item width, for local rectangles and hit tests', () => {
    const { index, textContent } = indexTextContent({
      items: [textItem('12', 0), textItem('', 20, true), textItem('WWWWWWWWiiiiiiii')], styles: {}, lang: null,
    }, 1)
    const data = { index, textContent, items: index.items } as PageData
    const node = { nodeType: 3, textContent: 'WWWWWWWWiiiiiiii' }
    let scroll = 0
    const range = {
      setStart: vi.fn(), setEnd: vi.fn(),
      getClientRects: () => [{ left: 160, top: 90 - scroll, width: 37.5, height: 12 }],
    }
    const geometry = {
      textDivs: [{ firstChild: null }, { firstChild: node }] as unknown as HTMLElement[],
      pageElement: {
        getBoundingClientRect: () => ({ left: 100, top: 50 - scroll, width: 600, height: 800 }),
        ownerDocument: { createRange: () => range },
      } as unknown as HTMLElement,
    }
    const viewport = { width: 600, height: 800 } as PageViewport
    const n = note()
    const bands = computeNoteBands([n], data, viewport, geometry)
    expect(range.setStart).toHaveBeenCalledWith(node, 8)
    expect(range.setEnd).toHaveBeenCalledWith(node, 16)
    expect(bands[0].rects).toEqual([{ left: 60, top: 40, width: 37.5, height: 12 }])
    expect(hitTestNote(bands, 75, 45)?.id).toBe(n.id)
    expect(hitTestNote(bands, 120, 45)).toBeNull()
    scroll = 130
    expect(computeNoteBands([n], data, viewport, geometry)[0].rects).toEqual(bands[0].rects)
    expect(computeNoteBands([note(1, { author: 'ai' })], data, viewport, geometry, null)).toEqual([])
  })

  it('clamps synthetic EOL offsets and keeps separate visual runs separate', () => {
    const index = buildPageTextIndex([textItem('First evidence', 20, true), textItem('Second evidence')], 1)
    const nodes = index.items.map(item => ({ nodeType: 3, textContent: item.str }))
    const range = {
      setStart: vi.fn(), setEnd: vi.fn(),
      getClientRects: () => [{ left: 5, top: 5, width: 10, height: 12 }],
    }
    const geometry = {
      textDivs: nodes.map(firstChild => ({ firstChild })) as unknown as HTMLElement[],
      pageElement: {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800 }),
        ownerDocument: { createRange: () => range },
      } as unknown as HTMLElement,
    }
    const bands = computeNoteBands([note(1, { quote: index.raw })], { index } as PageData,
      { width: 600, height: 800 } as PageViewport, geometry)
    expect(range.setEnd.mock.calls).toEqual([[nodes[0], 14], [nodes[1], 15]])
    expect(bands[0].rects).toHaveLength(2)
  })
})

function navigationPage(page = 10) {
  const bands: HTMLElement[] = []
  const slot = { scrollIntoView: vi.fn(), querySelectorAll: () => bands } as unknown as HTMLElement
  const root = { getElementById: vi.fn((id: string) => id === `pdf-page-${page}` ? slot : null) }
  const mountBand = (id = 'test-note') => {
    const band = { dataset: { noteId: id }, scrollIntoView: vi.fn() } as unknown as HTMLElement
    bands.push(band)
    return band
  }
  return { slot, root, mountBand }
}

function pending(page = 10): PendingNoteJump {
  return { id: 'test-note', page, scrolledToPage: false }
}

describe('reader deferred note jumps', () => {
  it('scrolls the unloaded tenth page first, then exactly once to its loaded band', () => {
    const { root, slot, mountBand } = navigationPage()
    let request = advanceNoteJump(pending(), [note(10)], root)
    expect(slot.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    request = advanceNoteJump(request, [note(10)], root)
    expect(slot.scrollIntoView).toHaveBeenCalledTimes(1)
    const band = mountBand()
    request = advanceNoteJump(request, [note(10)], root)
    expect(request).toBeNull()
    expect(band.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    advanceNoteJump(request, [note(10)], root)
    expect(band.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('jumps an already-rendered first-page note without visiting the page top', () => {
    const { root, slot, mountBand } = navigationPage(1)
    const band = mountBand()
    expect(advanceNoteJump(pending(1), [note()], root)).toBeNull()
    expect(slot.scrollIntoView).not.toHaveBeenCalled()
    expect(band.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('waits for the requested AI band even when another band exists during markdown loading', () => {
    const { root, slot, mountBand } = navigationPage(1)
    const other = mountBand('other-note')
    const ai = note(1, { author: 'ai' })
    const request = advanceNoteJump(pending(1), [ai], root)
    expect(request?.scrolledToPage).toBe(true)
    expect(other.scrollIntoView).not.toHaveBeenCalled()
    const band = mountBand()
    expect(advanceNoteJump(request, [ai], root)).toBeNull()
    expect(slot.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(band.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('waits for the page container when the initial fit scale has not committed yet', () => {
    const request = advanceNoteJump(pending(), [note(10)], { getElementById: () => null })
    expect(request).toEqual(pending())
    const { root, slot } = navigationPage()
    expect(advanceNoteJump(request, [note(10)], root)?.scrolledToPage).toBe(true)
    expect(slot.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('does not retarget a missing, deleted or moved note', () => {
    const { root, slot, mountBand } = navigationPage()
    const band = mountBand('other-note')
    expect(advanceNoteJump(pending(), [note(10, { id: 'other-note' })], root)).toBeNull()
    expect(advanceNoteJump({ ...pending(), scrolledToPage: true }, [], root)).toBeNull()
    expect(advanceNoteJump(pending(), [note(2)], root)).toBeNull()
    expect(slot.scrollIntoView).not.toHaveBeenCalled()
    expect(band.scrollIntoView).not.toHaveBeenCalled()
  })

  it('leaves subsequent layout changes alone after user cancellation', () => {
    const { root, mountBand } = navigationPage()
    advanceNoteJump(pending(), [note(10)], root)
    const band = mountBand()
    expect(advanceNoteJump(null, [note(10)], root)).toBeNull()
    expect(band.scrollIntoView).not.toHaveBeenCalled()
  })
})
