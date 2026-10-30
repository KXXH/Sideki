import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bash } from 'just-bash'
import { assertPdfVersion, pdfDocumentVersion, PDF_VERSION_ERROR } from '../../src/shared/pdf-version'
import { appendNote, readNotes, type PdfNote } from '../../src/shared/pdf-note-store'
import { appendNoteVfs, editNoteVfs, fetchNotes, fetchPageMarkdown, loadPdfBytes, removeNotesVfs } from '../../src/reader/vfs-client'
import { Sidebar } from '../../src/reader/sidebar'

const version = 'a'.repeat(64)
const otherVersion = 'b'.repeat(64)
const note: PdfNote = { id: 'n123456', author: 'user', page: 1, quote: 'synthetic document quote', color: 'yellow', ts: 1, documentVersion: version }

beforeEach(() => {
  vi.mocked(chrome.runtime.sendMessage).mockReset()
})

describe('PDF document versions', () => {
  it('hashes raw bytes, including the complete Latin1 range', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(await pdfDocumentVersion(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
    const replaced = bytes.slice()
    replaced[255] = 0
    expect(await pdfDocumentVersion(replaced)).not.toBe(await pdfDocumentVersion(bytes))
  })

  it('accepts the same version and rejects a changed or missing version', () => {
    expect(() => assertPdfVersion(version, version)).not.toThrow()
    expect(() => assertPdfVersion(otherVersion, version)).toThrow(PDF_VERSION_ERROR)
    expect(() => assertPdfVersion(undefined, version)).toThrow(PDF_VERSION_ERROR)
  })

  it('preserves legacy records verbatim while binding new notes to bytes', async () => {
    const original = JSON.stringify({ ...note, documentVersion: undefined }) + '\n'
    const fs = new Bash({ files: { '/tmp/doc.pdf.notes.jsonl': original } }).fs
    const added = await appendNote(fs, '/tmp/doc.pdf', { author: 'ai', page: 1, quote: 'another synthetic quote', color: 'green', documentVersion: version })
    expect(added.documentVersion).toBe(version)
    expect(await fs.readFile('/tmp/doc.pdf.notes.jsonl')).toBe(original + JSON.stringify(added) + '\n')
    expect((await readNotes(fs, '/tmp/doc.pdf'))[0].documentVersion).toBeUndefined()
  })

  it('shows old and different-version notes as read-only without hiding their text', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, {
      notes: [{ ...note, id: 'legacy', documentVersion: undefined }, { ...note, id: 'different', documentVersion: otherVersion }, note],
      documentVersion: version, activeNoteId: null, noTextLayer: false,
      onJump: () => {}, onRemove: () => {}, onEdit: () => {},
    }))
    expect(html).toContain('未记录文档版本 · 只读')
    expect(html).toContain('其他文档版本 · 只读')
    expect(html.match(/synthetic document quote/g)).toHaveLength(3)
    const legacyCard = html.split('id="note-entry-legacy"')[1].split('id="note-entry-')[0]
    expect(legacyCard).toContain('disabled=""')
  })
})

describe('versioned reader messages', () => {
  it('loads a complete byte snapshot and returns its document version', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true, chunk: '\x00\xffPDF', size: 5, documentVersion: version })
    const result = await loadPdfBytes('s', '/tmp/doc.pdf')
    expect(Array.from(result.bytes)).toEqual([0, 255, 80, 68, 70])
    expect(result.documentVersion).toBe(version)
  })

  it('carries the initial version across chunks', async () => {
    const first = 'x'.repeat(8 * 1024 * 1024)
    vi.mocked(chrome.runtime.sendMessage)
      .mockResolvedValueOnce({ success: true, chunk: first, size: first.length + 1, documentVersion: version })
      .mockResolvedValueOnce({ success: true, chunk: 'y', size: first.length + 1, documentVersion: version })
    const result = await loadPdfBytes('s', '/tmp/doc.pdf')
    expect(result.bytes.at(-1)).toBe(121)
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: first.length, expectedVersion: version }))
  })

  it('rejects mixed document chunks even if their byte counts agree', async () => {
    const first = 'x'.repeat(8 * 1024 * 1024)
    vi.mocked(chrome.runtime.sendMessage)
      .mockResolvedValueOnce({ success: true, chunk: first, size: first.length + 1, documentVersion: version })
      .mockResolvedValueOnce({ success: true, chunk: 'y', size: first.length + 1, documentVersion: otherVersion })
    await expect(loadPdfBytes('s', '/tmp/doc.pdf')).rejects.toThrow(PDF_VERSION_ERROR)
  })

  it('rejects missing bytes instead of allocating a zero-padded PDF', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true, chunk: '', size: 100, documentVersion: version })
    await expect(loadPdfBytes('s', '/tmp/doc.pdf')).rejects.toThrow('分片数据不完整')
  })

  it('passes the loaded version to every annotation and markdown request', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true, result: note, content: '', markdown: 'text' })
    await fetchNotes('s', '/tmp/doc.pdf', version)
    await fetchPageMarkdown('s', '/tmp/doc.pdf', 1, version)
    await appendNoteVfs('s', '/tmp/doc.pdf', note, version)
    await editNoteVfs('s', '/tmp/doc.pdf', note.id, 'edited', version)
    await removeNotesVfs('s', '/tmp/doc.pdf', [note.id], version)
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls).toHaveLength(5)
    for (const [message] of vi.mocked(chrome.runtime.sendMessage).mock.calls) expect(message).toMatchObject({ expectedVersion: version })
  })

  it('surfaces a worker version conflict without retrying or changing the target', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: false, error: PDF_VERSION_ERROR })
    await expect(appendNoteVfs('s', '/tmp/doc.pdf', note, version)).rejects.toThrow('PDF 内容已变化')
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
  })
})
