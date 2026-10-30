import type { PdfNote } from '../shared/pdf-note-store'
import { parseNotes } from '../shared/pdf-note-store'
import { assertPdfVersion, PDF_VERSION_ERROR } from '../shared/pdf-version'

const PDF_CHUNK = 8 * 1024 * 1024

interface SwResponse {
  success: boolean
  error?: string
  [key: string]: unknown
}

async function send(message: Record<string, unknown>): Promise<SwResponse> {
  const res = (await chrome.runtime.sendMessage(message)) as SwResponse | undefined
  if (!res || res.success !== true) {
    throw new Error(res?.error === PDF_VERSION_ERROR
      ? 'PDF 内容已变化或版本未记录，请重新打开阅读器后重试；原批注和草稿已保留。'
      : res?.error ?? `message failed: ${String(message.type)}`)
  }
  return res
}

export async function loadPdfBytes(sessionId: string, path: string): Promise<{ bytes: Uint8Array; documentVersion: string }> {
  const parts: string[] = []
  let size: number | undefined
  let documentVersion: string | undefined
  let offset = 0
  do {
    const res = await send({ type: 'pdfbytes:read', sessionId, path, offset, length: PDF_CHUNK, expectedVersion: documentVersion })
    if (typeof res.documentVersion !== 'string' || !/^[a-f0-9]{64}$/.test(res.documentVersion)
      || typeof res.size !== 'number' || !Number.isSafeInteger(res.size) || res.size < offset
      || typeof res.chunk !== 'string' || res.chunk.length !== Math.min(PDF_CHUNK, res.size - offset)) {
      throw new Error('PDF 分片数据不完整，请重新打开阅读器')
    }
    if (documentVersion !== undefined) assertPdfVersion(documentVersion, res.documentVersion)
    if (size !== undefined && size !== res.size) throw new Error('PDF 大小在读取期间变化，请重新打开阅读器')
    documentVersion = res.documentVersion
    size = res.size
    parts.push(res.chunk)
    offset += res.chunk.length
  } while (offset < size)
  const bytes = new Uint8Array(size)
  let pos = 0
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) bytes[pos++] = part.charCodeAt(i)
  }
  return { bytes, documentVersion }
}

export async function fetchNotes(sessionId: string, path: string, expectedVersion: string): Promise<PdfNote[]> {
  const res = await send({ type: 'pdfnote:read', sessionId, path, expectedVersion })
  return parseNotes(typeof res.content === 'string' ? res.content : null)
}

export async function fetchPageMarkdown(sessionId: string, path: string, page: number, expectedVersion: string): Promise<string> {
  const res = await send({ type: 'pdfmd:page', sessionId, path, page, expectedVersion })
  return typeof res.markdown === 'string' ? res.markdown : ''
}

export async function appendNoteVfs(
  sessionId: string,
  path: string,
  note: Omit<PdfNote, 'id' | 'ts' | 'documentVersion'>,
  expectedVersion: string,
): Promise<PdfNote> {
  const res = await send({ type: 'pdfnote:append', sessionId, path, note, expectedVersion })
  return res.result as PdfNote
}

export async function removeNotesVfs(sessionId: string, path: string, ids: string[], expectedVersion: string): Promise<void> {
  await send({ type: 'pdfnote:remove', sessionId, path, ids, expectedVersion })
}

export async function editNoteVfs(sessionId: string, path: string, id: string, note: string, expectedVersion: string): Promise<void> {
  await send({ type: 'pdfnote:edit', sessionId, path, id, note, expectedVersion })
}
