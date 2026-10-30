// PDF anchoring: map quotes between pdf-inspector markdown (the model's view)
// and the pdf.js page text stream (the geometric index).
// Reason: pure functions only — this module enters the service-worker bundle
// via shell-commands.ts and must not pull pdfjs-dist or chrome.

export interface PositionedItem {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL: boolean
}

export interface TextQuoteSelector {
  exact: string
  prefix?: string
  suffix?: string
  page: number
}

export const MIN_RUN = 24
export const PROBE_MAX = 400
// Reason: pdf-inspector interleaves per-line line numbers into the markdown
// while the margin-filtered page stream omits them, so prose between two line
// numbers can be shorter than MIN_RUN and still needs an anchor.
export const MIN_RUN_NOISE = 16
export const MIN_QUOTE = 8
export const LARGE_GAP = 40
export const PROSE_COVERAGE = 0.9
// Reason: internal md-only gaps are tolerated only when they are clearly
// non-content — line numbers, hyphen fragments, stray emphasis markers.
// A gap with letters or longer than this is reordered table content that the
// highlight would silently drop, so it must degrade to page level.
export const BENIGN_GAP_MAX = 8

const DEHYPH = /(\p{L})[-\u00ad]\s*\n\s*(\p{L})/gu
const COMBINING = /\p{M}/u
const WS = /\s/u
const PAGE_MARKER = /<!--\s*Page\s+(\d+)\s*-->/i

// ---------------------------------------------------------------- normalization

interface NormResult {
  norm: string
  normToRaw: number[]
}

// Reason: provenance is kept per normalized char so a normalized match can be
// read back into the raw page text and located in item space for rects.
function normalizeWithProvenance(raw: string): NormResult {
  const kept: Array<{ ch: string; raw: number }> = []
  const push = (s: string, base: number) => {
    for (let i = 0; i < s.length; i++) kept.push({ ch: s[i], raw: base + i })
  }
  DEHYPH.lastIndex = 0
  let m: RegExpExecArray | null
  let last = 0
  while ((m = DEHYPH.exec(raw)) !== null) {
    push(raw.slice(last, m.index), last)
    kept.push({ ch: m[1], raw: m.index })
    kept.push({ ch: m[2], raw: m.index + m[0].length - 1 })
    last = m.index + m[0].length
  }
  push(raw.slice(last), last)

  const out: string[] = []
  const prov: number[] = []
  let i = 0
  while (i < kept.length) {
    let j = i + 1
    while (j < kept.length && COMBINING.test(kept[j].ch)) j++
    // Reason: NFKC+lowercase per base+marks segment; full-string NFKC would
    // compose across chars and break the per-char provenance mapping.
    const seg = kept.slice(i, j).map(c => c.ch).join('')
    for (const ch of seg.normalize('NFKC').toLowerCase()) {
      if (!WS.test(ch)) {
        out.push(ch)
        prov.push(kept[i].raw)
      }
    }
    i = j
  }
  return { norm: out.join(''), normToRaw: prov }
}

export function normalizePageText(s: string): string {
  return normalizeWithProvenance(s).norm
}

export function stripMarkdownSyntax(md: string): string {
  let s = md
    .replace(/<!--[^>]*-->/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    // Reason: protect escaped literals (\* etc.) so emphasis stripping cannot
    // eat them; \uE000 never occurs in real page text.
    .replace(/\\([\\`*_{}[\]()#+.!|>-])/g, '\uE000$1')
    .replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, '\n')
    .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^>[ \t]?/gm, '')
  let prev = ''
  while (s !== prev) {
    prev = s
    // Reason: paired delimiter runs with CommonMark flank rules — a lone
    // infix "a * b" or "snake_case_word" survives, only true emphasis goes.
    s = s.replace(/(?<!\uE000)(\*{1,3})(?=\S)([^*]+?)(?<=\S)(?<!\uE000)\1/g, '$2')
    s = s.replace(/(^|[\s([{])(_{1,3})(?=\S)([^_]+?)(?<=\S)\2(?=$|[\s)\]}.,;:!?])/gu, '$1$3')
  }
  return s.replace(/[\uE000`|]/g, '')
}

export function normalizeMarkdownText(s: string): string {
  return normalizePageText(stripMarkdownSyntax(s))
}

// ---------------------------------------------------------------- margin filter

const DIGIT_ONLY = /^\s*\d+\s*$/
const HAS_LETTER = /\p{L}/u

// Reason: per-line line numbers sit left of all body letters; the -2 slack
// absorbs coordinate rounding. Verified on the fixture: exactly the 52
// margin numbers per page, page-number and figure digits survive.
export function excludeMarginItems(items: PositionedItem[]): PositionedItem[] {
  let letterMinX = Infinity
  for (const it of items) {
    if (HAS_LETTER.test(it.str) && it.transform[4] < letterMinX) letterMinX = it.transform[4]
  }
  if (!isFinite(letterMinX)) return items
  const threshold = letterMinX - 2
  return items.filter(
    it => !(DIGIT_ONLY.test(it.str) && it.transform[4] + it.width <= threshold),
  )
}

// ---------------------------------------------------------------- page index

export interface PageTextIndex {
  page: number
  raw: string
  itemRanges: Array<{ start: number; end: number }>
  norm: string
  normToRaw: number[]
  itemCount: number
  // Reason: the margin-filtered items themselves, so geometry consumers
  // (reader text layer, highlight rects) share the exact index basis of
  // itemRanges — mixing in the unfiltered list shifts every rect onto a
  // wrong item on pages with margin line numbers.
  items: PositionedItem[]
}

export function buildPageTextIndex(
  items: PositionedItem[],
  page: number,
  opts?: { excludeMargin?: boolean },
): PageTextIndex {
  const filtered = opts?.excludeMargin === false ? items : excludeMarginItems(items)
  let raw = ''
  const itemRanges: Array<{ start: number; end: number }> = []
  for (const it of filtered) {
    const start = raw.length
    raw += it.str
    if (it.hasEOL) raw += '\n'
    itemRanges.push({ start, end: raw.length })
  }
  const { norm, normToRaw } = normalizeWithProvenance(raw)
  return { page, raw, itemRanges, norm, normToRaw, itemCount: filtered.length, items: filtered }
}

export function splitMarkdownPages(md: string): Map<number, string> {
  const parts = md.split(PAGE_MARKER)
  const pages = new Map<number, string>()
  if (parts.length === 1) {
    pages.set(1, md)
    return pages
  }
  for (let i = 1; i < parts.length; i += 2) {
    pages.set(Number(parts[i]), parts[i + 1] ?? '')
  }
  return pages
}

export function buildMarkdownPageIndex(md: string): Map<number, string> {
  const pages = splitMarkdownPages(md)
  const out = new Map<number, string>()
  for (const [p, text] of pages) out.set(p, normalizeMarkdownText(text))
  return out
}

// ---------------------------------------------------------------- alignment

export interface AlignSegment {
  mdStart: number
  mdEnd: number
  pageStart: number
  pageEnd: number
}

export interface AlignGap {
  mdStart: number
  mdEnd: number
  pageStart: number
  pageEnd: number
}

export interface AlignResult {
  segments: AlignSegment[]
  gaps: AlignGap[]
  matchedMdChars: number
  coverage: number
  verdict: 'prose' | 'divergent'
}

function longestMatchAt(md: string, i: number, page: string, from: number): number {
  let lo = 0
  let hi = Math.min(PROBE_MAX, md.length - i)
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (page.indexOf(md.slice(i, i + mid), from) !== -1) lo = mid
    else hi = mid - 1
  }
  return lo
}

function digitNoiseLen(md: string, i: number): number {
  let j = i
  while (j < md.length && md[j] >= '0' && md[j] <= '9') j++
  return j - i
}

// Reason: greedy sequential walk, cursor-constrained so segments never map
// backwards — the running order itself disambiguates repeated phrases.
// Interleaved line numbers are md-only: a pure digit run that exists nowhere
// on the page can be stepped over so the prose after it still anchors. The
// page-wide absence check is what keeps real content digits (table cells like
// 162/197, which the page does contain somewhere) from ever being skipped.
export function alignPage(mdNorm: string, pageNorm: string): AlignResult {
  const segments: AlignSegment[] = []
  const gaps: AlignGap[] = []
  let mi = 0
  let pc = 0
  let matched = 0
  while (mi < mdNorm.length) {
    const k = longestMatchAt(mdNorm, mi, pageNorm, pc)
    if (k >= MIN_RUN) {
      const h = pageNorm.indexOf(mdNorm.slice(mi, mi + k), pc)
      if (h > pc) gaps.push({ mdStart: mi, mdEnd: mi, pageStart: pc, pageEnd: h })
      segments.push({ mdStart: mi, mdEnd: mi + k, pageStart: h, pageEnd: h + k })
      matched += k
      mi += k
      pc = h + k
      continue
    }
    const d = digitNoiseLen(mdNorm, mi)
    if (d > 0) {
      const noise = mdNorm.slice(mi, mi + d)
      const k2 = longestMatchAt(mdNorm, mi + d, pageNorm, pc)
      if (k2 >= MIN_RUN_NOISE && !pageNorm.includes(noise)) {
        const h = pageNorm.indexOf(mdNorm.slice(mi + d, mi + d + k2), pc)
        if (h > pc) gaps.push({ mdStart: mi + d, mdEnd: mi + d, pageStart: pc, pageEnd: h })
        gaps.push({ mdStart: mi, mdEnd: mi + d, pageStart: pc, pageEnd: pc })
        segments.push({ mdStart: mi + d, mdEnd: mi + d + k2, pageStart: h, pageEnd: h + k2 })
        matched += k2
        mi += d + k2
        pc = h + k2
        continue
      }
    }
    let j = mi + 1
    while (j < mdNorm.length && longestMatchAt(mdNorm, j, pageNorm, pc) < MIN_RUN) j++
    if (j >= mdNorm.length) {
      gaps.push({ mdStart: mi, mdEnd: mdNorm.length, pageStart: pc, pageEnd: pageNorm.length })
      break
    }
    const k2 = longestMatchAt(mdNorm, j, pageNorm, pc)
    const h2 = pageNorm.indexOf(mdNorm.slice(j, j + k2), pc)
    gaps.push({ mdStart: mi, mdEnd: j, pageStart: pc, pageEnd: h2 })
    mi = j
  }
  const coverage = mdNorm.length ? matched / mdNorm.length : 1
  const divergent =
    coverage < PROSE_COVERAGE || gaps.some(g => g.mdEnd - g.mdStart >= LARGE_GAP || g.pageEnd - g.pageStart >= LARGE_GAP)
  return { segments, gaps, matchedMdChars: matched, coverage, verdict: divergent ? 'divergent' : 'prose' }
}

// ---------------------------------------------------------------- spans

export interface PageSpan {
  rawStart: number
  rawEnd: number
  readBack: string
  items: Array<{ item: number; startInItem: number; endInItem: number }>
}

export function toPageSpan(idx: PageTextIndex, pageStart: number, pageEnd: number): PageSpan {
  const n2r = idx.normToRaw
  const first = Math.min(pageStart, Math.max(0, n2r.length - 1))
  const last = Math.min(Math.max(pageEnd - 1, pageStart), Math.max(0, n2r.length - 1))
  const rawStart = n2r[first] ?? 0
  const rawEnd = (n2r[last] ?? rawStart) + 1
  const items: PageSpan['items'] = []
  idx.itemRanges.forEach((r, i) => {
    if (r.end > rawStart && r.start < rawEnd) {
      items.push({
        item: i,
        startInItem: Math.max(0, rawStart - r.start),
        endInItem: Math.min(r.end - r.start, rawEnd - r.start),
      })
    }
  })
  return { rawStart, rawEnd, readBack: idx.raw.slice(rawStart, rawEnd), items }
}

export function makeSelectorFromIndex(
  idx: PageTextIndex,
  rawStart: number,
  rawEnd: number,
): TextQuoteSelector {
  return {
    exact: idx.raw.slice(rawStart, rawEnd),
    prefix: idx.raw.slice(Math.max(0, rawStart - 48), rawStart),
    suffix: idx.raw.slice(rawEnd, Math.min(idx.raw.length, rawEnd + 48)),
    page: idx.page,
  }
}

// ---------------------------------------------------------------- resolution

export type ResolveResult =
  | { kind: 'exact'; pageStart: number; pageEnd: number; readBack: string }
  | { kind: 'page'; reason: string }
  | { kind: 'miss'; reason: string }

interface Occurrence {
  start: number
  end: number
}

function findAll(hay: string, needle: string): Occurrence[] {
  const out: Occurrence[] = []
  let i = hay.indexOf(needle)
  while (i !== -1) {
    out.push({ start: i, end: i + needle.length })
    i = hay.indexOf(needle, i + 1)
  }
  return out
}

function disambiguate(
  hay: string,
  positions: Occurrence[],
  sel: TextQuoteSelector,
  norm: (s: string) => string,
): Occurrence | null {
  if (positions.length === 1) return positions[0]
  const p = sel.prefix ? norm(sel.prefix) : ''
  const s = sel.suffix ? norm(sel.suffix) : ''
  if (!p && !s) return null
  let best: Occurrence | null = null
  let bestScore = -1
  let tie = false
  for (const pos of positions) {
    let score = 0
    if (p && pos.start >= p.length && hay.startsWith(p, pos.start - p.length)) score++
    if (s && hay.startsWith(s, pos.end)) score++
    if (score > bestScore) {
      best = pos
      bestScore = score
      tie = false
    } else if (score === bestScore) {
      tie = true
    }
  }
  return tie ? null : best
}

// Reason: a mapped quote may span md-only gaps (interleaved line numbers,
// stray emphasis markers) as long as the page side stays contiguous AND the
// dropped chars are clearly non-content. Page content skipped before/after
// the mapped range sits outside the highlight and is harmless; page content
// skipped *inside* the quote means cell reordering — degrade.
function mapMdRange(align: AlignResult, mdNorm: string, mdStart: number, mdEnd: number): ResolveResult {
  const segs = align.segments.filter(s => s.mdEnd > mdStart && s.mdStart < mdEnd)
  if (segs.length === 0) return { kind: 'page', reason: 'unaligned-region' }
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].pageStart !== segs[i - 1].pageEnd) {
      return { kind: 'page', reason: 'discontinuous-page-content' }
    }
  }
  const benign = (s: string) => s.length === 0 || (s.length <= BENIGN_GAP_MAX && !/\p{L}/u.test(s))
  let cur = mdStart
  for (const seg of segs) {
    if (!benign(mdNorm.slice(cur, seg.mdStart))) {
      return { kind: 'page', reason: 'unalignable-gap' }
    }
    cur = Math.max(cur, seg.mdEnd)
  }
  if (!benign(mdNorm.slice(cur, mdEnd))) {
    return { kind: 'page', reason: 'unalignable-gap' }
  }
  const first = segs[0]
  const lastSeg = segs[segs.length - 1]
  const pageStart = first.pageStart + Math.max(0, mdStart - first.mdStart)
  const pageEnd = lastSeg.pageEnd - Math.max(0, lastSeg.mdEnd - mdEnd)
  return { kind: 'exact', pageStart, pageEnd, readBack: '' }
}

// AI-space resolution: the quote was copied from the projected markdown, so it
// is located in mdNorm first (A-phase validation), then mapped onto the page
// text stream through the alignment.
export function resolveMdQuote(
  mdNorm: string,
  pageIndex: PageTextIndex,
  sel: TextQuoteSelector,
): ResolveResult {
  const q = normalizeMarkdownText(sel.exact)
  if (q.length < MIN_QUOTE) {
    return { kind: 'miss', reason: `quote too short (${q.length} normalized chars, need ${MIN_QUOTE})` }
  }
  const positions = findAll(mdNorm, q)
  if (positions.length === 0) return { kind: 'miss', reason: 'quote not found in markdown view' }
  const pos = disambiguate(mdNorm, positions, sel, normalizeMarkdownText)
  if (!pos) return { kind: 'page', reason: 'ambiguous' }
  const align = alignPage(mdNorm, pageIndex.norm)
  const mapped = mapMdRange(align, mdNorm, pos.start, pos.end)
  if (mapped.kind !== 'exact') return mapped
  const span = toPageSpan(pageIndex, mapped.pageStart, mapped.pageEnd)
  return { kind: 'exact', pageStart: mapped.pageStart, pageEnd: mapped.pageEnd, readBack: span.readBack }
}

// User-space resolution: the quote originates from the pdf.js text layer
// (reader selection), so it is searched in page space directly.
export function resolvePageQuote(
  pageIndex: PageTextIndex,
  sel: TextQuoteSelector,
): ResolveResult {
  const q = normalizePageText(sel.exact)
  if (q.length < MIN_QUOTE) {
    return { kind: 'miss', reason: `quote too short (${q.length} normalized chars, need ${MIN_QUOTE})` }
  }
  const positions = findAll(pageIndex.norm, q)
  if (positions.length === 0) return { kind: 'miss', reason: 'quote not found on page' }
  const pos = disambiguate(pageIndex.norm, positions, sel, normalizePageText)
  if (!pos) return { kind: 'page', reason: 'ambiguous' }
  const span = toPageSpan(pageIndex, pos.start, pos.end)
  return { kind: 'exact', pageStart: pos.start, pageEnd: pos.end, readBack: span.readBack }
}
