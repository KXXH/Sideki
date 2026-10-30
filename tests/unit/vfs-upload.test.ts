import { describe, it, expect, vi } from 'vitest'
import { createVfsUploadReceiver } from '../../src/background/vfs-upload'
import { uploadVfsFile, VFS_UPLOAD_CHUNK_BYTES, VFS_UPLOAD_MAX_BYTES } from '../../src/shared/vfs-upload'
import type { VfsUploadResponse } from '../../src/shared/vfs-upload'

const sessionId = 'session-1'
const path = '/tmp/attachments/doc.pdf'

async function start(receive: ReturnType<typeof createVfsUploadReceiver>, size: number) {
  const reply = await receive({ type: 'vfs:upload-start', sessionId, path, size })
  if (!reply.success) throw new Error(reply.error)
  return (offset: number, content: string, over: Record<string, unknown> = {}) => receive({
    type: 'vfs:upload-chunk', sessionId, path, size, uploadId: reply.uploadId, offset, content, ...over,
  })
}

describe('VFS upload wire and atomic commit', () => {
  it('roundtrips all byte values at 32MiB with every JSON message below 64MiB', async () => {
    const source = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)).repeat(VFS_UPLOAD_MAX_BYTES / 256)
    let saved = ''
    const commit = vi.fn(async (_session: string, _path: string, content: string) => { saved = content })
    const receive = createVfsUploadReceiver(commit)
    const offsets: number[] = []
    let largestFrame = 0
    let inFlight = 0
    await uploadVfsFile(sessionId, path, source, async message => {
      expect(inFlight++).toBe(0)
      try {
        const wire = JSON.stringify(message)
        largestFrame = Math.max(largestFrame, Buffer.byteLength(wire, 'utf8'))
        if (message.type === 'vfs:upload-chunk') {
          offsets.push(message.offset as number)
          expect((message.content as string).length).toBeLessThanOrEqual(VFS_UPLOAD_CHUNK_BYTES)
          expect(commit).not.toHaveBeenCalled()
        }
        return await receive(JSON.parse(wire))
      } finally { inFlight-- }
    })
    expect(largestFrame).toBeLessThan(64 * 1024 * 1024)
    expect(offsets).toEqual(Array.from({ length: 32 }, (_, i) => i * VFS_UPLOAD_CHUNK_BYTES))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(saved.length).toBe(source.length)
    expect(Buffer.from(saved, 'latin1').equals(Buffer.from(source, 'latin1'))).toBe(true)
  })

  it('keeps even the worst JSON escaping comfortably below the message limit', async () => {
    const receive = createVfsUploadReceiver(async () => {})
    await uploadVfsFile(sessionId, path, '\x00'.repeat(VFS_UPLOAD_CHUNK_BYTES), async message => {
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(64 * 1024 * 1024)
      return receive(message)
    })
  })

  it('does not acknowledge completion until the durable write resolves', async () => {
    let finish!: () => void
    const commit = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const chunk = await start(createVfsUploadReceiver(commit), 2)
    expect(await chunk(0, 'a')).toMatchObject({ success: true, complete: false, nextOffset: 1 })
    expect(commit).not.toHaveBeenCalled()
    let complete = false
    const result = chunk(1, 'b').then(reply => { complete = true; return reply })
    await Promise.resolve()
    expect(complete).toBe(false)
    expect(commit).toHaveBeenCalledWith(sessionId, path, 'ab')
    finish()
    expect(await result).toMatchObject({ success: true, complete: true, nextOffset: 2 })
  })

  it('publishes an empty file only after an explicit final empty chunk', async () => {
    const commit = vi.fn(async () => {})
    const receive = createVfsUploadReceiver(commit)
    await uploadVfsFile(sessionId, path, '', receive)
    expect(commit).toHaveBeenCalledExactlyOnceWith(sessionId, path, '')
  })

  it('reports a capacity rejection without overwriting an existing published file', async () => {
    const published = new Map([[path, 'original']])
    const commit = vi.fn(async (_session: string, _path: string, content: string) => {
      if (content.length > 1) throw new Error('VFS capacity exceeded')
      published.set(_path, content)
    })
    const receive = createVfsUploadReceiver(commit)
    await expect(uploadVfsFile(sessionId, path, 'large', receive)).rejects.toThrow('VFS capacity exceeded')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(published.get(path)).toBe('original')
  })
})

describe('VFS upload interruptions and validation', () => {
  it('aborts on a failed middle message and discards all staged chunks', async () => {
    const commit = vi.fn(async () => {})
    const receive = createVfsUploadReceiver(commit)
    let lastChunk: Record<string, unknown> = {}
    const messages: Record<string, unknown>[] = []
    await expect(uploadVfsFile(sessionId, path, 'x'.repeat(2 * VFS_UPLOAD_CHUNK_BYTES), async message => {
      messages.push(message)
      if (message.type === 'vfs:upload-chunk' && message.offset !== 0) {
        lastChunk = message
        throw new Error('message channel closed')
      }
      return receive(message)
    })).rejects.toThrow('message channel closed')
    expect(messages.at(-1)?.type).toBe('vfs:upload-abort')
    expect(await receive(lastChunk)).toMatchObject({ success: false, error: expect.stringContaining('已失效') })
    expect(commit).not.toHaveBeenCalled()
  })

  it('cancels a changed session between chunks without publishing a partial file', async () => {
    const commit = vi.fn(async () => {})
    const receive = createVfsUploadReceiver(commit)
    let switched = false
    const send = vi.fn(async (message: Record<string, unknown>) => {
      const reply = await receive(message)
      if (message.type === 'vfs:upload-chunk') switched = true
      return reply
    })
    await expect(uploadVfsFile(sessionId, path, 'x'.repeat(2 * VFS_UPLOAD_CHUNK_BYTES), send, () => {
      if (switched) throw new Error('会话已切换')
    })).rejects.toThrow('会话已切换')
    expect(send.mock.calls.at(-1)?.[0].type).toBe('vfs:upload-abort')
    expect(commit).not.toHaveBeenCalled()
  })

  it('rejects continuation after a worker restart, including offset zero', async () => {
    const commit = vi.fn(async () => {})
    let receive = createVfsUploadReceiver(commit)
    await expect(uploadVfsFile(sessionId, path, 'x', async message => {
      const reply = await receive(message)
      if (message.type === 'vfs:upload-start') receive = createVfsUploadReceiver(commit)
      return reply
    })).rejects.toThrow('后台已重启')
    expect(commit).not.toHaveBeenCalled()
  })

  it('rejects a missing, reordered or duplicate chunk and invalidates the upload', async () => {
    for (const offset of [0, 2, -1, 0.5]) {
      const commit = vi.fn(async () => {})
      const chunk = await start(createVfsUploadReceiver(commit), 3)
      await chunk(0, 'a')
      expect(await chunk(offset, 'b')).toMatchObject({ success: false, error: expect.stringContaining('顺序') })
      expect(await chunk(1, 'bc')).toMatchObject({ success: false })
      expect(commit).not.toHaveBeenCalled()
    }
  })

  it.each([
    { path: '/tmp/attachments/../escape.pdf' }, { path: '/notes/file.pdf' }, { path: '/tmp/attachments/..' },
    { size: -1 }, { size: 1.5 }, { size: VFS_UPLOAD_MAX_BYTES + 1 }, { sessionId: '' }, { sessionId: '../other' },
  ])('rejects invalid upload initialization %j', async over => {
    const commit = vi.fn(async () => {})
    const reply = await createVfsUploadReceiver(commit)({ type: 'vfs:upload-start', sessionId, path, size: 1, ...over })
    expect(reply.success).toBe(false)
    expect(commit).not.toHaveBeenCalled()
  })

  it.each([
    { path: '/tmp/attachments/other.pdf' }, { size: 2 }, { content: 'xx' },
    { content: '汉' }, { content: '' }, { content: 'x'.repeat(VFS_UPLOAD_CHUNK_BYTES + 1) },
  ])('rejects malformed chunk %# without publishing', async over => {
    const commit = vi.fn(async () => {})
    const chunk = await start(createVfsUploadReceiver(commit), 1)
    expect((await chunk(0, 'x', over)).success).toBe(false)
    expect((await chunk(0, 'x')).success).toBe(false)
    expect(commit).not.toHaveBeenCalled()
  })

  it('rejects incorrect session/ID without consuming the legitimate upload', async () => {
    const commit = vi.fn(async () => {})
    const chunk = await start(createVfsUploadReceiver(commit), 1)
    expect((await chunk(0, 'x', { sessionId: 'other' })).success).toBe(false)
    expect((await chunk(0, 'x', { uploadId: 'unknown' })).success).toBe(false)
    expect((await chunk(0, 'x', { uploadId: '../bad' })).success).toBe(false)
    expect((await chunk(0, 'x')).success).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('cleans aborted and expired uploads so abandoned buffers do not exhaust staging', async () => {
    let now = 0
    const receive = createVfsUploadReceiver(async () => {}, () => now)
    const starts: VfsUploadResponse[] = []
    for (let i = 0; i < 4; i++) starts.push(await receive({ type: 'vfs:upload-start', sessionId, path, size: 1 }))
    expect((await receive({ type: 'vfs:upload-start', sessionId, path, size: 1 })).success).toBe(false)
    const first = starts[0]
    if (!first.success) throw new Error(first.error)
    expect((await receive({ type: 'vfs:upload-abort', sessionId, uploadId: first.uploadId })).success).toBe(true)
    expect((await receive({ type: 'vfs:upload-start', sessionId, path, size: 1 })).success).toBe(true)
    now += 5 * 60 * 1000 + 1
    expect((await receive({ type: 'vfs:upload-start', sessionId, path, size: 1 })).success).toBe(true)
    const second = starts[1]
    if (!second.success) throw new Error(second.error)
    expect((await receive({ type: 'vfs:upload-chunk', sessionId, uploadId: second.uploadId, path, size: 1, offset: 0, content: 'x' })).success).toBe(false)
  })

  it('rejects missing or incorrect acknowledgments instead of reporting success', async () => {
    const receive = createVfsUploadReceiver(async () => {})
    await expect(uploadVfsFile(sessionId, path, 'x', async message => {
      const reply = await receive(message)
      return message.type === 'vfs:upload-chunk' ? { ...reply, nextOffset: 0 } : reply
    })).rejects.toThrow('分片确认不匹配')
    await expect(uploadVfsFile(sessionId, path, 'x', async () => undefined)).rejects.toThrow('未收到确认')
  })
})
