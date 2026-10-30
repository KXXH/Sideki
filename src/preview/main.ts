import { readHtmlPreviewNetwork } from '../shared/html-artifact'
import { readHtmlArtifactTheme } from '../shared/html-artifact-theme'
import { loadConfig, loadSessionIndex } from '../shared/storage'
import { applyColorMode, applyFont, applyProMode, applyTheme, THEME_CHANGE_EVENT } from '../shared/themes'
import {
  mountHtmlPreview, previewFileBlob, previewFileExtension, readHtmlPreview, readPreviewFile, validatePreviewPath,
} from './preview-host'

async function main() {
  // Reason: old previews registered a web SW; rendering no longer depends on its scope or client routing.
  if (navigator.serviceWorker?.getRegistrations) {
    void navigator.serviceWorker.getRegistrations().then(registrations => Promise.all(
      registrations.filter(registration => registration.scope === chrome.runtime.getURL('src/preview/'))
        .map(registration => registration.unregister()),
    )).catch(error => console.warn('[preview] old worker cleanup failed:', error))
  }
  const params = new URLSearchParams(location.search)
  const sessionId = params.get('session')
  const filePath = params.get('file')
  const filepathEl = document.getElementById('filepath')!
  const contentEl = document.getElementById('content')!
  const statusEl = document.getElementById('status')!
  const retryButton = document.getElementById('retry') as HTMLButtonElement
  const downloadButton = document.getElementById('download') as HTMLButtonElement
  const showError = (message: string) => {
    statusEl.hidden = false
    statusEl.dataset.state = 'error'
    statusEl.textContent = message
    retryButton.hidden = false
  }
  if (!sessionId || !filePath) {
    showError('缺少参数：session 或 file。请从会话中的文件链接打开预览。')
    downloadButton.disabled = true
    retryButton.hidden = true
    return
  }
  try { validatePreviewPath(filePath) } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
    downloadButton.disabled = true
    retryButton.hidden = true
    return
  }

  const send = (message: Record<string, unknown>) => chrome.runtime.sendMessage(message)
  filepathEl.textContent = filePath
  const filename = filePath.split('/').pop() || 'file'
  document.title = `${filename} · Sideki`
  let frameHost: ReturnType<typeof mountHtmlPreview> | null = null
  let imageUrl: string | null = null
  let generation = 0
  const cleanupContent = () => {
    frameHost?.dispose()
    frameHost = null
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    imageUrl = null
  }
  const updateTheme = () => frameHost?.updateTheme()
  window.addEventListener(THEME_CHANGE_EVENT, updateTheme)
  const sessions = await loadSessionIndex().catch(() => [])
  const proMode = sessions.find(session => session.id === sessionId)?.mode === 'pro'
  const syncTheme = async () => {
    const config = await loadConfig()
    applyFont(config?.fontFamily ?? 'sans', config?.fontSize ?? 'default')
    applyColorMode(config?.colorMode)
    applyTheme(config?.accentColor)
    applyProMode(proMode)
  }
  await syncTheme().catch(error => console.warn('[preview] theme initialization failed:', error))
  const onConfigChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes.sidekick_config) void syncTheme().catch(error => console.warn('[preview] theme update failed:', error))
  }
  chrome.storage.onChanged.addListener(onConfigChanged)

  const open = async () => {
    const current = ++generation
    cleanupContent()
    contentEl.replaceChildren()
    statusEl.hidden = false
    statusEl.dataset.state = 'loading'
    statusEl.textContent = '正在加载预览…'
    retryButton.hidden = true
    const fail = (message: string) => { if (generation === current) showError(message) }
    try {
      const ext = previewFileExtension(filePath)
      if (['.html', '.htm', '.svg'].includes(ext)) {
        const { html, network } = await readHtmlPreview(send, sessionId, filePath, readHtmlPreviewNetwork(params))
        if (current !== generation) return
        frameHost = mountHtmlPreview({
          container: contentEl, html, network, title: filename, getTheme: readHtmlArtifactTheme,
          canvas: { sessionId, canvasId: params.get('canvas') || `path:${filePath}`, path: filePath, title: filename },
          onError: fail,
          onRendered: () => { if (current === generation && statusEl.dataset.state !== 'error') statusEl.hidden = true },
        })
      } else {
        const content = await readPreviewFile(send, sessionId, filePath)
        if (current !== generation) return
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
          imageUrl = URL.createObjectURL(previewFileBlob(filePath, content))
          const img = document.createElement('img')
          img.alt = filename
          img.addEventListener('error', () => fail('图片无法显示，文件可能已损坏。'))
          img.src = imageUrl
          contentEl.replaceChildren(img)
        } else {
          const pre = document.createElement('pre')
          pre.textContent = content
          contentEl.replaceChildren(pre)
        }
        statusEl.hidden = true
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  retryButton.addEventListener('click', () => void open())
  downloadButton.addEventListener('click', async () => {
    downloadButton.disabled = true
    try {
      const content = await readPreviewFile(send, sessionId, filePath)
      const url = URL.createObjectURL(previewFileBlob(filePath, content))
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      showError(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      downloadButton.disabled = false
    }
  })
  window.addEventListener('pagehide', () => {
    generation++
    cleanupContent()
    window.removeEventListener(THEME_CHANGE_EVENT, updateTheme)
    chrome.storage.onChanged.removeListener(onConfigChanged)
  }, { once: true })
  await open()
}

main().catch(error => {
  const status = document.getElementById('status')
  if (status) {
    status.hidden = false
    status.dataset.state = 'error'
    status.textContent = error instanceof Error ? error.message : String(error)
  }
})
