import { dataUrlToLatin1 } from './format'
import type { FilePartData } from './message-protocol'
import type { ElementAttachment } from './types'
import { isUploadPath, isUploadSize, uploadVfsFile, VFS_UPLOAD_MAX_BYTES } from './vfs-upload'
import type { UploadSender } from './vfs-upload'

export interface AttachmentMirrorResult {
  notes: string
  savedFiles: FilePartData[]
}

const IMAGE_CAP = 5 * 1024 * 1024
// Reason: retries of a partially uploaded batch must not accumulate duplicate files in the VFS.
const draftPaths = new WeakMap<NonNullable<ElementAttachment['file']>, string>()

function checkSavedFile(file: NonNullable<ElementAttachment['savedFile']>, sessionId: string): void {
  if (file.sessionId !== sessionId) throw new Error('附件属于其他会话，请切回原会话后发送')
  if (!isUploadPath(file.path) || !isUploadSize(file.size)) throw new Error('附件文件引用无效，请重新上传')
}

export async function prepareFileAttachments(
  attachments: ElementAttachment[] | undefined,
  sessionId: string,
  largeFileUploads: boolean,
  send: UploadSender,
  assertCurrent: () => void = () => {},
): Promise<ElementAttachment[] | undefined> {
  if (!attachments?.length) return attachments
  for (const a of attachments) {
    if (a.savedFile) checkSavedFile(a.savedFile, sessionId)
    if (!a.file) continue
    const cap = largeFileUploads ? VFS_UPLOAD_MAX_BYTES : 500 * 1024
    if (a.file.latin1.length > cap) {
      throw new Error(`${a.file.name} 上传失败：${Math.round(a.file.latin1.length / 1024)} KiB，超过 ${Math.round(cap / 1024)} KiB 上限${largeFileUploads ? '' : '；可在设置 → 文件与附件中启用“大文件上传”'}`)
    }
  }
  const prepared: ElementAttachment[] = []
  for (const a of attachments) {
    assertCurrent()
    if (!a.file) { prepared.push(a); continue }
    const { file, ...rest } = a
    const safe = (file.name.split(/[/\\]/).pop() || 'upload').replace(/[^A-Za-z0-9._-]/g, '_').slice(-64)
    const path = draftPaths.get(file) ?? `/tmp/attachments/${crypto.randomUUID()}-${safe}`
    draftPaths.set(file, path)
    try {
      await uploadVfsFile(sessionId, path, file.latin1, send, assertCurrent)
    } catch (error) {
      throw new Error(`${file.name} 上传失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    prepared.push({ ...rest, savedFile: { sessionId, path, name: file.name, size: file.latin1.length, mime: file.mime } })
  }
  assertCurrent()
  return prepared
}

export async function mirrorAttachments(
  attachments: ElementAttachment[] | undefined,
  sessionId: string,
  imageFs: boolean,
  send: UploadSender,
): Promise<AttachmentMirrorResult> {
  const result: AttachmentMirrorResult = { notes: '', savedFiles: [] }
  if (!attachments?.length) return result

  for (const a of attachments) {
    if (a.file) throw new Error('文件尚未上传，请在输入框重新发送')
    if (a.savedFile) checkSavedFile(a.savedFile, sessionId)
  }

  // Reason: image mirroring remains optional; the original vision part still reaches the model.
  if (imageFs) {
    let idx = 0
    for (const a of attachments) {
      if (!a.croppedImage) continue
      const latin1 = dataUrlToLatin1(a.croppedImage)
      const path = `/tmp/attachments/${Date.now()}-${idx++}.jpeg`
      if (!latin1 || latin1.length > IMAGE_CAP) {
        result.notes += `\n[attachment not saved: ${!latin1 ? 'unsupported format' : 'too large'}]`
        continue
      }
      try {
        const resp = await send({ type: 'vfs:write', sessionId, path, content: latin1 })
        result.notes += (resp as { success?: boolean } | undefined)?.success
          ? `\n[attachment saved: ${path} (${Math.round(latin1.length / 1024)}KB)]`
          : '\n[attachment not saved: write failed]'
      } catch {
        result.notes += '\n[attachment not saved: write failed]'
      }
    }
  }

  for (const a of attachments) {
    if (!a.savedFile) continue
    const { name, path, size } = a.savedFile
    const how = /\.pdf$/i.test(path) ? `pdf ${path}` : `cat ${path}`
    result.notes += `\n[file saved: ${path} (${Math.round(size / 1024)}KB) — read it with: ${how}]`
    result.savedFiles.push({ name, size, path })
  }
  return result
}
