import { validateHtmlArtifact } from '../shared/html-artifact'
import { createCanvasHost, type CanvasHost } from '../shared/canvas-host'
import type { CanvasBinding } from '../shared/canvas-state'

export type PreviewSender = (message: Record<string, unknown>) => Promise<unknown>
export interface PreviewTheme {
  mode: 'light' | 'dark'
  tokens: Record<string, string>
}
interface FileResponse { success?: boolean; content?: string; error?: string }

async function requestPreviewFile(send: PreviewSender, sessionId: string, path: string): Promise<FileResponse | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      send({ type: 'dev:cat', sessionId, path }) as Promise<FileResponse | undefined>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('读取文件超时，请确认扩展正在运行后重试。')), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function validatePreviewPath(path: string): void {
  if (!/^\/(tmp|page|viz)\//.test(path) || path.split('/').includes('..') || (/[?#]/.test(path) || path.includes('\0'))) {
    throw new Error('预览路径必须位于 /tmp/、/page/ 或 /viz/，且不能包含路径跳转。')
  }
}

export async function readPreviewFile(send: PreviewSender, sessionId: string, path: string): Promise<string> {
  const response = await requestPreviewFile(send, sessionId, path)
  if (!response?.success || typeof response.content !== 'string') {
    throw new Error(response?.error || '无法读取文件，请确认会话和文件仍然存在。')
  }
  return response.content
}

export async function readHtmlPreview(
  send: PreviewSender, sessionId: string, path: string, requestedNetwork = false,
): Promise<{ html: string; network: boolean }> {
  validatePreviewPath(path)
  const html = await readPreviewFile(send, sessionId, path)
  const network = requestedNetwork === true
  validateHtmlArtifact(html, { network })
  return { html, network }
}

export function previewFileExtension(path: string): string {
  return path.slice(path.lastIndexOf('.')).toLowerCase()
}

export function previewFileMime(path: string): string {
  const types: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript',
    '.txt': 'text/plain', '.md': 'text/plain',
  }
  return types[previewFileExtension(path)] ?? 'application/octet-stream'
}

export function decodePreviewBytes(content: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(content.length)
  for (let index = 0; index < content.length; index++) bytes[index] = content.charCodeAt(index) & 0xff
  return bytes
}

export function previewFileBlob(path: string, content: string): Blob {
  const binary = /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(path)
  return new Blob([binary ? decodePreviewBytes(content) : content], { type: previewFileMime(path) })
}

export interface HtmlPreviewFrameOptions {
  canvas?: CanvasBinding
  container: HTMLElement
  html: string
  network: boolean
  title: string
  getTheme: () => PreviewTheme
  onError: (message: string) => void
  onRendered: () => void
  timeoutMs?: number
}

export function mountHtmlPreview(options: HtmlPreviewFrameOptions): { dispose: () => void; updateTheme: () => void } {
  const id = crypto.randomUUID()
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.title = options.title
  frame.className = 'preview-frame'
  let ready = false
  let disposed = false
  let failed = false
  let canvasHost: CanvasHost | null = null
  // Reason: a tab owns a real viewport and scrolls inside the frame; chat-only auto-height would distort vh layouts.
  frame.style.height = '100%'
  const onMessage = (event: MessageEvent) => {
    if (disposed || event.source !== frame.contentWindow) return
    const data = event.data as { type?: string; id?: string; height?: number; message?: string } | null
    if (!data || typeof data !== 'object') return
    if (data.type === 'viz:ready') {
      if (ready) return
      ready = true
      const render = async () => {
        if (options.canvas) canvasHost = await createCanvasHost(options.canvas, message => {
          if (!disposed) frame.contentWindow?.postMessage({ ...message, id }, '*')
        })
        if (disposed) { canvasHost?.dispose(); return }
        frame.contentWindow?.postMessage({ type: 'viz:render', id, html: options.html, theme: options.getTheme(), sideki: canvasHost?.initial }, '*')
      }
      void render().catch(error => { if (!disposed) options.onError(error instanceof Error ? error.message : String(error)) })
      return
    }
    if (data.id !== id) return
    if (canvasHost?.handle(data)) return
    if (data.type === 'viz:error') {
      clearTimeout(timer)
      failed = true
      options.onError(typeof data.message === 'string' && data.message ? data.message : 'HTML 渲染失败。')
    } else if (data.type === 'viz:rendered') {
      clearTimeout(timer)
      if (!failed) options.onRendered()
    }
  }
  // Reason: the host must listen before loading the sandbox, or its ready handshake can be lost.
  window.addEventListener('message', onMessage)
  const timer = window.setTimeout(() => {
    failed = true
    options.onError('HTML 加载超时，请重试。')
  }, options.timeoutMs ?? 12_000)
  frame.src = chrome.runtime.getURL(options.network ? 'src/viz/sandbox-online.html' : 'src/viz/sandbox.html')
  options.container.replaceChildren(frame)
  return {
    updateTheme: () => {
      if (ready && !disposed) frame.contentWindow?.postMessage({ type: 'viz:theme', id, theme: options.getTheme() }, '*')
    },
    dispose: () => {
      disposed = true
      canvasHost?.dispose()
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      frame.remove()
    },
  }
}
