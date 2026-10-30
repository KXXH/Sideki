import { readHtmlArtifactTheme } from './html-artifact-theme'
import { validateHtmlArtifact } from './html-artifact'

export type VizProbeStatus = 'ok' | 'error' | 'timeout' | 'unavailable'

export interface VizProbeResult {
  status: VizProbeStatus
  error?: string
  height?: number
}

export interface VizProbeRequest {
  sessionId: string
  path: string
  network: boolean
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4000
const READY_TIMEOUT_MS = 2000
const RENDER_GRACE_MS = 250
// Reason: a hidden frame needs a plausible viewport; vh-based layouts and
// sticky positioning otherwise render differently from the chat column.
const PROBE_WIDTH = 640
const PROBE_HEIGHT = 800

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

// Reason: the agent may run in a DOM-capable host (side panel) or in the
// offscreen kernel. Only the former can run the probe in place; the latter
// delegates over runtime messaging.
export function canProbeInThisDocument(): boolean {
  if (typeof document === 'undefined') return false
  // Reason: the offscreen kernel is a DOM document but has no visible layout;
  // rAF-driven measurement and painting do not behave like the side panel.
  if (typeof location !== 'undefined' && location.pathname.includes('/src/offscreen/')) return false
  return true
}

export async function probeVisualization(req: VizProbeRequest): Promise<VizProbeResult> {
  const read = await chrome.runtime.sendMessage({
    type: 'dev:cat',
    sessionId: req.sessionId,
    path: req.path,
  }) as { success?: boolean; content?: string; error?: string } | undefined
  if (!read?.success || typeof read.content !== 'string') {
    return { status: 'error', error: read?.error ?? `Could not read ${req.path} for the render check.` }
  }
  const html = read.content
  try { validateHtmlArtifact(html, { network: req.network }) } catch (error) {
    return { status: 'error', error: errorMessage(error) }
  }

  const timeoutMs = Math.max(1500, Math.min(10_000, req.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const id = crypto.randomUUID()

  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${PROBE_WIDTH}px;height:${PROBE_HEIGHT}px;overflow:hidden;pointer-events:none;opacity:0;z-index:-1`
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.style.cssText = `width:${PROBE_WIDTH}px;height:${PROBE_HEIGHT}px;border:0;display:block`
  host.appendChild(frame)
  document.body.appendChild(host)

  return await new Promise<VizProbeResult>((resolve) => {
    let settled = false
    let sawRendered = false
    let height: number | undefined
    let readyTimer = 0
    let deadlineTimer = 0
    let graceTimer = 0

    const cleanup = () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(readyTimer)
      clearTimeout(deadlineTimer)
      clearTimeout(graceTimer)
      host.remove()
    }
    const finish = (result: VizProbeResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      const data = event.data as { type?: string; id?: string; message?: string; height?: number } | undefined
      if (!data || typeof data.type !== 'string') return

      if (data.type === 'viz:ready') {
        clearTimeout(readyTimer)
        frame.contentWindow?.postMessage({ type: 'viz:render', id, html, theme: readHtmlArtifactTheme() }, '*')
        return
      }
      if (data.id !== id) return

      if (data.type === 'viz:error') {
        finish({ status: 'error', error: typeof data.message === 'string' && data.message ? data.message : 'Render failed.' })
      } else if (data.type === 'viz:resize') {
        if (typeof data.height === 'number' && Number.isFinite(data.height)) height = Math.max(0, Math.ceil(data.height))
      } else if (data.type === 'viz:rendered') {
        sawRendered = true
        // Reason: keep a short window for an immediate error or the first height
        // sample; the probe must not add a full timeout to successful renders.
        graceTimer = window.setTimeout(() => finish({ status: 'ok', height }), RENDER_GRACE_MS)
      }
    }

    window.addEventListener('message', onMessage)
    readyTimer = window.setTimeout(() => {
      finish({ status: 'timeout', error: 'The sandbox frame did not become ready in time.' })
    }, Math.min(READY_TIMEOUT_MS, timeoutMs))
    deadlineTimer = window.setTimeout(() => {
      finish({
        status: 'timeout',
        error: sawRendered ? 'The render report was incomplete.' : `The visualization did not finish rendering within ${timeoutMs}ms.`,
      })
    }, timeoutMs)

    frame.src = chrome.runtime.getURL(req.network ? 'src/viz/sandbox-online.html' : 'src/viz/sandbox.html')
  })
}

export function requestProbeFromUi(req: VizProbeRequest): Promise<VizProbeResult> {
  const timeoutMs = Math.max(1500, Math.min(10_000, req.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  return new Promise<VizProbeResult>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ status: 'unavailable', error: 'The side panel did not report a render result in time.' })
    }, timeoutMs + 1000)
    chrome.runtime.sendMessage({ type: 'viz:probe', ...req, timeoutMs })
      .then((resp: { ok?: boolean; result?: VizProbeResult; error?: string } | undefined) => {
        clearTimeout(timer)
        if (resp?.ok && resp.result) resolve(resp.result)
        else resolve({ status: 'unavailable', error: resp?.error ?? 'No side panel is available for the render check.' })
      })
      .catch((e: unknown) => {
        clearTimeout(timer)
        resolve({ status: 'unavailable', error: errorMessage(e) })
      })
  })
}
