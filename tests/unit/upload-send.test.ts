import { describe, it, expect, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { createVfsUploadReceiver } from '../../src/background/vfs-upload'
import { prepareFileAttachments } from '../../src/shared/attachment-mirror'
import { expandForModel } from '../../src/shared/message-protocol'
import { SessionRuntime } from '../../src/shared/kernel/kernel-runtime'
import type { KernelEnv } from '../../src/shared/kernel/kernel-runtime'
import type { ApiConfig, ElementAttachment } from '../../src/shared/types'

vi.mock('../../src/shared/agent', () => ({ createAgent: vi.fn().mockResolvedValue({}) }))
vi.mock('../../src/shared/ai-provider', () => ({ generateTitle: vi.fn(), compactContext: vi.fn() }))

const attachment: ElementAttachment = {
  croppedImage: '', domSnapshot: '', label: 'sample.pdf',
  file: { name: 'sample.pdf', mime: 'application/pdf', latin1: '%PDF-1.7\nsynthetic bytes' },
}

function runtime(sessionId = 's1') {
  const config = { model: 'synthetic', mcpServers: [], labImageFs: true } as unknown as ApiConfig
  const env: KernelEnv = {
    loadConfig: vi.fn().mockResolvedValue(config), onConfigChanged: vi.fn().mockReturnValue(() => {}),
    loadSessions: vi.fn().mockResolvedValue([]), loadSession: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined), updateSessionMeta: vi.fn().mockResolvedValue(undefined), deleteSession: vi.fn().mockResolvedValue(undefined),
    removeHistory: vi.fn().mockResolvedValue(undefined), sendMessage: vi.fn(async (msg: { type?: string }) => msg.type === 'canvas:request' ? { success: true, result: [] } : undefined),
  }
  const rt = new SessionRuntime({
    session: { id: sessionId, title: 'test', messages: [], createdAt: 1, updatedAt: 1 },
    getConfig: () => config, env,
    hooks: { getCurrentTabId: () => null, getPageInfo: () => ({ title: 'Synthetic', url: 'chrome://newtab/' }), extractContent: vi.fn() },
  })
  const send = vi.spyOn(rt.chat, 'sendMessage').mockResolvedValue(undefined)
  return { rt, send, env }
}

describe('uploaded file send pipeline', () => {
  it('sends a file-only message with data-file and model attachment notes, without another upload', async () => {
    const commit = vi.fn(async () => {})
    const uploaded = await prepareFileAttachments([attachment], 's1', true, createVfsUploadReceiver(commit))
    const wire = JSON.stringify({ text: '', attachments: uploaded })
    expect(wire).not.toContain('latin1')
    const item = JSON.parse(wire)
    const { rt, send, env } = runtime()
    await rt.kernel.handleSend(item.text, item.attachments)
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0][0] as UIMessage
    expect(message.parts).toEqual([{ type: 'data-file', data: {
      path: uploaded![0].savedFile!.path, name: attachment.file!.name, size: attachment.file!.latin1.length,
    } }])
    expect(message.metadata).toMatchObject({ v: 2, attachmentNotes: expect.stringContaining(uploaded![0].savedFile!.path) })
    expect(expandForModel({ ...message, id: 'user', role: 'user' }).parts).toEqual([
      { type: 'text', text: expect.stringContaining(`pdf ${uploaded![0].savedFile!.path}`) },
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    expect(env.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^vfs:upload/) }))
  })

  it('queues only saved references while the agent is busy and preserves them on flush', async () => {
    const uploaded = await prepareFileAttachments([attachment], 's1', true, createVfsUploadReceiver(async () => {}))
    const { rt, send } = runtime()
    rt.kstate.status = 'streaming'
    await rt.kernel.handleSend('', uploaded)
    expect(send).not.toHaveBeenCalled()
    expect(rt.kernel.queue).toHaveLength(1)
    expect(JSON.stringify(rt.kernel.queue)).not.toContain('latin1')
    rt.kstate.status = 'ready'
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect((send.mock.calls[0][0] as UIMessage).parts[0]).toMatchObject({ type: 'data-file', data: { name: 'sample.pdf' } })
  })

  it('does not deliver a reference accidentally routed to a different session', async () => {
    const uploaded = await prepareFileAttachments([attachment], 's1', true, createVfsUploadReceiver(async () => {}))
    const { rt, send } = runtime('other-session')
    await rt.kernel.handleSend('', uploaded)
    expect(send).not.toHaveBeenCalled()
    expect(rt.kstate.error?.message).toContain('其他会话')
  })

  it('does not call send or queue when pre-upload fails', async () => {
    const { rt, send } = runtime()
    rt.kstate.status = 'streaming'
    const attempt = async () => {
      const prepared = await prepareFileAttachments([attachment], 's1', true, createVfsUploadReceiver(async () => { throw new Error('storage unavailable') }))
      await rt.kernel.handleSend('', prepared)
    }
    await expect(attempt()).rejects.toThrow('storage unavailable')
    expect(rt.kernel.queue).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
    expect(attachment.file?.latin1).toBe('%PDF-1.7\nsynthetic bytes')
  })
})
