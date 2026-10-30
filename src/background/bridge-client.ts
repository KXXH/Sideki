const BRIDGE_URL = 'ws://127.0.0.1:9111/ws'
const ALARM_NAME = 'bridge-reconnect'

let ws: WebSocket | null = null
let active = false

export type BridgeStatus = 'connected' | 'connecting' | 'disconnected'

const listeners = new Set<(status: BridgeStatus) => void>()

export function onBridgeStatusChange(cb: (status: BridgeStatus) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function notifyStatus(status: BridgeStatus) {
  for (const cb of listeners) cb(status)
}

export function getBridgeStatus(): BridgeStatus {
  if (ws?.readyState === WebSocket.OPEN) return 'connected'
  if (ws?.readyState === WebSocket.CONNECTING) return 'connecting'
  return 'disconnected'
}

export function startBridge() {
  if (active) return
  console.log('[bridge] starting')
  active = true
  connect()
  // Reason: chrome.alarms survives service worker suspension, setTimeout does not
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.1 })
}

export function stopBridge() {
  console.log('[bridge] stopping')
  active = false
  chrome.alarms.clear(ALARM_NAME)
  if (ws) { ws.close(1000, 'Pro mode disabled'); ws = null }
  notifyStatus('disconnected')
}

// Reason: send AI response back to CC via bridge
export function sendToCC(text: string): boolean {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'response', text }))
    return true
  }
  return false
}

// Reason: alarm fires every 6s even if service worker was suspended — check and reconnect
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  if (!active) { chrome.alarms.clear(ALARM_NAME); return }
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connect()
  }
})

function connect() {
  if (!active) return
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
  notifyStatus('connecting')

  try {
    ws = new WebSocket(BRIDGE_URL)
  } catch {
    console.warn('[bridge] WebSocket constructor failed')
    ws = null
    return
  }

  ws.onopen = () => {
    console.log('[bridge] connected')
    notifyStatus('connected')
  }

  ws.onmessage = (event) => {
    if (!active) return
    const raw = event.data as string
    // Reason: bridge /cmd sends JSON {"text":"..."}, extract the text field
    let text = raw
    try { const parsed = JSON.parse(raw); if (parsed.text) text = parsed.text } catch { /* plain string, use as-is */ }
    chrome.runtime.sendMessage({ type: 'bridge:message', text }).catch(() => {})
  }

  ws.onclose = () => {
    console.log('[bridge] disconnected')
    ws = null
    notifyStatus('disconnected')
  }

  ws.onerror = () => {
    console.warn('[bridge] WebSocket error')
    ws?.close()
  }
}
