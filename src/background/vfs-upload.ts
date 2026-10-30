import { isUploadPath, isUploadSize, VFS_UPLOAD_CHUNK_BYTES, VFS_UPLOAD_MAX_BYTES } from '../shared/vfs-upload'
import type { VfsUploadResponse } from '../shared/vfs-upload'

interface PendingUpload {
  sessionId: string
  path: string
  size: number
  offset: number
  chunks: string[]
  touchedAt: number
  committing: boolean
}

const UPLOAD_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_UPLOADS = 4
const MAX_PENDING_BYTES = 2 * VFS_UPLOAD_MAX_BYTES
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(id)

// Reason: staging stays outside the VFS so only the durable, complete file becomes visible.
export function createVfsUploadReceiver(
  commit: (sessionId: string, path: string, content: string) => Promise<void>,
  now: () => number = Date.now,
) {
  const pending = new Map<string, PendingUpload>()

  return async (raw: unknown): Promise<VfsUploadResponse> => {
    for (const [id, upload] of pending) {
      if (!upload.committing && now() - upload.touchedAt > UPLOAD_TTL_MS) pending.delete(id)
    }
    const message = raw as Record<string, unknown> | null
    if (!message || !validId(message.sessionId)) return { success: false, error: '上传 sessionId 无效' }
    const { sessionId } = message
    if (message.type === 'vfs:upload-start') {
      const { path, size } = message
      if (!isUploadPath(path) || !isUploadSize(size)) return { success: false, error: '上传路径或文件大小无效' }
      const reserved = [...pending.values()].reduce((total, upload) => total + upload.size, 0)
      if (pending.size >= MAX_PENDING_UPLOADS || reserved + size > MAX_PENDING_BYTES) {
        return { success: false, error: '上传暂存空间已满，请稍后重试' }
      }
      const uploadId = crypto.randomUUID()
      pending.set(uploadId, { sessionId, path, size, offset: 0, chunks: [], touchedAt: now(), committing: false })
      return { success: true, uploadId, nextOffset: 0, complete: false }
    }
    if (!validId(message.uploadId)) return { success: false, error: '上传 ID 无效' }
    const { uploadId } = message
    const upload = pending.get(uploadId)
    if (!upload || upload.sessionId !== sessionId) {
      return { success: false, error: '上传已失效或会话不匹配（可能后台已重启），请重新发送' }
    }
    if (upload.committing) return { success: false, error: '文件正在提交，不能继续上传或取消' }
    if (message.type === 'vfs:upload-abort') {
      pending.delete(uploadId)
      return { success: true, uploadId, nextOffset: upload.offset, complete: false }
    }
    const fail = (error: string): VfsUploadResponse => {
      pending.delete(uploadId)
      return { success: false, error }
    }
    if (message.type !== 'vfs:upload-chunk') return fail('上传消息类型无效')
    const { path, size, offset, content } = message
    if (path !== upload.path || size !== upload.size) return fail('上传路径或大小与初始化不一致')
    if (!Number.isSafeInteger(offset) || offset !== upload.offset) return fail('上传分片顺序错误，请重新发送')
    if (typeof content !== 'string' || content.length > VFS_UPLOAD_CHUNK_BYTES
      || upload.offset + content.length > upload.size || (content.length === 0 && upload.size !== 0)) {
      return fail('上传分片大小无效')
    }
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) > 255) return fail('上传分片不是 Latin1 字节串')
    }
    upload.chunks.push(content)
    upload.offset += content.length
    upload.touchedAt = now()
    if (upload.offset < upload.size) return { success: true, uploadId, nextOffset: upload.offset, complete: false }
    upload.committing = true
    try {
      const complete = upload.chunks.join('')
      upload.chunks = []
      await commit(sessionId, upload.path, complete)
      return { success: true, uploadId, nextOffset: upload.size, complete: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      pending.delete(uploadId)
    }
  }
}
