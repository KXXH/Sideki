// Minimal PDF writer: pages of positioned text with Helvetica family fonts.
// Reason: the anchor fixture needs a synthetic PDF whose draw order we control
// (margin line numbers as one leading block, row-major table cells) — a
// hand-rolled writer is ~150 lines and needs no dependencies.

const PAGE_W = 612
const PAGE_H = 792

type Op = string

export interface TextOp {
  text: string
  x: number
  y: number
  font: 'reg' | 'bold' | 'ital'
  size: number
}

export interface PageSpec {
  // Drawn first, as one block at page start (mimics the ACM lineno pass).
  marginNumbers?: Array<{ text: string; x: number; y: number }>
  ops: TextOp[]
  // Filled rectangles (table rules) drawn before the text ops.
  rects?: Array<{ x: number; y: number; w: number; h: number; gray: number }>
}

// Reason: WinAnsi covers everything we draw; escaping ()\ keeps the string op
// valid. Non-ASCII is rejected loudly so the fixture never depends on the
// encoder's error behavior.
function esc(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error(`non-ASCII text: ${JSON.stringify(s)}`)
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

const FONT_RES: Record<TextOp['font'], { res: string; base: string }> = {
  reg: { res: 'F1', base: 'Helvetica' },
  bold: { res: 'F2', base: 'Helvetica-Bold' },
  ital: { res: 'F3', base: 'Helvetica-Oblique' },
}

function contentStream(page: PageSpec): string {
  const out: Op[] = []
  for (const r of page.rects ?? []) {
    out.push(`${r.gray} g`, `${r.x} ${r.y} ${r.w} ${r.h} re f`, `0 g`)
  }
  for (const m of page.marginNumbers ?? []) {
    out.push('BT /F1 9 Tf 0 g', `1 0 0 1 ${m.x} ${m.y} Tm`, `(${esc(m.text)}) Tj ET`)
  }
  let cur: TextOp['font'] | null = null
  let curSize = 0
  for (const t of page.ops) {
    const f = FONT_RES[t.font]
    if (t.font !== cur || t.size !== curSize) {
      out.push(`BT /${f.res} ${t.size} Tf 0 g`)
      cur = t.font
      curSize = t.size
    } else {
      out.push('BT')
    }
    out.push(`1 0 0 1 ${t.x} ${t.y} Tm`, `(${esc(t.text)}) Tj ET`)
  }
  return out.join('\n')
}

export function buildPdf(pages: PageSpec[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => {
    objects.push(body)
    return objects.length
  }

  const fontIds: Record<string, number> = {}
  for (const key of ['reg', 'bold', 'ital'] as const) {
    fontIds[FONT_RES[key].res] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_RES[key].base} /Encoding /WinAnsiEncoding >>`)
  }
  const contentIds = pages.map(p => add(`<< /Length ${contentStream(p).length} >>\nstream\n${contentStream(p)}\nendstream`))
  const pagesObjId = objects.length + pages.length + 1
  const pageIds = pages.map(() =>
    add(
      `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R >> >> ` +
      `/Contents 0 R >>`,
    ),
  )
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  const rootId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`)
  // Reason: contents reference their page positionally — patch after page ids exist.
  pageIds.forEach((pageId, i) => {
    objects[pageId - 1] = objects[pageId - 1].replace('/Contents 0 R', `/Contents ${contentIds[i]} 0 R`)
  })

  const enc = new TextEncoder()
  const bytes: number[] = [...enc.encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')]
  const push = (s: string) => {
    for (const x of enc.encode(s)) bytes.push(x)
  }
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets[i] = bytes.length
    push(`${i + 1} 0 obj\n${obj}\nendobj\n`)
  })
  const xrefStart = bytes.length
  push(`xref\n0 ${objects.length + 1}\n`)
  push('0000000000 65535 f \n')
  for (const off of offsets) push(`${String(off).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)
  return new Uint8Array(bytes)
}
