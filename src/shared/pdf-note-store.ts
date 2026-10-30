// PDF annotation sidecar store: append-only .notes.jsonl companion files next
// to uploaded PDFs, shared by human and AI annotators.
// Reason: VFS text I/O only — this module enters the service-worker bundle via
// shell-commands.ts and must not pull pdfjs-dist, idb-keyval, or chrome.

import type { Bash } from 'just-bash'

export interface PdfNote {
  id: string
  author: 'ai' | 'user'
  page: number
  quote: string
  prefix?: string
  suffix?: string
  note?: string
  color: 'yellow' | 'green' | 'blue' | 'pink'
  ts: number
  documentVersion?: string
}

const SIDECAR_SUFFIX = '.notes.jsonl'

export function notesPathFor(pdfPath: string): string {
  return pdfPath + SIDECAR_SUFFIX
}

// Reason: ids only need uniqueness within one sidecar, not unpredictability,
// so Math.random beats dragging in crypto.
function newNoteId(): string {
  let id = 'n'
  for (let i = 0; i < 6; i++) id += Math.floor(Math.random() * 16).toString(16)
  return id
}

async function readSidecar(fs: Bash['fs'], path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile) return null
    return await fs.readFile(path)
  } catch { /* absent sidecar reads as empty */ }
  return null
}

export function parseNotes(content: string | null): PdfNote[] {
  if (content === null) return []
  const notes: PdfNote[] = []
  for (const line of content.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      notes.push(JSON.parse(text) as PdfNote)
    } catch { /* one corrupted line must not take down the whole list */ }
  }
  return notes
}

export async function readNotes(fs: Bash['fs'], pdfPath: string): Promise<PdfNote[]> {
  return parseNotes(await readSidecar(fs, notesPathFor(pdfPath)))
}

export async function appendNote(
  fs: Bash['fs'],
  pdfPath: string,
  note: Omit<PdfNote, 'id' | 'ts'>,
): Promise<PdfNote> {
  const path = notesPathFor(pdfPath)
  // Reason: fixed key order keeps sidecar lines stable for cat/jq consumers;
  // undefined optionals are dropped by JSON.stringify.
  const full: PdfNote = {
    id: newNoteId(),
    author: note.author,
    page: note.page,
    quote: note.quote,
    prefix: note.prefix,
    suffix: note.suffix,
    note: note.note,
    color: note.color,
    ts: Date.now(),
    documentVersion: note.documentVersion,
  }
  const existing = await readSidecar(fs, path) ?? ''
  // Reason: a sidecar last written without a trailing newline would fuse its
  // final record with the appended one into a single unparseable line.
  const base = existing && !existing.endsWith('\n') ? existing + '\n' : existing
  await fs.writeFile(path, base + JSON.stringify(full) + '\n')
  return full
}

export async function removeNotes(
  fs: Bash['fs'],
  pdfPath: string,
  ids: string[],
): Promise<{ removed: PdfNote[]; missing: string[] }> {
  const path = notesPathFor(pdfPath)
  if (await readSidecar(fs, path) === null) return { removed: [], missing: [] }
  const notes = await readNotes(fs, pdfPath)
  const wanted = new Set(ids)
  const removed: PdfNote[] = []
  const kept: PdfNote[] = []
  for (const n of notes) {
    if (wanted.has(n.id)) removed.push(n)
    else kept.push(n)
  }
  const removedIds = new Set(removed.map(n => n.id))
  const missing = ids.filter(id => !removedIds.has(id))
  // Reason: a total miss must leave the file untouched — callers diff the raw
  // sidecar to detect no-op removes.
  if (removed.length === 0) return { removed, missing }
  await fs.writeFile(path, kept.length === 0 ? '' : kept.map(n => JSON.stringify(n)).join('\n') + '\n')
  return { removed, missing }
}

// Reason: the reader's inline editor changes the comment only — the anchor
// fields are immutable from the UI; a changed quote must go through add again.
export async function editNote(
  fs: Bash['fs'],
  pdfPath: string,
  id: string,
  note: string,
): Promise<{ ok: boolean }> {
  const path = notesPathFor(pdfPath)
  const content = await readSidecar(fs, path)
  if (content === null) return { ok: false }
  const lines = content.split('\n')
  let found = false
  const out = lines.map(line => {
    if (!line.trim() || found) return line
    try {
      const rec = JSON.parse(line) as PdfNote
      if (rec.id !== id) return line
      found = true
      return JSON.stringify({ ...rec, note: note || undefined })
    } catch { return line }
  })
  if (!found) return { ok: false }
  await fs.writeFile(path, out.join('\n'))
  return { ok: true }
}
