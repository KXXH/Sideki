import { useMemo } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import { buildPageTextIndex, type PageTextIndex, type PositionedItem } from '../shared/pdf-anchor'

export interface PageData {
  page: PDFPageProxy
  items: PositionedItem[]
  textContent: TextContent
  index: PageTextIndex
  base: { width: number; height: number }
}

export interface DocStore {
  numPages: number
  load(n: number): Promise<PageData>
  loadDim(n: number): Promise<{ width: number; height: number }>
}

export function indexTextContent(textContent: TextContent, page: number) {
  const items = textContent.items.filter((it): it is TextItem => 'str' in it)
  const index = buildPageTextIndex(items, page)
  const kept = new Set(index.items)
  // Reason: retain font metadata and empty items on the same filtered basis as itemRanges.
  return { index, textContent: { ...textContent, items: items.filter(it => kept.has(it)) } }
}

// Reason: page proxies + text indexes are cached per document, not per
// component — scrolling back to a page must be instant, and building the
// PageTextIndex (which the annotation layer needs) is the expensive part.
export function useDocIndex(doc: PDFDocumentProxy | null): DocStore | null {
  return useMemo(() => {
    if (!doc) return null
    const data = new Map<number, Promise<PageData>>()
    const dims = new Map<number, { width: number; height: number }>()
    const loadDim = async (n: number) => {
      const hit = dims.get(n)
      if (hit) return hit
      const page = await doc.getPage(n)
      const v = page.getViewport({ scale: 1 })
      const d = { width: v.width, height: v.height }
      dims.set(n, d)
      return d
    }
    const load = (n: number): Promise<PageData> => {
      let p = data.get(n)
      if (!p) {
        p = (async () => {
          const page = await doc.getPage(n)
          const base = await loadDim(n)
          const { index, textContent } = indexTextContent(await page.getTextContent(), n)
          return { page, items: index.items, textContent, index, base }
        })()
        // Reason: a failed load must not be cached — remounting the slot retries.
        p.catch(() => data.delete(n))
        data.set(n, p)
      }
      return p
    }
    return { numPages: doc.numPages, load, loadDim }
  }, [doc])
}
