import { probeVisualization } from '../shared/viz-probe'

// Reason: the offscreen kernel has no renderer for the probe, so it asks the
// side panel to run the same hidden-frame check it would run locally.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'viz:probe') return
  const { sessionId, path, network, timeoutMs } = message as {
    sessionId?: unknown
    path?: unknown
    network?: unknown
    timeoutMs?: unknown
  }
  if (typeof sessionId !== 'string' || typeof path !== 'string') {
    sendResponse({ ok: false, error: 'Invalid render check request.' })
    return false
  }
  probeVisualization({
    sessionId,
    path,
    network: network === true,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
  })
    .then(result => sendResponse({ ok: true, result }))
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  return true
})
