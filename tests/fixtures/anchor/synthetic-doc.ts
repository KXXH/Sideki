// Synthetic line-numbered page (fixture page 16): reproduces the review-stage
// gutter layout that camera-ready formats omit — 52 left-margin line numbers
// woven into the markdown reading order, plus emphasis pairs and a hyphenated
// line break. Reason: the committed fixture combines public-paper pages (no
// line numbers) with this fully synthetic page so the margin filter and the
// digit-noise skip keep their dedicated coverage.
import type { PageSpec, TextOp } from './pdf-writer'

// Helvetica AFM widths (per mille), ASCII 32..126. Bold differs from regular.
const W_REG: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778,
  R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222,
  j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333,
  s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
}
const W_BOLD: Record<string, number> = {
  ' ': 278, '!': 333, '"': 474, '#': 556, '$': 556, '%': 889, '&': 722, "'": 238,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611,
  '@': 975, A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778,
  R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 333, '\\': 278, ']': 333, '^': 584, '_': 556, '`': 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278,
  j: 278, k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389,
  s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  '{': 389, '|': 280, '}': 389, '~': 584,
}

export function textWidth(s: string, font: TextOp['font'], size: number): number {
  const table = font === 'bold' ? W_BOLD : W_REG
  let w = 0
  for (const ch of s) w += (table[ch] ?? 556) * size / 1000
  return w
}

const SIZE = 9
const LEAD = 11
const TOP_Y = 688
const X = 73
const LINE_W = 428
const ROW_Y = (row: number) => TOP_Y - LEAD * row

export interface Run {
  t: string
  f?: 'bold' | 'ital'
}

// Reason: measures with the exact AFM widths so wrapped lines never overflow;
// spaces between runs are preserved so adjacent font runs stay distinguishable.
export function wrap(runs: Run[]): Array<Run[]> {
  const out: Run[][] = [[]]
  let w = 0
  const emit = (piece: string, f: Run['f']) => {
    if (!piece) return
    const last = out[out.length - 1]
    const prev = last[last.length - 1]
    if (prev && (prev.f ?? 'reg') === (f ?? 'reg')) prev.t += piece
    else last.push({ t: piece, f })
  }
  for (const run of runs) {
    for (const word of run.t.split(/( +)/)) {
      if (!word) continue
      const ww = textWidth(word, run.f ?? 'reg', SIZE)
      if (w > 0 && w + ww > LINE_W && word.trim() !== '') {
        out.push([])
        w = 0
        if (word.trim() === '') continue
      }
      emit(word, run.f)
      w += ww
    }
  }
  return out
}

const PARA_1 =
  'This supplemental page is a synthetic construction that reproduces the review-stage gutter layout, which camera-ready formats omit before publication. The numbered gutter along the left edge interleaves line digits into the projected reading order, while the geometric page stream omits them entirely, and every anchoring decision must tolerate that divergence without silently drifting onto a neighboring line.'

const PARA_2 =
  'Interleaved digits stress the sequential alignment walk [1, 2] because a pure digit run exists nowhere on the page and must be stepped over so the prose after it still anchors [3]. Coverage thresholds absorb a bounded amount of this noise, but a genuine reordering of table cells still degrades the affected quote to page level rather than anchoring it onto the wrong glyphs.'

const PARA_3_PRE = 'Across the pilot sessions this design reduced the annotation workload to '
const PARA_3_BOLD = 'sixteen verbatim quotes per annotator'
const PARA_3_POST = ' in every session, a pace that kept the coders attentive while still finishing each batch within one afternoon.'

const PARA_4_A = 'A deliberate hyphenation across the line boundary, as in interleaved-'
const PARA_4_B = 'digits and margin-aware spans, must reunify during normalization so that a quote copied from either view resolves to the same page span.'

const PARA_5 =
  'The remaining rows are filler prose so that every numbered line of the gutter has body text at the same height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic weight; it exists so the geometry stays dense.'

export function buildSyntheticPage(): PageSpec {
  const marginNumbers = Array.from({ length: 52 }, (_, i) => ({
    text: String(i + 1),
    x: 47,
    y: ROW_Y(i),
  }))

  const ops: TextOp[] = []
  const rows: Array<{ runs: Run[] } | null> = []
  const pushPara = (lines: Run[][]) => {
    for (const l of lines) rows.push({ runs: l })
    rows.push(null)
  }

  rows.push({ runs: [{ t: 'Appendix A: Synthetic Anchoring Supplement', f: 'bold' }] })
  // Reason: >=24 normalized chars so the authors line forms its own aligned
  // segment — a short line between gutter numbers gets absorbed into the
  // alignment gap and any quote crossing it would degrade to page level.
  rows.push({ runs: [{ t: 'SYNTHETIC FIXTURE AUTHORS AND AFFILIATIONS' }] })
  rows.push(null)
  pushPara(wrap([{ t: PARA_1 }]))
  pushPara(wrap([{ t: PARA_2 }]))
  pushPara(wrap([{ t: PARA_3_PRE }, { t: PARA_3_BOLD, f: 'bold' }, { t: PARA_3_POST }]))
  // Reason: hand-lined so the hyphenation break is deterministic.
  pushPara([[{ t: PARA_4_A }], [{ t: PARA_4_B }]])
  pushPara(wrap([{ t: PARA_5 }]))

  // fill remaining numbered rows with additional wrapped filler paragraphs
  let extra = 0
  while (rows.length < 52) {
    const lines = wrap([{ t: `Filler passage ${extra + 1}: the gutter keeps counting while the body keeps wrapping, and the alignment keeps walking. ` + PARA_5 }])
    for (const l of lines) {
      if (rows.length >= 52) break
      rows.push({ runs: l })
    }
    rows.push(null)
    extra++
  }
  rows.length = 52

  rows.forEach((row, i) => {
    if (!row) return
    let x = X
    for (const run of row.runs) {
      ops.push({ text: run.t, x, y: ROW_Y(i), font: run.f ?? 'reg', size: run.f === 'bold' ? SIZE : SIZE })
      x += textWidth(run.t, run.f ?? 'reg', SIZE)
    }
  })

  return { marginNumbers, ops }
}
