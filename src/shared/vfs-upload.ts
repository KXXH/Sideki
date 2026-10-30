// Reason: 1 MiB of source bytes stays below Chrome's 64 MiB limit even with JSON escaping.
export const VFS_UPLOAD_CHUNK_BYTES = 1024 * 1024
export const VFS_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

export type VfsUploadMessage =
  | { type: 'vfs:upload-start'; sessionId: string; path: string; size: number }
  | { type: 'vfs:upload-chunk'; sessionId: string; uploadId: string; path: string; size: number; offset: number; content: string }
  | { type: 'vfs:upload-abort'; sessionId: string; uploadId: string }

export type VfsUploadResponse =
  | { success: true; uploadId: string; nextOffset: number; complete: boolean }
  | { success: false; error: string }

export type UploadSender = (message: Record<string, unknown>) => Promise<unknown>

export function isUploadPath(path: unknown): path is string {
  return typeof path === 'string' && /^\/tmp\/attachments\/[A-Za-z0-9._-]{1,160}$/.test(path)
    && !['.', '..'].includes(path.slice('/tmp/attachments/'.length))
}

export function isUploadSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= VFS_UPLOAD_MAX_BYTES
}

async function sendUpload(send: UploadSender, message: VfsUploadMessage): Promise<Extract<VfsUploadResponse, { success: true }>> {
  const response = await send(message) as VfsUploadResponse | undefined
  if (!response?.success) throw new Error(response?.error || '上传未收到确认，请重试')
  return response
}

export async function uploadVfsFile(
  sessionId: string,
  path: string,
  content: string,
  send: UploadSender,
  assertCurrent: () => void = () => {},
): Promise<void> {
  if (!isUploadPath(path) || !isUploadSize(content.length)) throw new Error('上传路径或文件大小无效')
  let uploadId: string | undefined
  try {
    assertCurrent()
    const start = await sendUpload(send, { type: 'vfs:upload-start', sessionId, path, size: content.length })
    uploadId = start.uploadId
    if (!uploadId || start.nextOffset !== 0 || start.complete !== false) throw new Error('上传初始化确认无效')
    let offset = 0
    do {
      assertCurrent()
      const chunk = content.slice(offset, offset + VFS_UPLOAD_CHUNK_BYTES)
      const ack = await sendUpload(send, {
        type: 'vfs:upload-chunk', sessionId, uploadId, path, size: content.length, offset, content: chunk,
      })
      offset += chunk.length
      if (ack.uploadId !== uploadId || ack.nextOffset !== offset || ack.complete !== (offset === content.length)) {
        throw new Error('上传分片确认不匹配，请重试')
      }
      assertCurrent()
    } while (offset < content.length)
  } catch (error) {
    if (uploadId) {
      try { await send({ type: 'vfs:upload-abort', sessionId, uploadId } satisfies VfsUploadMessage) } catch { /* Reason: a restarted worker has already discarded the buffer. */ }
    }
    throw error
  }
}
