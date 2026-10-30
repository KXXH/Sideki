import type { PageViewport } from 'pdfjs-dist'
import { MIN_QUOTE, normalizePageText, toPageSpan } from '../shared/pdf-anchor'
import type { PdfNote } from '../shared/pdf-note-store'
import { degradeLabel, resolveNote, UNANCHORED_LABEL } from './note-resolution'
import type { PageData } from './use-doc-index'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface NoteBands {
  note: PdfNote
  kind: 'exact' | 'page' | 'unanchored'
  rects: Rect[]
  label?: string
}

export interface NewNoteDraft {
  page: number
  quote: string
  prefix?: string
  suffix?: string
}

const HIGHLIGHT_FILL: Record<PdfNote['color'], string> = {
  yellow: 'rgba(250, 204, 21, 0.32)',
  green: 'rgba(52, 211, 153, 0.30)',
  blue: 'rgba(96, 165, 250, 0.30)',
  pink: 'rgba(244, 114, 182, 0.30)',
}

const HIGHLIGHT_EDGE: Record<PdfNote['color'], string> = {
  yellow: 'rgba(202, 138, 4, 0.55)',
  green: 'rgba(5, 150, 105, 0.55)',
  blue: 'rgba(37, 99, 235, 0.55)',
  pink: 'rgba(219, 39, 119, 0.55)',
}

export interface TextLayerGeometry {
  pageElement: HTMLElement
  textDivs: readonly HTMLElement[]
}

function spanRects(
  span: ReturnType<typeof toPageSpan>,
  data: PageData,
  viewport: PageViewport,
  geometry: TextLayerGeometry,
): Rect[] {
  const box = geometry.pageElement.getBoundingClientRect()
  if (!box.width || !box.height) return []
  const sx = viewport.width / box.width
  const sy = viewport.height / box.height
  const range = geometry.pageElement.ownerDocument.createRange()
  const rects: Rect[] = []
  for (const seg of span.items) {
    const length = data.index.items[seg.item].str.length
    const start = Math.min(seg.startInItem, length)
    const end = Math.min(seg.endInItem, length)
    if (end <= start) continue
    const node = geometry.textDivs[seg.item]?.firstChild
    if (!node || node.nodeType !== 3) return []
    range.setStart(node, start)
    range.setEnd(node, end)
    // Reason: Range measures shaped glyphs after all PDF.js transforms, unlike average character widths.
    for (const r of Array.from(range.getClientRects())) {
      if (r.width <= 0 || r.height <= 0) continue
      rects.push({
        left: (r.left - box.left) * sx,
        top: (r.top - box.top) * sy,
        width: r.width * sx,
        height: r.height * sy,
      })
    }
  }
  return rects
}

// Reason: a still-loading page markdown yields no bands for AI notes rather
// than a wrong page-level box — see resolveNote's null contract.
export function computeNoteBands(
  notes: PdfNote[],
  data: PageData,
  viewport: PageViewport,
  geometry: TextLayerGeometry,
  mdNorm: string | null = null,
): NoteBands[] {
  const out: NoteBands[] = []
  const fullPage = (): Rect[] => [
    { left: 6, top: 6, width: viewport.width - 12, height: viewport.height - 12 },
  ]
  for (const note of notes) {
    if (note.page !== data.index.page) continue
    const res = resolveNote(note, data.index, mdNorm)
    if (res === null) continue
    if (res.kind === 'miss') {
      // Reason: the note claims this page but its quote is nowhere on it — say
      // so instead of dropping the note, which would look like a silent loss.
      out.push({ note, kind: 'unanchored', rects: fullPage(), label: UNANCHORED_LABEL })
      continue
    }
    if (res.kind === 'page') {
      out.push({ note, kind: 'page', rects: fullPage(), label: degradeLabel(res.reason) })
      continue
    }
    const span = toPageSpan(data.index, res.pageStart, res.pageEnd)
    const rects = spanRects(span, data, viewport, geometry)
    if (rects.length > 0) out.push({ note, kind: 'exact', rects })
  }
  return out
}

export function hitTestNote(bands: NoteBands[], x: number, y: number): PdfNote | null {
  for (let i = bands.length - 1; i >= 0; i--) {
    for (const r of bands[i].rects) {
      if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) {
        return bands[i].note
      }
    }
  }
  return null
}

export const CROSS_PAGE_SELECTION_MESSAGE = '暂不支持跨页批注，请逐页选择。'

export function selectionStaysOnPage(sel: Selection, pageEl: HTMLElement): boolean {
  const page = pageEl.closest('[data-pagenum]') ?? pageEl
  if (sel.isCollapsed || sel.rangeCount === 0) return false
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i)
    if (!page.contains(range.startContainer) || !page.contains(range.endContainer)) return false
  }
  return true
}

// Reason: read back through itemRanges so stored quotes retain page-space context.
export function selectionToDraft(
  sel: Selection,
  pageEl: HTMLElement,
  data: PageData,
): NewNoteDraft | null {
  if (!selectionStaysOnPage(sel, pageEl)) return null
  const covered: Array<{ item: number; start: number; end: number }> = []
  pageEl.querySelectorAll<HTMLElement>('span[data-item]').forEach(span => {
    const item = Number(span.dataset.item)
    const tn = span.firstChild
    const len = span.textContent?.length ?? 0
    if (!tn || !data.index.itemRanges[item]) return
    let s: number | null = null
    let e: number | null = null
    for (let r = 0; r < sel.rangeCount; r++) {
      const sr = sel.getRangeAt(r)
      if (!sr.intersectsNode(tn)) continue
      const cs = sr.startContainer === tn ? sr.startOffset : 0
      const ce = sr.endContainer === tn ? sr.endOffset : len
      if (s === null || cs < s) s = cs
      if (e === null || ce > e) e = ce
    }
    if (s !== null && e !== null && e > s) covered.push({ item, start: s, end: e })
  })
  if (covered.length === 0) return null
  covered.sort((a, b) => a.item - b.item)
  const idx = data.index
  const first = covered[0]
  const last = covered[covered.length - 1]
  let a = idx.itemRanges[first.item].start + first.start
  let b = idx.itemRanges[last.item].start + last.end
  while (a < b && /\s/.test(idx.raw[a] ?? '')) a++
  while (b > a && /\s/.test(idx.raw[b - 1] ?? '')) b--
  if (normalizePageText(idx.raw.slice(a, b)).length < MIN_QUOTE) return null
  return {
    page: idx.page,
    quote: idx.raw.slice(a, b),
    prefix: idx.raw.slice(Math.max(0, a - 48), a),
    suffix: idx.raw.slice(b, Math.min(idx.raw.length, b + 48)),
  }
}

export function AnnotationBands({
  bands,
  activeNoteId,
}: {
  bands: NoteBands[]
  activeNoteId: string | null
}) {
  return (
    // Reason: pointer-events-none keeps the transparent text layer above as
    // the sole hit target — note clicks are resolved geometrically instead.
    <div className="pointer-events-none absolute inset-0 z-10">
      {bands.map(({ note, kind, rects, label }) =>
        rects.map((r, i) => {
          if (kind === 'page' || kind === 'unanchored') {
            const edge = kind === 'unanchored' ? 'var(--color-error)' : HIGHLIGHT_EDGE[note.color]
            return (
              <div
                key={`${note.id}-${i}`}
                data-note-id={note.id}
                className="absolute rounded-md border-2 border-dashed"
                style={{
                  left: r.left,
                  top: r.top,
                  width: r.width,
                  height: r.height,
                  borderColor: edge,
                }}
              >
                <span
                  className="absolute left-2 top-2 rounded-sm px-1.5 py-0.5 text-[10px] leading-none text-white"
                  style={{ background: edge }}
                >
                  {label}
                </span>
              </div>
            )
          }
          return (
            <div
              key={`${note.id}-${i}`}
              data-note-id={note.id}
              className="absolute rounded-xs"
              style={{
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                background: HIGHLIGHT_FILL[note.color],
                outline: note.id === activeNoteId ? '2px solid var(--color-accent)' : undefined,
              }}
            />
          )
        }),
      )}
    </div>
  )
}
