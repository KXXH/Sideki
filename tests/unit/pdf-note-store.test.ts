import { describe, it, expect } from 'vitest'
import { Bash } from 'just-bash'
import {
  type PdfNote,
  notesPathFor,
  readNotes,
  appendNote,
  removeNotes,
} from '../../src/shared/pdf-note-store'

// Reason: the real just-bash VFS is the contract here — mocking fs would only
// re-assert our own assumptions about its text round-trip semantics.

function makeFs(files: Record<string, string> = {}): Bash['fs'] {
  return new Bash({ files, cwd: '/' }).fs
}

type NoteInput = Omit<PdfNote, 'id' | 'ts'>

function noteInput(overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    author: 'ai',
    page: 1,
    quote: 'quoted text',
    color: 'yellow',
    ...overrides,
  }
}

describe('notesPathFor', () => {
  it('appends the sidecar suffix to a flat path', () => {
    expect(notesPathFor('/tmp/x.pdf')).toBe('/tmp/x.pdf.notes.jsonl')
  })

  it('keeps multi-segment attachment paths intact', () => {
    expect(notesPathFor('/tmp/attachments/1725350000000-1-quarterly-report.pdf'))
      .toBe('/tmp/attachments/1725350000000-1-quarterly-report.pdf.notes.jsonl')
  })

  it('handles extension-less paths', () => {
    expect(notesPathFor('/tmp/attachments/manifest')).toBe('/tmp/attachments/manifest.notes.jsonl')
  })
})

describe('appendNote / readNotes', () => {
  it('round-trips a full note with generated id and millisecond ts', async () => {
    const fs = makeFs()
    const before = Date.now()
    const written = await appendNote(fs, '/tmp/a.pdf', {
      author: 'user',
      page: 7,
      quote: 'quoted text',
      prefix: 'pre ',
      suffix: ' post',
      note: 'a note',
      color: 'green',
    })
    const after = Date.now()
    expect(written.id).toMatch(/^n[0-9a-f]{6}$/)
    expect(Number.isInteger(written.ts)).toBe(true)
    // Reason: a seconds-based ts (~1.7e9) falls far below any ms window, so
    // this pins the unit without trusting Date.now() stability across runs.
    expect(written.ts).toBeGreaterThanOrEqual(before)
    expect(written.ts).toBeLessThanOrEqual(after)
    expect(await readNotes(fs, '/tmp/a.pdf')).toEqual([written])
  })

  it('writes one newline-terminated line per note, in append order', async () => {
    const fs = makeFs()
    const first = await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'first' }))
    const second = await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'second', color: 'pink' }))
    const raw = await fs.readFile('/tmp/a.pdf.notes.jsonl')
    expect(raw.split('\n').filter(Boolean)).toEqual([JSON.stringify(first), JSON.stringify(second)])
    expect(raw.endsWith('\n')).toBe(true)
    expect(await readNotes(fs, '/tmp/a.pdf')).toEqual([first, second])
  })

  it('omits absent optional fields from the serialized line', async () => {
    const fs = makeFs()
    const written = await appendNote(fs, '/tmp/a.pdf', noteInput())
    const line = JSON.parse((await fs.readFile('/tmp/a.pdf.notes.jsonl')).trim()) as Record<string, unknown>
    expect(line).toEqual(written as unknown as Record<string, unknown>)
    expect('prefix' in line).toBe(false)
    expect('suffix' in line).toBe(false)
    expect('note' in line).toBe(false)
  })

  it('does not fuse lines when the sidecar lacks a trailing newline', async () => {
    const fs = makeFs({
      '/tmp/a.pdf.notes.jsonl': '{"id":"nabc123","author":"ai","page":1,"quote":"old","color":"yellow","ts":1}',
    })
    const written = await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'new' }))
    const notes = await readNotes(fs, '/tmp/a.pdf')
    expect(notes.map(n => n.quote)).toEqual(['old', 'new'])
    expect(notes[1]).toEqual(written)
  })

  it('returns [] when no sidecar exists', async () => {
    const fs = makeFs()
    expect(await readNotes(fs, '/tmp/missing.pdf')).toEqual([])
  })

  it('skips corrupted lines and keeps parseable ones', async () => {
    const good = '{"id":"nabc123","author":"ai","page":1,"quote":"good","color":"yellow","ts":1}'
    const fs = makeFs({ '/tmp/a.pdf.notes.jsonl': `${good}\nnot json\n{"broken":\n\n` })
    const notes = await readNotes(fs, '/tmp/a.pdf')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toEqual({ id: 'nabc123', author: 'ai', page: 1, quote: 'good', color: 'yellow', ts: 1 })
  })
})

describe('removeNotes', () => {
  it('removes hits, reports misses, and keeps the rest in order', async () => {
    const fs = makeFs()
    const a = await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'one' }))
    const b = await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'two', color: 'blue' }))
    const c = await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'three', author: 'user' }))
    const res = await removeNotes(fs, '/tmp/a.pdf', [b.id, 'n000000'])
    expect(res.removed.map(n => n.id)).toEqual([b.id])
    expect(res.missing).toEqual(['n000000'])
    expect(await readNotes(fs, '/tmp/a.pdf')).toEqual([a, c])
  })

  it('leaves the file byte-identical when every id misses', async () => {
    const fs = makeFs()
    await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'one' }))
    await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'two' }))
    const before = await fs.readFile('/tmp/a.pdf.notes.jsonl')
    const res = await removeNotes(fs, '/tmp/a.pdf', ['nffffff', 'n999999'])
    expect(res.removed).toEqual([])
    expect(res.missing).toEqual(['nffffff', 'n999999'])
    expect(await fs.readFile('/tmp/a.pdf.notes.jsonl')).toBe(before)
  })

  it('returns two empty arrays when no sidecar exists', async () => {
    const fs = makeFs()
    expect(await removeNotes(fs, '/tmp/none.pdf', ['n123456'])).toEqual({ removed: [], missing: [] })
  })

  it('removes every note and leaves an empty file', async () => {
    const fs = makeFs()
    const a = await appendNote(fs, '/tmp/a.pdf', noteInput())
    const b = await appendNote(fs, '/tmp/a.pdf', noteInput({ quote: 'two' }))
    const res = await removeNotes(fs, '/tmp/a.pdf', [a.id, b.id])
    expect(res.removed).toHaveLength(2)
    expect(res.removed.map(n => n.id)).toEqual(expect.arrayContaining([a.id, b.id]))
    expect(res.missing).toEqual([])
    expect(await readNotes(fs, '/tmp/a.pdf')).toEqual([])
    expect(await fs.readFile('/tmp/a.pdf.notes.jsonl')).toBe('')
  })
})

describe('text fidelity', () => {
  it('round-trips spaces, CJK, and emoji without mojibake', async () => {
    const fs = makeFs()
    const quote = '  空格 中文「引文」— 与 emoji 🎉🚀  '
    const note = '批注：确认 UTF-8 往返 📝'
    const written = await appendNote(fs, '/tmp/uni.pdf', {
      author: 'user',
      page: 12,
      quote,
      note,
      color: 'pink',
    })
    const notes = await readNotes(fs, '/tmp/uni.pdf')
    expect(notes[0].quote).toBe(quote)
    expect(notes[0].note).toBe(note)
    expect(notes[0]).toEqual(written)
  })
})
