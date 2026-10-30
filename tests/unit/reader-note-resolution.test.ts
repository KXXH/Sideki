import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildMarkdownPageIndex,
  buildPageTextIndex,
  normalizeMarkdownText,
  splitMarkdownPages,
  type PageTextIndex,
  type PositionedItem,
} from '../../src/shared/pdf-anchor'
import type { PdfNote } from '../../src/shared/pdf-note-store'
import { degradeLabel, resolveNote, UNANCHORED_LABEL } from '../../src/reader/note-resolution'

// Reason: the reader renders human and AI annotations from one sidecar but the
// two quote provenances live in different text spaces — this pins the routing
// against the same golden fixture the anchor algorithm is measured on.

const FIX = 'tests/fixtures/anchor'
const DOC_MD = readFileSync(`${FIX}/document.md`, 'utf8')
const MD_PAGES = splitMarkdownPages(DOC_MD)
const MD_NORM = buildMarkdownPageIndex(DOC_MD)

function itemsOf(page: number): PositionedItem[] {
  return JSON.parse(readFileSync(`${FIX}/page-${page}.json`, 'utf8')).items
}

const INDEX: Record<number, PageTextIndex> = {}
for (const p of [1, 8, 16]) INDEX[p] = buildPageTextIndex(itemsOf(p), p)

function mdQuote(page: number, startPhrase: string, endPhrase: string): string {
  const text = MD_PAGES.get(page) ?? ''
  const s = text.indexOf(startPhrase)
  expect(s, `start phrase missing on md p${page}`).toBeGreaterThanOrEqual(0)
  const e = text.indexOf(endPhrase, s + startPhrase.length)
  expect(e, `end phrase missing on md p${page}`).toBeGreaterThanOrEqual(0)
  return text.slice(s, e + endPhrase.length)
}

function noteOf(author: PdfNote['author'], page: number, quote: string, extra: Partial<PdfNote> = {}): PdfNote {
  return { id: 'n000001', author, page, quote, color: 'yellow', ts: 0, ...extra }
}

describe('resolveNote: author decides the text space', () => {
  it('anchors an AI quote that crosses margin line numbers', () => {
    // Reason: the markdown projection weaves the review gutter's digits into
    // the prose, so this quote exists in md space only — page-space search
    // (the human path) cannot find it, which is why author routing exists.
    const quote = mdQuote(16, 'Interleaved digits stress', 'still anchors [3]')
    const ai = resolveNote(noteOf('ai', 16, quote), INDEX[16], MD_NORM.get(16) ?? '')
    expect(ai?.kind).toBe('exact')
    const asHuman = resolveNote(noteOf('user', 16, quote), INDEX[16], MD_NORM.get(16) ?? '')
    expect(asHuman?.kind).toBe('miss')
  })

  it('anchors a human quote read back from the page text layer', () => {
    const quote = INDEX[16].raw.slice(
      INDEX[16].raw.indexOf('This supplemental page'),
      INDEX[16].raw.indexOf('neighboring line') + 'neighboring line'.length,
    )
    const r = resolveNote(noteOf('user', 16, quote), INDEX[16], null)
    expect(r?.kind).toBe('exact')
  })

  it('reports pending while an AI note waits for its page markdown', () => {
    // Reason: null must not be conflated with failure — the band layer skips
    // the note this frame instead of flashing a wrong page-level box.
    const quote = mdQuote(16, 'Interleaved digits stress', 'still anchors [3]')
    expect(resolveNote(noteOf('ai', 16, quote), INDEX[16], null)).toBeNull()
  })

  it('does not make a human note wait for markdown it never needs', () => {
    const quote = 'SYNTHETIC FIXTURE AUTHORS AND AFFILIATIONS'
    expect(resolveNote(noteOf('user', 16, quote), INDEX[16], null)?.kind).toBe('exact')
  })
})

describe('AI underscore-emphasis quotes', () => {
  it.each(['_', '__', '___'])('anchors %s emphasis to the original page text', delimiter => {
    const raw = 'This paragraph contains important evidence for the reader.'
    const index = buildPageTextIndex([{
      str: raw, width: 300, height: 12, hasEOL: false, transform: [12, 0, 0, 12, 20, 100],
    }], 1)
    const quote = `${delimiter}important evidence${delimiter}`
    const md = normalizeMarkdownText(raw.replace('important evidence', quote))
    expect(resolveNote(noteOf('ai', 1, quote), index, md)).toMatchObject({
      kind: 'exact', readBack: 'important evidence',
    })
  })
})

describe('degraded and unanchored labels', () => {
  it('labels a table row quote that cannot align with the page text', () => {
    // Reason: the split column head hits an unalignable md-only gap, measured
    // against the fixture — not a guess at which reason the resolver returns.
    const r = resolveNote(noteOf('ai', 8, '|Model|EN-DE|EN-FR|EN-DE||EN-FR|'), INDEX[8], MD_NORM.get(8) ?? '')
    expect(r?.kind).toBe('page')
    if (r?.kind === 'page') {
      expect(r.reason).toBe('unalignable-gap')
      expect(degradeLabel(r.reason)).toBe('引文与页面文本无法对齐（页级批注）')
    }
  })

  it('gives the reordered author block the same alignment label', () => {
    const quote = mdQuote(1, 'Jakob proposed replacing RNNs', 'evaluate this idea')
    const r = resolveNote(noteOf('ai', 1, quote), INDEX[1], MD_NORM.get(1) ?? '')
    expect(r?.kind).toBe('page')
    if (r?.kind === 'page') {
      expect(r.reason).toBe('unaligned-region')
      expect(degradeLabel(r.reason)).toBe('引文与页面文本无法对齐（页级批注）')
    }
  })

  it('labels an ambiguous repeated quote distinctly from a table degrade', () => {
    const r = resolveNote(
      noteOf('ai', 16, 'Nothing in this paragraph carries semantic'),
      INDEX[16],
      MD_NORM.get(16) ?? '',
    )
    expect(r?.kind).toBe('page')
    if (r?.kind === 'page') expect(degradeLabel(r.reason)).toBe('引文未能唯一定位（页级批注）')
  })

  it('falls back to a generic label for an unknown reason', () => {
    expect(degradeLabel('something-new')).toBe('引文未能精确定位（页级批注）')
  })

  it('marks a quote that is nowhere on the claimed page', () => {
    const r = resolveNote(noteOf('ai', 16, 'this sentence appears in no fixture page at all'), INDEX[16], MD_NORM.get(16) ?? '')
    expect(r?.kind).toBe('miss')
    expect(UNANCHORED_LABEL).toBe('引文无法在本页定位')
  })
})
