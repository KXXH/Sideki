import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  type PositionedItem,
  type PageTextIndex,
  excludeMarginItems,
  stripMarkdownSyntax,
  buildPageTextIndex,
  buildMarkdownPageIndex,
  splitMarkdownPages,
  alignPage,
  resolveMdQuote,
  resolvePageQuote,
  makeSelectorFromIndex,
  toPageSpan,
} from '../../src/shared/pdf-anchor'

// Reason: fixture combines two sources — pages 1/2/6/8 of arXiv 1706.03762v7
// ("Attention Is All You Need", public) covering prose, emphasis and two
// reordered tables, plus a fully synthetic page 16 with a 52-number review
// gutter (see generate-fixture.mjs). The hard cases: p1's reordered author
// block and rotated arXiv stamp (unaligned region), p6/p8 tables, p16's
// interleaved margin digits. Every quote below is anchored by start/end
// phrases that exist verbatim in both the markdown view and the pdf.js text
// stream, so the expected readBack is extracted from the same ground truth
// the resolver must independently find.

const FIX = 'tests/fixtures/anchor'

function itemsOf(page: number): PositionedItem[] {
  return JSON.parse(readFileSync(`${FIX}/page-${page}.json`, 'utf8')).items
}

const DOC_MD = readFileSync(`${FIX}/document.md`, 'utf8')
const MD_PAGES = splitMarkdownPages(DOC_MD)
const MD_NORM = buildMarkdownPageIndex(DOC_MD)

const INDEX: Record<number, PageTextIndex> = {}
for (const p of [1, 2, 6, 8, 16]) {
  INDEX[p] = buildPageTextIndex(itemsOf(p), p)
}

function mdQuote(page: number, startPhrase: string, endPhrase: string): string {
  const text = MD_PAGES.get(page) ?? ''
  const s = text.indexOf(startPhrase)
  expect(s, `start phrase not found on md p${page}: ${JSON.stringify(startPhrase)}`).toBeGreaterThanOrEqual(0)
  const e = text.indexOf(endPhrase, s + startPhrase.length)
  expect(e, `end phrase not found on md p${page}: ${JSON.stringify(endPhrase)}`).toBeGreaterThanOrEqual(0)
  return text.slice(s, e + endPhrase.length)
}

function rawSpan(page: number, startPhrase: string, endPhrase: string): string {
  const text = INDEX[page].raw
  const s = text.indexOf(startPhrase)
  expect(s, `start phrase not found on raw p${page}: ${JSON.stringify(startPhrase)}`).toBeGreaterThanOrEqual(0)
  const e = text.indexOf(endPhrase, s + startPhrase.length)
  expect(e, `end phrase not found on raw p${page}: ${JSON.stringify(endPhrase)}`).toBeGreaterThanOrEqual(0)
  return text.slice(s, e + endPhrase.length)
}

function resolveMd(page: number, exact: string, ctx?: { prefix?: string; suffix?: string }) {
  return resolveMdQuote(MD_NORM.get(page) ?? '', INDEX[page], {
    exact,
    prefix: ctx?.prefix,
    suffix: ctx?.suffix,
    page,
  })
}

// ---------------------------------------------------------------- gate 4

describe('stripMarkdownSyntax false positives (gate 4)', () => {
  it('keeps mid-line hash, spaced asterisk and intraword underscore', () => {
    expect(stripMarkdownSyntax('Use a #5 wrench')).toBe('Use a #5 wrench')
    expect(stripMarkdownSyntax('a * b')).toBe('a * b')
    expect(stripMarkdownSyntax('a * b * c')).toBe('a * b * c')
    expect(stripMarkdownSyntax('snake_case_word')).toBe('snake_case_word')
    expect(stripMarkdownSyntax('the value x_1 is fine')).toBe('the value x_1 is fine')
  })

  it.each(['_', '__', '___'])('strips %s emphasis without losing its content or flanks', delimiter => {
    expect(stripMarkdownSyntax(`${delimiter}important evidence${delimiter}`)).toBe('important evidence')
    expect(stripMarkdownSyntax(`See (${delimiter}important evidence${delimiter}), then continue.`))
      .toBe('See (important evidence), then continue.')
    expect(stripMarkdownSyntax(`snake_case and ${delimiter}important evidence${delimiter} snake_case_word`))
      .toBe('snake_case and important evidence snake_case_word')
  })

  it('keeps escaped literals even when they would pair', () => {
    expect(stripMarkdownSyntax('a \\*literal\\* b')).toBe('a *literal* b')
    expect(stripMarkdownSyntax('a \\_literal\\_ b')).toBe('a _literal_ b')
    expect(stripMarkdownSyntax('C\\# not a heading')).toBe('C# not a heading')
    for (const delimiter of ['_', '__', '___']) {
      const escaped = delimiter.replaceAll('_', '\\_')
      expect(stripMarkdownSyntax(`${escaped}important evidence${escaped}`))
        .toBe(`${delimiter}important evidence${delimiter}`)
    }
  })

  it('strips real emphasis, headings, quotes, tables and links', () => {
    expect(stripMarkdownSyntax('*italic*')).toBe('italic')
    expect(stripMarkdownSyntax('**bold**')).toBe('bold')
    expect(stripMarkdownSyntax('***all***')).toBe('all')
    expect(stripMarkdownSyntax('4*×*10*×*2=80')).toBe('4×10×2=80')
    expect(stripMarkdownSyntax('## 6 Anon.')).toBe('6 Anon.')
    expect(stripMarkdownSyntax('# Heading')).toBe('Heading')
    expect(stripMarkdownSyntax('> quoted line')).toBe('quoted line')
    expect(stripMarkdownSyntax('|Aspect|N1|N2|Example|')).toBe('AspectN1N2Example')
    expect(stripMarkdownSyntax('|---|---|---|---|')).toBe('\n')
    expect(stripMarkdownSyntax('[text](https://x.y)')).toBe('text')
    expect(stripMarkdownSyntax('<u>underlined</u>')).toBe('underlined')
    expect(stripMarkdownSyntax('<!-- Page 7 -->')).toBe('')
    expect(stripMarkdownSyntax('[FF: note] stays')).toBe('[FF: note] stays')
  })

  it('keeps brackets that are real citations, both flanks intact', () => {
    expect(stripMarkdownSyntax('models [13, 7] and networks [35, 2, 5]')).toBe(
      'models [13, 7] and networks [35, 2, 5]',
    )
  })

  it('documented residual false positive: literal pipe is table syntax', () => {
    // Reason: pipes are unambiguous table structure in this pipeline; a
    // literal "|" in prose is rare enough to accept losing.
    expect(stripMarkdownSyntax('a | b')).toBe('a  b')
  })
})

// ---------------------------------------------------------------- gate 3

describe('excludeMarginItems (gate 3)', () => {
  it('removes exactly the 52 margin line numbers on the gutter page, none elsewhere', () => {
    // Reason: only the synthetic page 16 carries a review gutter; the public
    // paper pages must pass through untouched (their digit-only items are
    // table cells or stamps sitting right of the letters).
    for (const p of [1, 2, 6, 8]) {
      const items = itemsOf(p)
      expect(excludeMarginItems(items).length, `page ${p}`).toBe(items.length)
    }
    const items = itemsOf(16)
    const filtered = excludeMarginItems(items)
    expect(items.length - filtered.length).toBe(52)
    for (const removed of items.filter(it => !filtered.includes(it))) {
      expect(removed.str.trim(), 'page 16 removed non-digit').toMatch(/^\d+$/)
    }
  })

  it('lets gutter quotes resolve identically without the filter (block-at-start order)', () => {
    // Reason: the gutter is drawn as one block at page start, so the
    // sequential walk absorbs it into a leading page-skip that sits outside
    // any highlight. The filter is robustness against interleaved layouts and
    // a clean selection space, not a prerequisite for mapping on this fixture.
    const quote = mdQuote(16, 'This supplemental page', 'neighboring line')
    const expected = rawSpan(16, 'This supplemental page', 'neighboring line')
    const unfiltered = buildPageTextIndex(itemsOf(16), 16, { excludeMargin: false })
    const r = resolveMdQuote(MD_NORM.get(16) ?? '', unfiltered, { exact: quote, page: 16 })
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.readBack).toBe(expected)
  })

  it('anchors the gutter-page opening on both filtered and unfiltered indexes', () => {
    const quote = mdQuote(16, '**Appendix A: Synthetic Anchoring Supplement**', 'SYNTHETIC FIXTURE AUTHORS AND AFFILIATIONS')
    const expected = rawSpan(16, 'Appendix A: Synthetic Anchoring Supplement', 'SYNTHETIC FIXTURE AUTHORS AND AFFILIATIONS')
    for (const excludeMargin of [true, false]) {
      const idx = buildPageTextIndex(itemsOf(16), 16, { excludeMargin })
      const r = resolveMdQuote(MD_NORM.get(16) ?? '', idx, { exact: quote, page: 16 })
      expect(r.kind, `excludeMargin=${excludeMargin}`).toBe('exact')
      if (r.kind === 'exact') expect(r.readBack).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------- verdicts

describe('page alignment verdicts', () => {
  it('classifies prose vs divergent pages', () => {
    const verdict = (p: number) => alignPage(MD_NORM.get(p) ?? '', INDEX[p].norm)
    expect(verdict(2).verdict).toBe('prose')
    expect(verdict(6).verdict).toBe('prose')
    expect(verdict(8).verdict).toBe('prose')
    expect(verdict(16).verdict).toBe('prose')
    // Reason: p1's author block reorders name/affiliation/email runs and the
    // rotated arXiv stamp sits mid-reading-order — the page is honestly
    // divergent even though its abstract zone anchors cleanly.
    expect(verdict(1).verdict).toBe('divergent')
    for (const p of [1, 2, 6, 8, 16]) {
      const a = verdict(p)
      console.log(`p${p}: coverage=${(a.coverage * 100).toFixed(2)}% segments=${a.segments.length} gaps=${a.gaps.length} verdict=${a.verdict}`)
    }
  })
})

// ---------------------------------------------------------------- gate 2

const PROSE_CASES: Array<{
  name: string
  page: number
  start: string
  end: string
  rawStart?: string
  rawEnd?: string
}> = [
  { name: 'p1 abstract opening', page: 1, start: 'The dominant sequence transduction models', end: 'include an encoder and a decoder' },
  { name: 'p1 attention mechanism sentence', page: 1, start: 'performing models also connect', end: 'through an attention' },
  { name: 'p1 architecture proposal', page: 1, start: 'We propose a new simple network architecture, the Transformer,', end: 'recurrence and convolutions' },
  { name: 'p1 experiments sentence', page: 1, start: 'Experiments on two machine translation tasks show these models to', end: 'requiring significantly' },
  { name: 'p1 BLEU result', page: 1, start: 'Our model achieves 28.4 BLEU on the WMT 2014 English-', end: 'best results, including' },
  { name: 'p2 intro opening with citations', page: 2, start: 'Recurrent neural networks', end: 'language modeling and machine translation' },
  { name: 'p2 recurrent models sentence', page: 2, start: 'Recurrent models typically factor', end: 'along the symbol positions of the input and output' },
  { name: 'p2 hidden states crossing mangled emphasis', page: 2, start: 'Aligning the positions to steps', end: 'the input for position' },
  { name: 'p2 parallelization constraint', page: 2, start: 'sequential nature precludes parallelization', end: 'batching across examples' },
  { name: 'p2 transformer proposal', page: 2, start: 'In this work we propose the Transformer', end: 'between input and output' },
  { name: 'p2 background opening', page: 2, start: 'The goal of reducing sequential computation', end: 'neural networks as basic building' },
  { name: 'p2 self-attention definition', page: 2, start: 'Self-attention, sometimes called intra-attention', end: 'representation of the sequence' },
  { name: 'p2 hyphenated linebreak (sequence- aligned)', page: 2, start: 'End-to-end memory networks', end: 'language modeling tasks' },
  { name: 'p2 first-transduction claim', page: 2, start: 'To the best of our knowledge', end: 'entirely on self-attention' },
  { name: 'p6 table caption', page: 6, start: 'Table 1: Maximum path lengths', end: 'sequential operations' },
  { name: 'p6 positional encoding motivation', page: 6, start: 'Since our model contains no recurrence', end: 'relative or absolute position of the' },
  { name: 'p6 sinusoid choice', page: 6, start: 'chose this function because', end: 'learn to attend by' },
  { name: 'p6 table reference sentence', page: 6, start: 'As noted in Table 1', end: 'a constant number of sequentially' },
  { name: 'p8 dropout sentence', page: 8, start: 'In addition, we apply dropout', end: 'encoder and decoder stacks' },
  { name: 'p8 label smoothing crossing bold lead and mangled math', page: 8, start: 'During training, we employed label smoothing', end: 'improves accuracy and BLEU score' },
  { name: 'p8 training cost', page: 8, start: 'Training took', end: 'P100 GPUs' },
  { name: 'p8 beam search crossing mangled math', page: 8, start: 'used beam search with a beam size of 4', end: 'length penalty *α* = 0*.*6', rawEnd: 'length penalty α = 0.6' },
  { name: 'p8 table 2 summary', page: 8, start: 'Table 2 summarizes our results', end: 'architectures from the literature' },
  { name: 'p16 opening paragraph crossing line numbers 4-7', page: 16, start: 'This supplemental page', end: 'neighboring line' },
  { name: 'p16 digit-noise paragraph crossing line numbers 9-12', page: 16, start: 'Interleaved digits stress', end: 'still anchors [3]' },
  { name: 'p16 workload sentence with bold pair and line number 15', page: 16, start: 'reduced the annotation workload', end: 'within one' },
  { name: 'p16 hyphenated boundary first half', page: 16, start: 'A deliberate hyphenation', end: 'as in interleaved' },
]

const PROSE_LITERALS: Array<{ name: string; page: number; literal: string }> = [
  { name: 'p6 single-line desideratum', page: 6, literal: 'One is the total computational complexity per layer.' },
  { name: 'p6 single-line path-length sentence', page: 6, literal: 'The third is the path length between long-range dependencies in the network.' },
  { name: 'p8 training cost sentence with mangled decimal', page: 8, literal: 'Training took 3.5 days on 8 P100 GPUs.' },
  { name: 'p8 checkpoint averaging', page: 8, literal: 'For the big models, we averaged the last 20 checkpoints.' },
  { name: 'p16 author line under the gutter', page: 16, literal: 'SYNTHETIC FIXTURE AUTHORS AND AFFILIATIONS' },
]

describe('AI-quote resolution on prose (gate 2)', () => {
  const results: Array<{ name: string; kind: string; reason?: string }> = []

  for (const c of PROSE_CASES) {
    it(`resolves: ${c.name}`, () => {
      const quote = mdQuote(c.page, c.start, c.end)
      const expected = rawSpan(c.page, c.rawStart ?? c.start, c.rawEnd ?? c.end)
      const r = resolveMd(c.page, quote)
      results.push({ name: c.name, kind: r.kind, reason: r.kind === 'exact' ? undefined : r.reason })
      expect(r.kind).toBe('exact')
      if (r.kind === 'exact') {
        expect(r.readBack).toBe(expected)
        const span = toPageSpan(INDEX[c.page], r.pageStart, r.pageEnd)
        expect(span.readBack).toBe(expected)
        expect(span.items.length).toBeGreaterThan(0)
      }
    })
  }

  for (const c of PROSE_LITERALS) {
    it(`resolves literal: ${c.name}`, () => {
      const r = resolveMd(c.page, c.literal)
      results.push({ name: c.name, kind: r.kind, reason: r.kind === 'exact' ? undefined : r.reason })
      expect(r.kind).toBe('exact')
      if (r.kind === 'exact') expect(r.readBack).toBe(c.literal)
    })
  }

  it('resolves at least 95% of prose quotes to exact (gate 2)', () => {
    const total = PROSE_CASES.length + PROSE_LITERALS.length
    const exact = results.filter(r => r.kind === 'exact').length
    console.log(`prose quotes: ${exact}/${total} exact\n${results.filter(r => r.kind !== 'exact').map(r => `  MISS ${r.name}: ${r.kind} ${r.reason}`).join('\n')}`)
    expect(exact / total).toBeGreaterThanOrEqual(0.95)
  })
})

// ---------------------------------------------------------------- gate 1

describe('table and reordered-region quotes degrade to page level (gate 1)', () => {
  it('p1 author-block sentence degrades (reordered name/affiliation runs)', () => {
    const quote = mdQuote(1, 'Jakob proposed replacing RNNs', 'evaluate this idea')
    const r = resolveMd(1, quote)
    expect(r.kind).toBe('page')
  })

  it('p1 author-block contribution sentence degrades', () => {
    const quote = mdQuote(1, 'Ashish, with Illia', 'every aspect of this work')
    const r = resolveMd(1, quote)
    expect(r.kind).toBe('page')
  })

  it('p1 generalization sentence degrades (unaligned region)', () => {
    const quote = mdQuote(1, 'We show that the Transformer generalizes', 'limited training data')
    const r = resolveMd(1, quote)
    expect(r.kind).toBe('page')
  })

  it('p8 table 2 header row degrades (split column head)', () => {
    const r = resolveMd(8, '|Model|EN-DE|EN-FR|EN-DE||EN-FR|')
    expect(r.kind).toBe('page')
  })

  it('p8 section start degrades (stray exponent digits break the alignment gap)', () => {
    // Reason: pdf-inspector lifts the table's superscript exponents into a
    // stray md-only number block right where section 6.2 begins — a quote
    // spanning it hits an unalignable gap and must fall back to page level.
    const quote = mdQuote(8, '#### 6.2 Model Variations', 'translation on the')
    const r = resolveMd(8, quote)
    expect(r.kind).toBe('page')
  })

  it('single-row table quotes anchor exactly with correct read-back', () => {
    const r1 = resolveMd(6, '|Self-Attention|O ( n² · d|) O (1)|O (1)|')
    expect(r1.kind).toBe('exact')
    if (r1.kind === 'exact') {
      expect(r1.readBack).toBe('Self-Attention O(n2 · d) O(1) O(1)')
    }

    const r2 = resolveMd(8, '|Transformer (base model)|27.3|38.1||3.3 · 10||')
    expect(r2.kind).toBe('exact')
    // Reason: the md view lost the exponent digits (10^18 → "10"), so the
    // mapped span stops where the quote ends — the page-side "18" sits just
    // outside the highlight, which is the honest, harmless outcome.
    if (r2.kind === 'exact') expect(r2.readBack).toBe('Transformer (base model) 27.3 38.1 3.3 · 10')

    const r3 = resolveMd(8, '|ByteNet [18]|23.75|||||')
    expect(r3.kind).toBe('exact')
    if (r3.kind === 'exact') expect(r3.readBack).toBe('ByteNet [18] 23.75')
  })
})

// ---------------------------------------------------------------- user space

describe('user-space resolution (page quotes)', () => {
  it('anchors a single-line selection', () => {
    const exact = 'Training took 3.5 days on 8 P100 GPUs.'
    const r = resolvePageQuote(INDEX[8], { exact, page: 8 })
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.readBack).toBe(exact)
  })

  it('anchors a selection spanning a raw line break', () => {
    const exact =
      'Recurrent models typically factor computation along the symbol positions of the input and output\nsequences.'
    const r = resolvePageQuote(INDEX[2], { exact, page: 2 })
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.readBack).toBe(exact)
  })

  it('anchors a gutter-page selection spanning a raw line break', () => {
    const exact =
      'This supplemental page is a synthetic construction that reproduces the review-stage gutter layout, which\ncamera-ready formats omit before publication.'
    const r = resolvePageQuote(INDEX[16], { exact, page: 16 })
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.readBack).toBe(exact)
  })

  it('round-trips makeSelectorFromIndex through resolvePageQuote', () => {
    const expected = rawSpan(2, 'The fundamental', 'remains.')
    const idx = INDEX[2]
    const start = idx.raw.indexOf('The fundamental')
    const sel = makeSelectorFromIndex(idx, start, start + expected.length)
    expect(sel.exact).toBe(expected)
    const r = resolvePageQuote(idx, sel)
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.readBack).toBe(expected)
  })
})

// ---------------------------------------------------------------- failure modes

describe('failure modes are actionable, never silent', () => {
  it('ambiguous page quote without context degrades to page', () => {
    const r = resolvePageQuote(INDEX[2], { exact: 'state of the art', page: 2 })
    expect(r.kind).toBe('page')
  })

  it('ambiguous page quote resolves with a suffix', () => {
    const r = resolvePageQuote(INDEX[2], { exact: 'state of the art', suffix: 'approaches', page: 2 })
    expect(r.kind).toBe('exact')
  })

  it('unique page quote anchors', () => {
    const r = resolvePageQuote(INDEX[2], { exact: 'state of the art approaches', page: 2 })
    expect(r.kind).toBe('exact')
  })

  it('repeated gutter filler degrades in both spaces', () => {
    expect(resolveMd(16, 'Nothing in this paragraph carries semantic').kind).toBe('page')
    expect(resolvePageQuote(INDEX[16], { exact: 'Nothing in this paragraph carries semantic', page: 16 }).kind).toBe('page')
  })

  it('ambiguous md quote resolves with suffix context', () => {
    // Reason: the four filler paragraphs are textually identical — only the
    // woven line number after the quote differs, so a suffix containing it
    // disambiguates while staying outside the highlight.
    const r = resolveMd(16, 'Nothing in this paragraph carries semantic', { suffix: '23 weight' })
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') {
      expect(r.readBack).toBe('Nothing in this paragraph carries semantic')
    }
  })

  it('ambiguous md quote on the author block degrades to page', () => {
    expect(resolveMd(1, 'Google Brain').kind).toBe('page')
  })

  it('quote fragment cutting an emphasis pair is a miss, not a wrong anchor', () => {
    // Reason: a fragment that opens a bold run without closing it keeps the
    // raw markers and no longer matches the markdown view — A-phase reports
    // this so the model re-copies a span with balanced markers.
    const quote = mdQuote(16, 'reduced the annotation workload to', 'verbatim quotes')
    const r = resolveMd(16, quote)
    expect(r.kind).toBe('miss')
  })

  it('paraphrased quote is a miss', () => {
    const r = resolveMd(2, 'transformers rely entirely on recurrence')
    expect(r.kind).toBe('miss')
  })

  it('too-short quote is a miss', () => {
    const r = resolveMd(2, 'BLEU')
    expect(r.kind).toBe('miss')
  })
})
