import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mirrorAttachments, prepareFileAttachments } from '../../src/shared/attachment-mirror'
import { createVfsUploadReceiver } from '../../src/background/vfs-upload'
import { expandForModel } from '../../src/shared/message-protocol'
import type { ElementAttachment } from '../../src/shared/types'
import type { UIMessage } from 'ai'

const commit = vi.fn<Parameters<typeof createVfsUploadReceiver>[0]>().mockResolvedValue(undefined)
let receive = createVfsUploadReceiver(commit)
const send = vi.fn((message: Record<string, unknown>) => receive(message))

function attachment(sizeKb: number, name = 'doc.pdf'): ElementAttachment {
  return { croppedImage: '', domSnapshot: '', label: name, file: { name, mime: 'application/pdf', latin1: 'x'.repeat(sizeKb * 1024) } }
}

beforeEach(() => {
  vi.clearAllMocks()
  receive = createVfsUploadReceiver(commit)
})

async function prepareAndMirror(a: ElementAttachment, largeFileUploads: boolean, imageFs = false) {
  const prepared = await prepareFileAttachments([a], 's1', largeFileUploads, send)
  return mirrorAttachments(prepared, 's1', imageFs, send)
}

describe('attachment upload caps', () => {
  it('saves a >5MiB PDF through the shared uploader with image copies disabled', async () => {
    const result = await prepareAndMirror(attachment(6 * 1024), true)
    expect(result.savedFiles).toHaveLength(1)
    expect(result.notes).toContain('read it with: pdf ')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.filter(([m]) => m.type === 'vfs:upload-chunk')).toHaveLength(6)
  })

  it.each([
    [32 * 1024 + 1, 'doc.pdf', true, '32768 KiB'],
    [600, 'doc.pdf', false, '大文件上传'],
    [32 * 1024 + 1, 'data.csv', true, '32768 KiB'],
  ] as const)('rejects %iKB %s with largeFileUploads=%s before sending', async (size, name, enabled, error) => {
    await expect(prepareAndMirror(attachment(size, name), enabled)).rejects.toThrow(error)
    expect(send).not.toHaveBeenCalled()
  })

  it('applies the same large-file cap to CSV and PDF without enabling image copies', async () => {
    const result = await prepareAndMirror(attachment(6 * 1024, 'data.csv'), true, false)
    expect(result.savedFiles).toHaveLength(1)
    expect(result.notes).toContain('read it with: cat ')
  })

  it('does not raise the upload cap when image copies are enabled', async () => {
    await expect(prepareAndMirror(attachment(600), false, true)).rejects.toThrow('500 KiB')
    expect(send).not.toHaveBeenCalled()
  })

  it('saves small non-PDF files with large uploads disabled', async () => {
    const result = await prepareAndMirror(attachment(100, 'data.csv'), false)
    expect(result.savedFiles).toHaveLength(1)
    expect(result.notes).toContain('read it with: cat ')
  })
})

describe('attachment first-hop references', () => {
  it('strips raw file bytes from the wire and retains model notes and UI file data', async () => {
    const original = attachment(1, '../../论文.pdf')
    const prepared = await prepareFileAttachments([original], 's1', true, send)
    const wire = JSON.stringify({ type: 'cmd', name: 'send', args: { text: '', attachments: prepared } })
    expect(wire).not.toContain('latin1')
    expect(prepared![0].file).toBeUndefined()
    expect(original.file?.latin1).toHaveLength(1024)
    const callsBeforeMirror = send.mock.calls.length
    const report = await mirrorAttachments(prepared, 's1', true, send)
    expect(send).toHaveBeenCalledTimes(callsBeforeMirror)
    const file = report.savedFiles[0]
    expect(file).toEqual({ name: '../../论文.pdf', size: 1024, path: expect.stringMatching(/^\/tmp\/attachments\/[A-Za-z0-9_-]+-__\.pdf$/) })
    const message = { id: 'u1', role: 'user', parts: [{ type: 'data-file', data: file }], metadata: { v: 2, attachmentNotes: report.notes } } as UIMessage
    expect(expandForModel(message).parts).toEqual([{ type: 'text', text: report.notes }])
    expect(report.notes).toContain(file.path)
  })

  it('rejects cross-session saved references without reuploading', async () => {
    const prepared = await prepareFileAttachments([attachment(1)], 's1', true, send)
    send.mockClear()
    await expect(prepareFileAttachments(prepared, 's2', true, send)).rejects.toThrow('其他会话')
    await expect(mirrorAttachments(prepared, 's2', true, send)).rejects.toThrow('其他会话')
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a raw file if it bypasses panel upload preparation', async () => {
    await expect(mirrorAttachments([attachment(1)], 's1', true, send)).rejects.toThrow('尚未上传')
    expect(send).not.toHaveBeenCalled()
  })

  it('propagates durable errors and leaves the pending attachment intact', async () => {
    const original = attachment(1)
    commit.mockRejectedValueOnce(new Error('session VFS capacity exceeded'))
    await expect(prepareFileAttachments([original], 's1', true, send)).rejects.toThrow('doc.pdf 上传失败：session VFS capacity exceeded')
    expect(original.file?.latin1).toHaveLength(1024)
    expect(original.savedFile).toBeUndefined()
    expect(send.mock.calls.at(-1)?.[0].type).toBe('vfs:upload-abort')
  })

  it('reuses the same target path when the user retries a failed draft', async () => {
    const original = attachment(1)
    commit.mockRejectedValueOnce(new Error('quota'))
    await expect(prepareFileAttachments([original], 's1', true, send)).rejects.toThrow('quota')
    await prepareFileAttachments([original], 's1', true, send)
    expect(commit.mock.calls[0][1]).toBe(commit.mock.calls[1][1])
  })

  it('keeps the image vision attachment and optional mirror behavior unchanged', async () => {
    const image = { croppedImage: 'data:image/jpeg;base64,YWJj', domSnapshot: '', label: 'image' }
    const prepared = await prepareFileAttachments([image], 's1', true, send)
    expect(prepared![0]).toBe(image)
    expect(send).not.toHaveBeenCalled()
    const imageSend = vi.fn().mockResolvedValue({ success: true })
    const report = await mirrorAttachments(prepared, 's1', true, imageSend)
    expect(report.savedFiles).toEqual([])
    expect(imageSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'vfs:write', content: 'abc' }))
    expect(prepared![0].croppedImage).toBe(image.croppedImage)
  })
})
