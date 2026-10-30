import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { THEME_CHANGE_EVENT } from '../../shared/themes'
import { getActiveSessionId } from '../../shared/tools/bridge'
import { readHtmlArtifactTheme } from '../../shared/html-artifact-theme'
import { buildHtmlPreviewUrl, validateHtmlArtifact } from '../../shared/html-artifact'
import { iconAlertCircleOutline } from '../../shared/icons'
import { createCanvasHost, type CanvasHost } from '../../shared/canvas-host'

interface Props {
  canvasId?: string
  sessionId: string
  path: string
  title: string
  network?: boolean
}

interface FrameMessage {
  type?: string
  id?: string
  height?: number
  message?: string
}

export default function VizFrame({ sessionId, path, title, canvasId = `path:${path}`, network = false }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const canvasHostRef = useRef<CanvasHost | null>(null)
  const [sdk, setSdk] = useState<CanvasHost['initial'] | null>(null)
  const idRef = useRef(crypto.randomUUID())
  const renderedRef = useRef(false)
  const hasRenderedRef = useRef(false)
  const firstFrameFailureRef = useRef(false)
  const [html, setHtml] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [height, setHeight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [frameNonce, setFrameNonce] = useState(0)
  const [readNonce, setReadNonce] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const resolvedSessionId = sessionId || getActiveSessionId()
  // Reason: both pages share the manifest sandbox CSP ceiling; the offline page
  // tightens itself with a meta policy, so the render mode is a build-time pair
  // rather than anything the frame can switch at runtime.
  const sandboxUrl = chrome.runtime.getURL(network ? 'src/viz/sandbox-online.html' : 'src/viz/sandbox.html')
  const displayError = error ?? (resolvedSessionId ? null : '缺少会话上下文，无法读取可视化快照。')
  const frameHeight = height > 0 ? height : 96
  const errorSummary = displayError?.split('\n')[0] ?? ''

  // Reason: subscribe before the frame can post viz:ready — a layout effect runs
  // in the same commit that inserts the iframe, so its first message cannot win
  // the race.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as FrameMessage | undefined
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return
      // Reason: viz:ready carries no id (it announces the frame), every later
      // message must match this instance's nonce.
      if (data.type !== 'viz:ready' && data.id !== idRef.current) return
      if (canvasHostRef.current?.handle(data)) return
      if (data.type === 'viz:ready') {
        setReady(true)
      } else if (data.type === 'viz:resize') {
        // Reason: a failed first frame still has the scene's empty containers
        // in the DOM, so its measured height is not a height worth preserving.
        if (firstFrameFailureRef.current) return
        if (typeof data.height === 'number' && Number.isFinite(data.height) && data.height >= 0) {
          setHeight(Math.min(20_000, Math.max(96, Math.ceil(data.height))))
        }
      } else if (data.type === 'viz:error') {
        if (!hasRenderedRef.current) {
          firstFrameFailureRef.current = true
          setHeight(0)
        }
        setError(typeof data.message === 'string' && data.message ? data.message : '可视化渲染失败')
      } else if (data.type === 'viz:rendered') {
        hasRenderedRef.current = true
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Reason: read once per snapshot — the path is content-addressed, so a new
  // path always means new content. Retry re-reads because the first failure may
  // have been the read itself.
  useEffect(() => {
    let cancelled = false
    renderedRef.current = false
    hasRenderedRef.current = false
    firstFrameFailureRef.current = false
    if (!resolvedSessionId) return
    chrome.runtime.sendMessage({ type: 'dev:cat', sessionId: resolvedSessionId, path })
      .then(async (resp: { success?: boolean; content?: string; error?: string } | undefined) => {
        if (cancelled) return
        if (!resp?.success || typeof resp.content !== 'string') {
          setError(resp?.error || `无法读取快照文件 ${path}`)
          return
        }
        validateHtmlArtifact(resp.content, { network })
        const host = await createCanvasHost({ sessionId: resolvedSessionId, canvasId, path, title }, message => {
          iframeRef.current?.contentWindow?.postMessage({ ...message, id: idRef.current }, '*')
        })
        if (cancelled) { host.dispose(); return }
        canvasHostRef.current = host
        setSdk(host.initial)
        setError(null)
        setHtml(resp.content)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true; canvasHostRef.current?.dispose(); canvasHostRef.current = null }
  }, [resolvedSessionId, canvasId, path, title, network, readNonce])

  const applyRendered = () => {
    if (!ready || html === null || sdk === null || renderedRef.current) return
    const frame = iframeRef.current
    if (!frame?.contentWindow) return
    frame.contentWindow.postMessage(
      { type: 'viz:render', id: idRef.current, html, theme: readHtmlArtifactTheme(), sideki: sdk },
      '*',
    )
    renderedRef.current = true
  }

  // Reason: wait for both the frame handshake and the file read — posting into
  // an unready frame would be dropped silently.
  useEffect(applyRendered, [ready, html, sdk])

  // Reason: theme switches repaint tokens inside the frame without replaying
  // the fragment (content is immutable for a snapshot).
  useEffect(() => {
    const onTheme = () => {
      if (!renderedRef.current) return
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'viz:theme', id: idRef.current, theme: readHtmlArtifactTheme() },
        '*',
      )
    }
    window.addEventListener(THEME_CHANGE_EVENT, onTheme)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onTheme)
  }, [])

  // Reason: a frame that never handshakes, or handshakes but never reports a
  // height, would otherwise leave the placeholder spinning forever. Re-arms on
  // retry even when the previous height is preserved.
  useEffect(() => {
    if (!resolvedSessionId || error) return
    if (height > 0 && ready) return
    const timer = setTimeout(() => setError('可视化加载超时。展开详情可查看快照。'), 12_000)
    return () => clearTimeout(timer)
  }, [resolvedSessionId, height, error, ready, frameNonce])

  const retry = () => {
    renderedRef.current = false
    hasRenderedRef.current = false
    firstFrameFailureRef.current = false
    idRef.current = crypto.randomUUID()
    setReady(false)
    setError(null)
    setDetailsOpen(false)
    setCopied(false)
    setFrameNonce(n => n + 1)
    setReadNonce(n => n + 1)
  }

  const copyError = () => {
    if (!displayError) return
    navigator.clipboard.writeText(displayError)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  const previewUrl = resolvedSessionId
    ? buildHtmlPreviewUrl(chrome.runtime.getURL('src/preview/index.html'), resolvedSessionId, path, network, canvasId)
    : null

  return (
    <div className="relative my-2" style={{ minHeight: 96 }}>
      {displayError && (
        // Reason: the sticky container is kept at the banner's collapsed height
        // and cancels it with -mt on the iframe, so neither the error nor an
        // expanded detail moves the canvas.
        <div className="pointer-events-none sticky top-[calc(var(--chat-top-bar-height,64px)+8px)] z-10 h-[44px]">
          <div
            role="alert"
            className="pointer-events-auto mx-2 mt-[8px] overflow-hidden rounded-lg border border-error/30 shadow-[0_6px_18px_rgba(0,0,0,0.10)] backdrop-blur-[var(--theme-blur)]"
            // Reason: layer an 8% error wash over the near-opaque surface
            // without losing the backdrop blur.
            style={{
              backgroundColor: 'color-mix(in srgb, var(--color-surface-raised) 94%, transparent)',
              backgroundImage: 'linear-gradient(color-mix(in srgb, var(--color-error) 8%, transparent), color-mix(in srgb, var(--color-error) 8%, transparent))',
            }}
          >
            <div className="flex min-h-[34px] items-center gap-1.5 py-1 pl-2.5 pr-1.5 text-[11px]">
              <Icon icon={iconAlertCircleOutline} className="shrink-0 text-xs text-error" />
              <span className="shrink-0 font-medium text-error">渲染出错</span>
              <span className="min-w-0 flex-1 cursor-text truncate text-text-muted select-text" title={errorSummary}>
                {errorSummary}
              </span>
              <button
                type="button"
                onClick={() => setDetailsOpen(open => !open)}
                aria-expanded={detailsOpen}
                className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface hover:text-text-secondary"
              >
                {detailsOpen ? '收起' : '详情'}
              </button>
              {resolvedSessionId && (
                <button
                  type="button"
                  onClick={retry}
                  className="shrink-0 rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-[11px] font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  重试
                </button>
              )}
            </div>
            {detailsOpen && (
              <div className="border-t border-error/20 px-2.5 py-2">
                <p className="cursor-text whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-error select-text">
                  {displayError}
                </p>
                <p className="mt-1 cursor-text break-all font-mono text-[10px] leading-relaxed text-text-muted select-text">
                  Snapshot: {path}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {previewUrl && (
                    <button
                      type="button"
                      onClick={() => chrome.tabs.create({ url: previewUrl })}
                      className="rounded-md border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                    >
                      在新标签打开
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={copyError}
                    className="rounded-md border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    {copied ? '已复制' : '复制错误'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <iframe
        key={`${path}:${frameNonce}`}
        ref={iframeRef}
        src={sandboxUrl}
        sandbox="allow-scripts"
        title={title}
        scrolling="no"
        className={displayError ? '-mt-[44px]' : undefined}
        style={{
          width: '100%',
          height: frameHeight,
          border: 0,
          display: 'block',
          background: 'transparent',
          visibility: height > 0 ? 'visible' : 'hidden',
        }}
      />
      {height <= 0 && (
        <div
          className={`absolute inset-x-0 top-0 flex h-24 items-center justify-center rounded-lg text-[11px] text-text-muted ${
            displayError ? 'bg-surface-raised/20' : 'border border-border-muted/60 bg-surface-raised/30'
          }`}
        >
          {displayError ? null : '正在渲染可视化…'}
        </div>
      )}
    </div>
  )
}
