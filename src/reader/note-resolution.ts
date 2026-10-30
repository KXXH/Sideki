// Anchor resolution for reader annotations — deliberately free of pdfjs and DOM
// imports so it can be unit-tested against the golden fixture directly.
import { resolveMdQuote, resolvePageQuote, type PageTextIndex, type ResolveResult } from '../shared/pdf-anchor'
import type { PdfNote } from '../shared/pdf-note-store'

// Reason: a user quote was read back from the pdf.js text layer, so it lives in
// page space; an AI quote was copied from the markdown projection, which
// interleaves margin line numbers and emphasis markers — searching page space
// for it would miss. Returns null while that page's markdown is still loading.
export function resolveNote(
  note: PdfNote,
  index: PageTextIndex,
  mdNorm: string | null,
): ResolveResult | null {
  const sel = { exact: note.quote, prefix: note.prefix, suffix: note.suffix, page: note.page }
  if (note.author !== 'ai') return resolvePageQuote(index, sel)
  if (mdNorm === null) return null
  return resolveMdQuote(mdNorm, index, sel)
}

// Reason: only reasons demonstrated against the golden fixture get their own
// wording — 'unalignable-gap' (a table row or lifted exponents inside the
// quote) and 'unaligned-region' (a reordered author block) mean the same thing
// to a reader, so they share one. Anything else takes the generic label.
const DEGRADE_LABEL: Record<string, string> = {
  ambiguous: '引文未能唯一定位（页级批注）',
  'unalignable-gap': '引文与页面文本无法对齐（页级批注）',
  'unaligned-region': '引文与页面文本无法对齐（页级批注）',
}

export function degradeLabel(reason: string): string {
  return DEGRADE_LABEL[reason] ?? '引文未能精确定位（页级批注）'
}

export const UNANCHORED_LABEL = '引文无法在本页定位'
