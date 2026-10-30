import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'
import { readFileSync } from 'node:fs'

// Reason: drives the real `pdf` command dispatch + A-phase validation against
// a mocked wasm engine. The markdown pages come from the Stage 0a golden
// fixture, so the normalization contract is exercised on real paper text.

vi.mock('../../src/background/pdf-engine', () => ({
  getVersion: vi.fn(async () => 'test-engine'),
  MAX_PAGES_PER_CALL: 200,
  parsePdf: vi.fn(),
}))

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: '<div/>' }),
  handleClick: vi.fn().mockResolvedValue({ success: true, text: 'ok' }),
  handleExecuteJS: vi.fn().mockResolvedValue({ success: true, result: '' }),
  handleGetPageContent: vi.fn().mockResolvedValue({ success: true, html: '' }),
  handleGetElementInfo: vi.fn().mockResolvedValue({ success: true }),
  handleFindElement: vi.fn().mockResolvedValue({ success: true, output: '', selectors: [], count: 0 }),
  handleType: vi.fn().mockResolvedValue({ success: true }),
  handleScroll: vi.fn().mockResolvedValue({ success: true }),
  handleNavigate: vi.fn().mockResolvedValue({ success: true }),
  handleScreenshot: vi.fn().mockResolvedValue({ success: true, dataUrl: '' }),
  handleWait: vi.fn().mockResolvedValue({ success: true }),
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn(),
}))

import { parsePdf } from '../../src/background/pdf-engine'
import { createPageCommands } from '../../src/background/shell-commands'
import { splitMarkdownPages } from '../../src/shared/pdf-anchor'

const DOC_MD = readFileSync('tests/fixtures/anchor/document.md', 'utf8')
const MD_PAGES = splitMarkdownPages(DOC_MD)

// Reason: pages 1, 2 and 8 exist in the fixture; page-1 abstract prose,
// page-2 emphasis mangles and the page-8 table are the validation regimes.
const PAGE1 = MD_PAGES.get(1) ?? ''
const PAGE2 = MD_PAGES.get(2) ?? ''
const PAGE8 = MD_PAGES.get(8) ?? ''

// Reason: the author affiliation "Google Brain" appears several times on
// page 1 (author block + footnote) — the canonical ambiguity case; the
// abstract's architecture sentence exists only once.
const AMBIGUOUS_QUOTE = 'Google Brain'
const UNIQUE_QUOTE =
  'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely'

function pageMd(n: number, body: string): string {
  return `<!-- Page ${n} -->\n${body}`
}

function mockEngineOnce(md: string, opts?: { pageCount?: number; pdfType?: string }) {
  vi.mocked(parsePdf).mockResolvedValueOnce({
    markdown: md,
    pageCount: opts?.pageCount ?? 1,
    pdfType: (opts?.pdfType ?? 'TextBased') as 'TextBased',
    processingTimeMs: 5,
    pagesNeedingOcr: [],
    ocrReasonsByPage: [],
    confidence: 1,
    layout: { isComplex: false, pagesWithTables: [], pagesWithColumns: [] },
    hasEncodingIssues: false,
  })
}

function makeBash(): Bash {
  return new Bash({
    files: { '/tmp/paper.pdf': 'fake-bytes' },
    cwd: '/',
    customCommands: createPageCommands(1, 'chat', undefined, 's1'),
  })
}

beforeEach(() => {
  vi.mocked(parsePdf).mockReset()
})

describe('pdf read path carries page markers', () => {
  it('parses with includePageMarkers and emits text stdout', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec('pdf /tmp/paper.pdf --pages=1')
    expect(r.exitCode).toBe(0)
    expect(vi.mocked(parsePdf).mock.calls[0]?.[2]).toEqual({ includePageMarkers: true })
    expect(r.stdout).toContain('<!-- Page 1 -->')
  })
})

describe('pdf note add — A-phase validation', () => {
  it('accepts a verbatim quote from the page and writes the sidecar', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${UNIQUE_QUOTE}" --note="key claim" --color=green`)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toMatch(/note n[0-9a-f]{6} added on page 1/)
    const sidecar = await bash.fs.readFile('/tmp/paper.pdf.notes.jsonl')
    const rec = JSON.parse(sidecar.trim())
    expect(rec.author).toBe('ai')
    expect(rec.page).toBe(1)
    expect(rec.quote).toBe(UNIQUE_QUOTE)
    expect(rec.note).toBe('key claim')
    expect(rec.color).toBe('green')
    expect(rec.documentVersion).toMatch(/^[a-f0-9]{64}$/)
  })

  it('takes the quote from stdin when --quote is omitted', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec(`echo "${UNIQUE_QUOTE}" | pdf note add /tmp/paper.pdf --page=1`)
    expect(r.exitCode).toBe(0)
    const sidecar = await bash.fs.readFile('/tmp/paper.pdf.notes.jsonl')
    expect(JSON.parse(sidecar.trim()).quote).toBe(UNIQUE_QUOTE)
  })

  it('rejects a quote that matches several places on the page', async () => {
    // Reason: the affiliation "Google Brain" sits under several authors —
    // without a disambiguator the reader cannot know which occurrence to
    // highlight.
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${AMBIGUOUS_QUOTE}"`)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/matches \d+ places on page 1/)
    expect(r.stderr).toContain('--prefix/--suffix')
    expect(await readNotes(bash)).toEqual([])
  })

  it('accepts an ambiguous quote when --prefix or --suffix is given', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${AMBIGUOUS_QUOTE}" --prefix="University of Toronto"`)
    expect(r.exitCode).toBe(0)
    const sidecar = await bash.fs.readFile('/tmp/paper.pdf.notes.jsonl')
    expect(JSON.parse(sidecar.trim()).prefix).toBe('University of Toronto')
  })

  it('rejects a paraphrased quote with the actionable error', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec('pdf note add /tmp/paper.pdf --page=1 --quote="the transformer relies entirely on recurrent networks"')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('quote not found on page 1')
    expect(r.stderr).toContain('pdf /tmp/paper.pdf --pages=1')
    expect(r.stderr).toContain('must not span page boundaries')
    // Reason: a rejected add must not leave a half-written sidecar behind.
    expect(await readNotes(bash)).toEqual([])
  })

  it('validates against the requested page only — a page-1 quote on page 8 fails', async () => {
    mockEngineOnce(pageMd(8, PAGE8), { pageCount: 23 })
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=8 --quote="${UNIQUE_QUOTE}"`)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('quote not found on page 8')
  })

  it('rejects a quote that is too short', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec('pdf note add /tmp/paper.pdf --page=1 --quote="Animate"')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('quote too short')
  })

  it('reports out-of-range pages', async () => {
    mockEngineOnce(pageMd(1, PAGE1), { pageCount: 1 })
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=9 --quote="${UNIQUE_QUOTE}"`)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('out of range')
    expect(r.stderr).toContain('1 pages')
  })

  it('rejects a scanned page with no text', async () => {
    mockEngineOnce('', { pdfType: 'Scanned' })
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${UNIQUE_QUOTE}"`)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('no extractable text')
    expect(r.stderr).toContain('Scanned')
  })

  it('normalizes emphasis markers — a bare-text quote matches italic markdown', async () => {
    // Reason: the fixture page-2 markdown mangles the hidden-state symbol
    // into *ht* / *ht−*1and; a quote copied without the asterisks must still
    // validate.
    mockEngineOnce(pageMd(2, PAGE2), { pageCount: 15 })
    const bash = makeBash()
    const r = await bash.exec('pdf note add /tmp/paper.pdf --page=2 --quote="hidden states ht, as a function of the previous hidden state"')
    expect(r.exitCode).toBe(0)
  })

  it('rejects an invalid color', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec('pdf note add /tmp/paper.pdf --page=1 --quote="Attention Is All You Need" --color=red')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('yellow|green|blue|pink')
  })
})

describe('pdf note list', () => {
  it('lists notes with filters and --json', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${UNIQUE_QUOTE}"`)
    await bash.exec('pdf note add /tmp/paper.pdf --page=1 --quote="The best performing models also connect the encoder and decoder through an attention mechanism"')

    const all = await bash.exec('pdf note list /tmp/paper.pdf')
    expect(all.exitCode).toBe(0)
    expect(all.stdout).toMatch(/\[n[0-9a-f]{6}\] page 1 \(ai, yellow\): "/)

    const asJson = await bash.exec('pdf note list /tmp/paper.pdf --json')
    expect(JSON.parse(asJson.stdout)).toHaveLength(2)
    expect(JSON.parse(asJson.stdout)[0].quote).toContain('We propose a new simple network architecture')
  })

  it('reports zero notes without failing', async () => {
    const bash = makeBash()
    const r = await bash.exec('pdf note list /tmp/paper.pdf')
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('no notes')
  })
})

describe('pdf note rm', () => {
  it('removes by id and reports missing ones', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const add1 = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${UNIQUE_QUOTE}"`)
    const add2 = await bash.exec('pdf note add /tmp/paper.pdf --page=1 --quote="The best performing models also connect the encoder and decoder through an attention mechanism"')
    const id1 = add1.stderr.match(/note (n[0-9a-f]{6})/)?.[1]
    const id2 = add2.stderr.match(/note (n[0-9a-f]{6})/)?.[1]

    const r = await bash.exec(`pdf note rm /tmp/paper.pdf ${id1} nzzzzz`)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain(`removed 1 note(s): ${id1}`)
    expect(r.stderr).toContain('not found: nzzzzz')

    const after = await bash.exec('pdf note list /tmp/paper.pdf --json')
    const notes = JSON.parse(after.stdout)
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe(id2)
  })

  it('fails when no id matches', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${UNIQUE_QUOTE}"`)
    const r = await bash.exec('pdf note rm /tmp/paper.pdf nnope1 nnope2')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('no notes match')
  })
})

describe('pdf open', () => {
  it('opens the reader tab with session/file/page in the URL', async () => {
    const bash = makeBash()
    const r = await bash.exec('pdf open /tmp/paper.pdf --page=3')
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('opened reader for /tmp/paper.pdf (page 3)')
    const created = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(created.url).toContain('src/reader/index.html')
    expect(created.url).toContain('session=s1')
    expect(created.url).toContain(encodeURIComponent('/tmp/paper.pdf'))
    expect(created.url).toContain('page=3')
  })

  it('defaults to page 1 and rejects a non-positive page', async () => {
    const bash = makeBash()
    const r = await bash.exec('pdf open /tmp/paper.pdf')
    expect(r.exitCode).toBe(0)
    const created = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(created.url).toContain('page=1')

    const bad = await bash.exec('pdf open /tmp/paper.pdf --page=0')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('positive integer')
  })

  it('fails on a missing file', async () => {
    const bash = makeBash()
    const r = await bash.exec('pdf open /tmp/nope.pdf')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('cannot read file')
  })
})

describe('reader sync broadcast', () => {
  const changed = () =>
    vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(
      c => (c[0] as { type?: string })?.type === 'pdfnote:changed',
    )

  it('announces an AI note so an open reader refreshes', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    vi.mocked(chrome.runtime.sendMessage).mockClear()
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${UNIQUE_QUOTE}"`)
    expect(r.exitCode).toBe(0)
    expect(changed()).toEqual([[{ type: 'pdfnote:changed', sessionId: 's1' }]])
  })

  it('announces a removal too', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const add = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${UNIQUE_QUOTE}"`)
    const id = /note (n[0-9a-f]{6})/.exec(add.stderr)?.[1]
    expect(id).toBeTruthy()
    vi.mocked(chrome.runtime.sendMessage).mockClear()
    const r = await bash.exec(`pdf note rm /tmp/paper.pdf ${id}`)
    expect(r.exitCode).toBe(0)
    expect(changed()).toEqual([[{ type: 'pdfnote:changed', sessionId: 's1' }]])
  })

  it('stays silent when the write was rejected', async () => {
    // Reason: a broadcast on a failed A-phase would make the reader re-read the
    // sidecar for nothing, and worse, suggest something was written.
    mockEngineOnce(pageMd(1, PAGE1))
    vi.mocked(chrome.runtime.sendMessage).mockClear()
    const bash = makeBash()
    const r = await bash.exec(`pdf note add /tmp/paper.pdf --page=1 --quote="${AMBIGUOUS_QUOTE}"`)
    expect(r.exitCode).toBe(1)
    expect(changed()).toEqual([])
  })
})

describe('dispatch boundaries', () => {
  it('bare word that is not a verb still parses as a path', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec('pdf /tmp/paper.pdf --pages=1')
    expect(r.exitCode).toBe(0)
  })

  it('usage error when nothing is given', async () => {
    const bash = makeBash()
    const r = await bash.exec('pdf')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Usage: pdf')
  })

  it('note without an action is a usage error', async () => {
    const bash = makeBash()
    const r = await bash.exec('pdf note /tmp/paper.pdf')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Usage: pdf note list|add|rm')
  })

  it('missing PDF reports cannot-read, not a silent ok', async () => {
    mockEngineOnce(pageMd(1, PAGE1))
    const bash = makeBash()
    const r = await bash.exec('pdf note add /tmp/absent.pdf --page=1 --quote="Attention Is All You Need"')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('cannot read file')
  })
})

async function readNotes(bash: Bash): Promise<unknown[]> {
  try {
    const raw = await bash.fs.readFile('/tmp/paper.pdf.notes.jsonl')
    return raw.trim() ? JSON.parse(`[${raw.trim().split('\n').join(',')}]`) : []
  } catch {
    return []
  }
}
