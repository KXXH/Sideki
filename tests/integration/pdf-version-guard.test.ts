import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reason: P2-5 regression — a same-path PDF replacement used to let a stale
// reader write old-document annotations onto the new file's sidecar. The SW
// handler's guard (withSessionLock + mutateShellFs + version assert) is
// replayed here against the real shell code and note store.

const idbStore = new Map<string, unknown>()

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (k: string) => structuredClone(idbStore.get(k))),
  set: vi.fn(async (k: string, v: unknown) => { idbStore.set(k, structuredClone(v)) }),
  del: vi.fn(async (k: string) => { idbStore.delete(k) }),
  keys: vi.fn(async () => [...idbStore.keys()]),
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

import { createInstance, deleteShellInstance, mutateShellFs, writeToShellFile, withSessionLock } from '../../src/background/shell'
import { loadShellFs } from '../../src/shared/shell-storage'
import { appendNote, readNotes, type PdfNote } from '../../src/shared/pdf-note-store'
import { assertPdfVersion, pdfDocumentVersion } from '../../src/shared/pdf-version'

const latin1 = (bytes: Uint8Array) => Array.from(bytes, b => String.fromCharCode(b)).join('')
const note = { author: 'user' as const, page: 1, quote: 'original document quote', color: 'yellow' as const }

// Reason: mirrors the SW pdfnote:* handler body — same lock, same mutation
// entry, same version stamps — so this exercises the production composition.
async function appendNoteGuarded(sessionId: string, path: string, input: typeof note, expectedVersion: string): Promise<PdfNote> {
  return withSessionLock(sessionId, () => mutateShellFs(sessionId, 205, false, async fs => {
    const documentVersion = await pdfDocumentVersion(await fs.readFileBuffer(path))
    assertPdfVersion(expectedVersion, documentVersion)
    return appendNote(fs, path, { ...input, documentVersion })
  }))
}

beforeEach(async () => {
  idbStore.clear()
  await deleteShellInstance('s1')
})

describe('PDF replacement version guard', () => {
  it('rejects stale-reader writes after a same-path replacement and keeps the sidecar intact', async () => {
    const original = new TextEncoder().encode('%PDF-1.4 original synthetic document')
    const replacement = new TextEncoder().encode('%PDF-1.4 replacement synthetic document')
    await writeToShellFile('s1', '/tmp/doc.pdf', latin1(original))
    const originalVersion = await pdfDocumentVersion(original)

    const saved = await appendNoteGuarded('s1', '/tmp/doc.pdf', note, originalVersion)
    expect(saved.documentVersion).toBe(originalVersion)

    await writeToShellFile('s1', '/tmp/doc.pdf', latin1(replacement))
    const replacementVersion = await pdfDocumentVersion(replacement)

    await expect(appendNoteGuarded('s1', '/tmp/doc.pdf', { ...note, quote: 'stale reader write' }, originalVersion))
      .rejects.toThrow(/version/i)
    const snap = await loadShellFs('s1')
    expect(snap?.['/tmp/doc.pdf.notes.jsonl']).toBe(JSON.stringify(saved) + '\n')
    expect(snap?.['/tmp/doc.pdf']).toBe(latin1(replacement))

    const fresh = await appendNoteGuarded('s1', '/tmp/doc.pdf', { ...note, quote: 'new document note' }, replacementVersion)
    expect(fresh.documentVersion).toBe(replacementVersion)
    const notes = await readNotes((await createInstance('s1', 205, false)).bash.fs, '/tmp/doc.pdf')
    expect(notes.map(n => n.quote)).toEqual(['original document quote', 'new document note'])
  })
})
