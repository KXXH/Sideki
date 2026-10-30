// Regenerates the anchor fixture from two sources:
//   1. arXiv 1706.03762v7 (Attention Is All You Need) — public paper, pages
//      1, 2, 6, 8: prose, emphasis, two complex reordered tables.
//   2. synthetic line-numbered page (pdf-writer + synthetic-doc) — page 16,
//      covering the review-gutter layout the public paper lacks.
// The source PDF is NOT committed; pass its path as argv[2] (default below).
// Run: node --experimental-strip-types tests/fixtures/anchor/generate-fixture.mjs [path.pdf]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import init, { processPdf } from '@firecrawl/pdf-inspector-wasm'
import { buildPdf } from './pdf-writer.ts'
import { buildSyntheticPage } from './synthetic-doc.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = process.argv[2] ?? '/Users/changluo/Downloads/1706.03762v7.pdf'
const REAL_PAGES = [1, 2, 6, 8]
const SYNTH_PAGE = 16

async function extractItems(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise
  const out = {}
  for (const p of REAL_PAGES) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    out[p] = tc.items
      .filter(it => typeof it.str === 'string')
      .map(it => ({
        str: it.str,
        transform: it.transform,
        width: it.width,
        height: it.height,
        hasEOL: !!it.hasEOL,
      }))
  }
  return out
}

async function extractMd(bytes, pages) {
  const r = processPdf(bytes.slice(), { pages, includePageMarkers: true })
  return r.markdown ?? ''
}

// Splits inspector markdown into per-page fragments keyed by their marker.
function mdPages(md) {
  const parts = md.split(/<!-- Page (\d+) -->/)
  const map = {}
  for (let i = 1; i < parts.length; i += 2) map[Number(parts[i])] = parts[i + 1] ?? ''
  return map
}

async function main() {
  await init({
    module_or_path: readFileSync(
      join(HERE, '../../../node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm'),
    ),
  })

  const srcBytes = new Uint8Array(readFileSync(SOURCE))
  const items = await extractItems(srcBytes)
  const realMd = mdPages(await extractMd(srcBytes, REAL_PAGES))

  const synthBytes = buildPdf([buildSyntheticPage()])
  const synthDoc = await pdfjs.getDocument({ data: synthBytes.slice(), isEvalSupported: false }).promise
  const synthPage = await synthDoc.getPage(1)
  const stc = await synthPage.getTextContent()
  items[SYNTH_PAGE] = stc.items
    .filter(it => typeof it.str === 'string')
    .map(it => ({
      str: it.str,
      transform: it.transform,
      width: it.width,
      height: it.height,
      hasEOL: !!it.hasEOL,
    }))
  const synthMd = mdPages(await extractMd(synthBytes, [1]))[1] ?? ''

  mkdirSync(HERE, { recursive: true })
  let docMd = ''
  for (const p of [...REAL_PAGES, SYNTH_PAGE]) {
    writeFileSync(join(HERE, `page-${p}.json`), JSON.stringify({ page: p, items: items[p] }, null, 1) + '\n')
    const body = p === SYNTH_PAGE ? synthMd : realMd[p]
    if (body === undefined) throw new Error(`markdown for page ${p} missing`)
    docMd += `<!-- Page ${p} -->\n${body.trimStart()}\n`
  }
  writeFileSync(join(HERE, 'document.md'), docMd)
  console.log('wrote pages', [...REAL_PAGES, SYNTH_PAGE].join(','), 'document.md', docMd.length, 'chars')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
