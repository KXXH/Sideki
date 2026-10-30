import { registerScheduledTasks, captureScheduledTab } from './scheduled-tasks'
import { registerTokenUsage } from './token-usage'
import { handleToolMessage, execScript, type ExecuteScriptFn } from './tool-handlers'
import { createVfsUploadReceiver } from './vfs-upload'
import { pickerScript, pickerGuardScript } from './element-picker'
import { SITE_RULES } from '../shared/site-rules'
import { clearPageDir, deleteShellInstance, listShellFiles, readShellFile, readAllShellFiles, execBash, writeToShellFile, PDF_CHUNK, withSessionLock, mutateShellFs } from './shell'
import { parsePdf } from './pdf-engine'
import { splitMarkdownPages } from '../shared/pdf-anchor'
import { appendNote as appendNoteShell, readNotes as readNotesShell, removeNotes as removeNotesShell, editNote as editNoteShell, type PdfNote } from '../shared/pdf-note-store'

// Reason: the reader tab is a valid host for recreated page commands, and the
// session list is the durable source of truth for mode — mirrors
// tool-handlers' sessionIsPro.
async function sessionIsPro(sessionId: string): Promise<boolean> {
  try {
    const sessions = await loadSessionIndex()
    return (sessions.find(s => s.id === sessionId)?.mode ?? 'chat') === 'pro'
  } catch {
    return false
  }
}

function broadcastNoteChange(sessionId: string): void {
  chrome.runtime.sendMessage({ type: 'pdfnote:changed', sessionId }).catch(() => {
    /* no reader/panel listening */
  })
}
import { debugSession } from './debug-session'
import { startBridge, stopBridge, getBridgeStatus, sendToCC } from './bridge-client'
import { loadConfig, loadSessionIndex, loadSession, saveSession, updateSessionMeta, deleteSession } from '../shared/storage'
import { loadUserSkills } from '../shared/skills'
import { handleMcpMessage } from './mcp-manager'
import { applyCurationPlan, undoCuration } from '../shared/memory-storage'
import { probeAndConnect, handleStorageChange, handleBackupNotify, getBackupStatus, isPaired, discover, pair, unpair, requestRestore, ensureConnected, getSyncState } from './backup-client'
import { resolveOperatingTab, releaseTurn, touchTurn, operatingTabOf, registerTabLockListeners, setPageLockIndicatorPreference } from './tab-locks'
import { OVERLAY_SELECTOR } from '../shared/input'
import { setAiPointerEnabled } from './ai-pointer'
import { syncRequestIdentity } from './dnr'
import { assertPdfVersion, pdfDocumentVersion } from '../shared/pdf-version'
import { shouldNotifyTurn, turnNotificationId, parseTurnNotificationId, turnNotificationText, type TurnDoneMessage } from '../shared/turn-notify'

const handleVfsUpload = createVfsUploadReceiver(writeToShellFile)

async function readPdfSnapshot(sessionId: string, path: string) {
  const content = await readShellFile(sessionId, path)
  if (content === null) throw new Error('PDF file not found')
  const bytes = new Uint8Array(content.length)
  for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i)
  return { content, bytes, documentVersion: await pdfDocumentVersion(bytes) }
}

// Reason: temporary probe — one line per service worker boot, so the console
// can be read as "the worker restarted here" instead of inferred from state.
console.log(`[SW] boot @${new Date().toISOString().slice(11, 23)}`)

registerTabLockListeners()
registerTokenUsage()
loadConfig().then(config => {
  setPageLockIndicatorPreference(config?.pageLockIndicator !== false)
  setAiPointerEnabled(config?.labInputEngine !== false && config?.aiPointer !== false)
}).catch(() => {})

// Reason: LLM request-identity rules are dynamic and persist across restarts,
// but every SW wake is a cheap convergence point — reads config, full-replaces
// the reserved rule segment.
syncRequestIdentity().catch(e => console.warn('[SW] DNR sync failed:', e))

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: 'add-to-sidekick',
    title: '添加到 Sideki 上下文',
    contexts: ['selection'],
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'add-to-sidekick' || !tab?.id) return
  const text = info.selectionText?.trim()
  if (!text) return
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId! })
    await chrome.runtime.sendMessage({ type: 'context:add', text, windowId: tab.windowId })
  } catch { /* sidepanel may already be open */ }
})

loadUserSkills().catch(e => console.warn('[SW] failed to load user skills:', e))

// Backup: startup probe + storage change listener + __backupNotify hook
probeAndConnect().catch(e => console.warn('[SW] backup probe failed:', e))

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') handleStorageChange(changes)
  // Reason: offscreen kernel has no chrome.storage — forward config changes
  // so its craton fingerprint / lab switches stay current.
  if (areaName === 'local' && changes.sidekick_config?.newValue) {
    chrome.runtime.sendMessage({ type: 'env:config-changed', config: changes.sidekick_config.newValue }).catch(() => {})
    // Reason: switching the kernel host back to panel is the user's manual
    // reset lever — drop the offscreen document so the next enable starts
    // from a fresh page instead of reusing a possibly wedged one.
    const next = changes.sidekick_config.newValue as { labKernelHost?: string; pageLockIndicator?: boolean; labInputEngine?: boolean; aiPointer?: boolean }
    const prev = changes.sidekick_config.oldValue as { labKernelHost?: string } | undefined
    setPageLockIndicatorPreference(next.pageLockIndicator !== false)
    setAiPointerEnabled(next.labInputEngine !== false && next.aiPointer !== false)
    // Reason: identity rules derive from profile endpoints — any config edit
    // (endpoints, toggle, UA) may change the rule set.
    syncRequestIdentity().catch(e => console.warn('[SW] DNR sync failed:', e))
    if (prev?.labKernelHost !== 'panel' && next.labKernelHost === 'panel') {
      chrome.offscreen.closeDocument().catch(() => {})
    }
  }
  // Reason: offscreen kernel builds the skill index from its own registry —
  // notify it to reload user skills through the env proxy.
  if (areaName === 'local' && changes.userSkills) {
    chrome.runtime.sendMessage({ type: 'env:user-skills-changed' }).catch(() => {})
  }
})

// --- turn-completion notifications -------------------------------------

// Reason: whether some other app is in front of the browser is observable
// only here — no panel can see it. onFocusChanged fires on the NEXT change, so
// the current value is seeded: a cold SW must answer with the real state
// rather than a default, hence the fallback to the seed for the first turn.
let anyWindowFocused: boolean | null = null
const focusSeed: Promise<boolean> = chrome.windows.getLastFocused()
  .then(w => { anyWindowFocused ??= !!w?.focused; return anyWindowFocused })
  .catch(() => { anyWindowFocused ??= true; return anyWindowFocused })
chrome.windows.onFocusChanged.addListener((windowId) => {
  anyWindowFocused = windowId !== chrome.windows.WINDOW_ID_NONE
})

async function notifyTurnDone(msg: TurnDoneMessage): Promise<void> {
  const cfg = await loadConfig()
  if (cfg?.notifyOnComplete === false) return
  const focused = anyWindowFocused ?? await focusSeed
  if (!shouldNotifyTurn({ foreground: msg.foreground !== false, anyWindowFocused: focused, enabled: true })) return
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
  const text = turnNotificationText({ title: msg.title, snippet: msg.snippet })
  await chrome.notifications.create(turnNotificationId(msg.mode ?? 'chat', win?.id ?? null, msg.sessionId), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: text.title,
    message: text.message,
    priority: 1,
  }).catch(() => {})
}

// Reason: the notification is the only entry point that can land on a session
// nobody is looking at — clicking it must bring back that conversation, not
// just the panel.
chrome.notifications.onClicked.addListener((id) => {
  const target = parseTurnNotificationId(id)
  if (!target) return
  // Reason: sidePanel.open() must be the FIRST async call — the click's
  // gesture token does not survive an await, which is why the window id was
  // baked into the notification id at creation time.
  if (target.windowId != null) chrome.sidePanel.open({ windowId: target.windowId }).catch(() => {})
  // Reason: written before any await — the panel this very call is spinning up
  // reads the key on mount, and it can beat the rest of this handler.
  chrome.storage.session.set({
    pendingPanelSession: { sessionId: target.sessionId, windowId: target.windowId, mode: target.mode },
  }).catch(() => {})
  focusTurnWindow(target).catch(() => {})
  chrome.notifications.clear(id).catch(() => {})
})

async function focusTurnWindow(target: { windowId: number | null; sessionId: string; mode?: string }): Promise<void> {
  if (target.windowId != null) {
    const w = await chrome.windows.get(target.windowId).catch(() => null)
    // Reason: 'focused' alone leaves a minimized window minimized, while an
    // explicit 'normal' would un-maximize a maximized one — restore only what is.
    if (w) {
      await chrome.windows.update(
        target.windowId,
        w.state === 'minimized' ? { focused: true, state: 'normal' } : { focused: true },
      ).catch(() => {})
    }
  }
  // Reason: covers the already-open case; a panel that is only now opening
  // takes the storage key instead, and the window id keeps any other window's
  // panel from following a switch that was not meant for it.
  chrome.runtime.sendMessage({
    type: 'panel:open-session',
    sessionId: target.sessionId,
    windowId: target.windowId,
    mode: target.mode,
  }).catch(() => {})
}

// Reason: offscreen kernel host — global singleton per extension. reason
// WORKERS: hosts the long-running AI agent runtime so turns survive side
// panel closure. getContexts is the reliable existence check (Chrome 116+).
async function pingOffscreen(timeoutMs = 1500): Promise<boolean> {
  try {
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: 'kernel:ping' }),
      new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ])
    return !!(resp as { pong?: boolean } | null)?.pong
  } catch {
    return false
  }
}

// Reason: createDocument resolves before the page's module graph executes —
// pinging a booting document times out and must NOT count as a zombie, or
// the health check kills every document before it finishes loading.
let offscreenBootAt = 0
const OFFSCREEN_BOOT_GRACE_MS = 10_000
let ensureInflight: Promise<{ success: boolean; error?: string }> | null = null

function ensureOffscreen(): Promise<{ success: boolean; error?: string }> {
  // Reason: single-flight — concurrent panel retries must not interleave
  // createDocument/closeDocument on the global singleton.
  ensureInflight ??= ensureOffscreenInner().finally(() => { ensureInflight = null })
  return ensureInflight
}

async function ensureOffscreenInner(): Promise<{ success: boolean; error?: string }> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
    if (contexts.length > 0) {
      if (Date.now() - offscreenBootAt < OFFSCREEN_BOOT_GRACE_MS) return { success: true }
      // Reason: existence ≠ health — a wedged document (crashed module init,
      // dead renderer) still shows up in getContexts. Two ping attempts
      // before declaring it a zombie; a healthy long-lived document answers
      // the first ping immediately.
      if (await pingOffscreen()) return { success: true }
      if (await pingOffscreen()) return { success: true }
      console.warn('[SW] offscreen document unresponsive, rebuilding')
      await chrome.offscreen.closeDocument().catch(() => {})
    }
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/index.html',
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: 'Hosts the long-running AI agent runtime so in-flight turns survive side panel closure',
    })
    offscreenBootAt = Date.now()
    return { success: true }
  } catch (e) {
    // Reason: createDocument races between two panels — "already exists" is success
    if (String(e).includes('single offscreen')) {
      offscreenBootAt = Date.now()
      return { success: true }
    }
    return { success: false, error: String(e) }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).__backupNotify = (category: string, key: string, data: unknown) => {
  handleBackupNotify(category, key, data)
}

// Reason: on SW startup, ensure no residual bridge/debugger when no Pro session exists.
loadSessionIndex().then(sessions => {
  if (!sessions.some(s => (s.mode ?? 'chat') === 'pro')) {
    stopBridge()
    debugSession.detach().catch(() => {})
  }
}).catch(e => console.error('[SW] startup session load failed:', e))

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId })
  }
})

// Reason: _execute_action only fires when the panel is CLOSED. A named command
// fires regardless of panel state, so the shortcut works whether the panel is
// open or not.
// Reason: chrome.commands.onCommand provides user-gesture context, but it
// expires after the first await. sidePanel.open() must be the FIRST async
// call, before any tabs.query().
chrome.commands.onCommand.addListener(async (command, tab) => {
  console.log('[SW] command fired:', command)
  if (command !== 'add-to-context') return
  if (tab?.windowId) await chrome.sidePanel.open({ windowId: tab.windowId })
  if (!tab?.id) return
  try {
    // Reason: allFrames so we capture selections inside iframes (e.g. DingTalk editor).
    // injectImmediately: a never-idle frame must not stall the capture.
    const results = await execScript<string>({
      target: { tabId: tab.id, allFrames: true },
      injectImmediately: true,
      func: () => window.getSelection()?.toString().trim() ?? '',
    })
    const text = results?.map(r => r.result).find(t => t) ?? ''
    if (text) {
      for (let i = 0; i < 5; i++) {
        try { await chrome.runtime.sendMessage({ type: 'context:add', text, windowId: tab.windowId }); break }
        catch { await new Promise(r => setTimeout(r, 300)) }
      }
    }
  } catch { /* chrome:// pages, pdf, etc. */ }
})

// Reason: tracks active iframe drill-down — offset for rect correction,
// frameId for cleanup, tabId for re-injection
let pickerDrill: { tabId: number; frameId: number; offset: { x: number; y: number } } | null = null
let pickerWindowId: number | null = null

function extractRawHtml(overlaySelector: string) {
  // Reason: overlay hosts are real elements in the live tree, so outerHTML
  // serializes them into the page content the model reads. Clone first — removing
  // from the live document would tear down the lock indicator and AI pointer.
  const clone = document.documentElement.cloneNode(true) as HTMLElement
  try {
    for (const node of clone.querySelectorAll(overlaySelector)) node.remove()
  } catch { /* selector unsupported in this document */ }
  return {
    title: document.title,
    url: location.href,
    html: clone.outerHTML,
  }
}

// Reason: for site-rule pages, extract the container innerHTML directly in the
// page context — avoids outerHTML serialization losing Shadow DOM / dynamic content
// Reason: returns a promise — polls up to 3s for the selector to appear because
// SPA pages (DingTalk Docs) render content asynchronously after initial load
async function extractBySelector(selector: string) {
  function deepQuery(root: Document | ShadowRoot | Element, sel: string): Element | null {
    const found = root.querySelector(sel)
    if (found) return found
    const hosts = root.querySelectorAll('*')
    for (const host of hosts) {
      if (host.shadowRoot) {
        const inner = deepQuery(host.shadowRoot, sel)
        if (inner) return inner
      }
    }
    return null
  }

  let el: Element | null = null
  for (let i = 0; i < 15; i++) {
    el = deepQuery(document, selector)
    if (el) break
    console.log(`[extractBySelector] attempt ${i + 1}: not found, waiting 200ms...`)
    await new Promise(r => setTimeout(r, 200))
  }

  if (!el) {
    console.log('[extractBySelector] not found after 3s:', selector,
      'readyState:', document.readyState,
      'body children:', document.body?.children.length)
    return null
  }
  console.log('[extractBySelector] found:', el.tagName, 'innerHTML:', el.innerHTML.length)
  const clone = el.cloneNode(true) as HTMLElement

  // --- Phase 1: remove noise elements ---
  clone.querySelectorAll('script, style, noscript, iframe').forEach(n => n.remove())
  clone.querySelectorAll('[data-testid="cangjie-selection-layer"]').forEach(n => n.remove())
  clone.querySelectorAll('colgroup').forEach(n => n.remove())
  // Reason: spans/divs containing only U+FEFF (zero-width no-break space) are
  // editor placeholders — they produce empty lines that waste tokens
  for (const node of clone.querySelectorAll('span, div')) {
    const text = node.textContent?.replace(/[\uFEFF\u200B ]/g, '').trim()
    if (!text && node.children.length === 0) node.remove()
  }

  // --- Phase 2: resolve relative URLs ---
  const origin = location.origin
  for (const a of clone.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')
    if (href && href.startsWith('/')) a.setAttribute('href', origin + href)
  }

  // --- Phase 3: extract images → numbered placeholders + base64 array ---
  // Reason: 2s timeout caps total wall-clock; skip tiny icons (<32px)
  const imgEls = Array.from(clone.querySelectorAll('img'))
  const images: string[] = []
  const imgPromises = imgEls.map(async (img, idx) => {
    try {
      let src = img.getAttribute('src') || img.getAttribute('data-src') || ''
      if (src.startsWith('/')) src = origin + src
      if (!src || src.startsWith('data:')) { img.replaceWith('[图片]'); return }
      const res = await fetch(src)
      const blob = await res.blob()
      const bitmap = await createImageBitmap(blob)
      let w = bitmap.width, h = bitmap.height
      if (w < 32 || h < 32) { bitmap.close(); img.replaceWith(''); return }
      const maxW = 512
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
      bitmap.close()
      images[idx] = canvas.toDataURL('image/jpeg', 0.5)
      img.replaceWith(`[图片#${idx}]`)
    } catch { img.replaceWith('[图片]') }
  })
  await Promise.race([
    Promise.all(imgPromises),
    new Promise(r => setTimeout(r, 2000)),
  ])

  // --- Phase 4: strip presentational attributes ---
  for (const node of clone.querySelectorAll('*')) {
    const attrs = [...node.attributes]
    for (const attr of attrs) {
      if (attr.name === 'href' || attr.name === 'src' || attr.name === 'alt'
        || attr.name === 'rowspan' || attr.name === 'colspan') continue
      node.removeAttribute(attr.name)
    }
  }

  let html = clone.innerHTML
  // Reason: renumber placeholders against the compacted array — one skipped or
  // failed image would otherwise shift every later [图片 N] out of alignment
  // with the base64 list the model receives
  const validImages: string[] = []
  for (let idx = 0; idx < imgEls.length; idx++) {
    if (!images[idx]) continue
    validImages.push(images[idx])
    html = html.replace(`[图片#${idx}]`, `[图片 ${validImages.length}]`)
  }
  console.log('[extractBySelector] cleaned HTML:', html.length, 'chars, images:', validImages.length)
  return { title: document.title, url: location.href, html, siteRule: true, images: validImages }
}

async function handleExtractContent(tabId: number) {
  try {
    // Check if any site rule matches this tab's URL
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabUrl = tab?.url || ''
    console.log('[SW] extractContent tabId:', tabId, 'tabUrl:', tabUrl?.slice(0, 80))
    const rule = SITE_RULES.find(r => r.match(tabUrl))
    console.log('[SW] site rule match:', !!rule, rule ? `selector: "${rule.selector}"` : '')

    if (rule) {
      try {
        // Reason: SPA editors (DingTalk Docs) load content inside iframes —
        // allFrames searches every frame, we pick the first non-null result.
        // injectImmediately because extractBySelector does its own polling.
        const siteResults = await execScript<{ html: string } | null>({
          target: { tabId, allFrames: true },
          injectImmediately: true,
          func: extractBySelector,
          args: [rule.selector],
          world: 'MAIN',
        })
        const siteData = siteResults?.find((r: { result: unknown }) => r.result)?.result
        console.log('[SW] extractBySelector result:', siteData ? `${siteData.html.length} chars` : 'null',
          'frames searched:', siteResults?.length)
        if (siteData) {
          return { success: true, data: siteData }
        }
      } catch (e) {
        console.error('[SW] extractBySelector failed:', e)
      }
      // Selector not found in live DOM, fall through to full-page extraction
    }

    const results = await execScript<{ title: string; url: string; html: string }>({
      target: { tabId },
      func: extractRawHtml,
      args: [OVERLAY_SELECTOR],
    })
    return { success: true, data: results[0]?.result }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

registerScheduledTasks(ensureOffscreen)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Reason: env proxy for the offscreen kernel — offscreen documents can only
  // use chrome.runtime, so storage/tabs access round-trips through here.
  if (message.type === 'kernel:ensure-offscreen') {
    ensureOffscreen().then(sendResponse)
    return true
  }
  // Reason: data import rewrites storage wholesale, but a live offscreen
  // kernel still holds the pre-import sessions in memory and would checkpoint
  // them back. Tearing the document down makes the restored storage the only
  // remaining truth; the panel reloads into a fresh runtime.
  if (message.type === 'kernel:reset') {
    ;(async () => {
      try {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
        if (contexts.length > 0) await chrome.offscreen.closeDocument()
        offscreenBootAt = 0
        ensureInflight = null
        sendResponse({ success: true })
      } catch (e) {
        sendResponse({ success: false, error: String(e) })
      }
    })()
    return true
  }
  if (message.type === 'turn:done') {
    notifyTurnDone(message as TurnDoneMessage).catch(e => console.warn('[SW] turn notify failed:', e))
    return undefined
  }
  if (message.type === 'env:load-config') {
    loadConfig().then(config => sendResponse({ config })).catch(e => sendResponse({ config: null, error: String(e) }))
    return true
  }
  if (message.type === 'env:load-sessions') {
    loadSessionIndex().then(sessions => sendResponse({ sessions })).catch(e => sendResponse({ sessions: [], error: String(e) }))
    return true
  }
  if (message.type === 'env:load-session') {
    loadSession(message.id).then(session => sendResponse({ session })).catch(e => sendResponse({ session: null, error: String(e) }))
    return true
  }
  if (message.type === 'env:save-session') {
    saveSession(message.session).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'env:update-session-meta') {
    updateSessionMeta(message.id, message.patch).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'env:delete-session') {
    deleteSession(message.id).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'env:remove-history') {
    chrome.storage.local.remove(`history:${message.sessionId}`).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
if (message.type === 'env:history-append') {
    const key = message.key as string
    chrome.storage.local.get(key)
      .then(stored => {
        const list = (stored[key] as unknown[] | undefined) ?? []
        list.push(message.entry)
        return chrome.storage.local.set({ [key]: list })
      })
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'env:get-user-skills') {
    chrome.storage.local.get('userSkills').then(data => sendResponse({ userSkills: data.userSkills ?? {} })).catch(() => sendResponse({ userSkills: {} }))
    return true
  }
  if (message.type === 'env:active-tab') {
    // Reason: with anchorTabId the caller wants "the active tab in the
    // anchor's window" — session tab contexts follow task navigation (new
    // tabs opened by clicks) without leaking across windows. A closed
    // anchor falls back to the focused window's active tab.
    ;(async () => {
      const anchor = message.anchorTabId as number | undefined
      if (anchor != null) {
        try {
          const t = await chrome.tabs.get(anchor)
          const [active] = await chrome.tabs.query({ active: true, windowId: t.windowId })
          return active?.id ?? anchor
        } catch { /* anchor tab closed */ }
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      return tab?.id ?? null
    })().then(tabId => sendResponse({ tabId })).catch(() => sendResponse({ tabId: null }))
    return true
  }
  if (message.type === 'extract-content') {
    handleExtractContent(message.tabId).then(sendResponse)
    return true
  }
  if (message.type === 'picker:start') {
    chrome.tabs.get(message.tabId).then(t => { pickerWindowId = t.windowId ?? null }).catch(() => {})
    chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      func: pickerScript,
    }).then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'picker:result' && sender.tab) {
    const rect = { ...message.rect as { x: number; y: number; width: number; height: number } }
    if (pickerDrill) {
      // Reason: iframe picker returns rect relative to iframe viewport —
      // offset to top-level viewport so screenshot cropping is correct
      rect.x += pickerDrill.offset.x
      rect.y += pickerDrill.offset.y
      // Clean up guard overlay in parent frame
      const tabId = pickerDrill.tabId
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.querySelectorAll('[data-sidekick-picker="guard"]').forEach(e => e.remove()),
      }).catch(() => {})
      pickerDrill = null
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId!, { format: 'jpeg', quality: 85 })
      .then(screenshotDataUrl => {
        chrome.runtime.sendMessage({
          type: 'picker:done',
          rect,
          domSnapshot: message.domSnapshot,
          label: message.label,
          devicePixelRatio: message.devicePixelRatio,
          screenshotDataUrl,
          windowId: sender.tab!.windowId,
        })
      })
      .catch(() => {
        chrome.runtime.sendMessage({ type: 'picker:error', error: 'Failed to capture screenshot', windowId: pickerWindowId })
      })
    return false
  }
  if (message.type === 'picker:cancel') {
    if (pickerDrill) {
      const { tabId, frameId } = pickerDrill
      // Clean up both iframe picker and parent guard
      Promise.all([
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: () => document.querySelectorAll('[data-sidekick-picker]').forEach(e => e.remove()),
        }),
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.querySelectorAll('[data-sidekick-picker="guard"]').forEach(e => e.remove()),
        }),
      ]).catch(() => {})
      pickerDrill = null
    }
    chrome.runtime.sendMessage({ type: 'picker:cancelled', windowId: pickerWindowId })
    return false
  }
  if (message.type === 'picker:drill' && sender.tab?.id) {
    const tabId = sender.tab.id
    const iframeSrc = message.iframeSrc as string
    const iframeRect = message.iframeRect as { x: number; y: number; width: number; height: number }
    ;(async () => {
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId })
        if (!frames?.length) throw new Error('Could not enumerate frames')
        let frameId: number | null = null
        if (iframeSrc) {
          const exact = frames.find(f => f.url === iframeSrc)
          if (exact) {
            frameId = exact.frameId
          } else {
            try {
              const pathname = new URL(iframeSrc).pathname
              const partial = frames.find(f => f.url.includes(pathname))
              if (partial) frameId = partial.frameId
            } catch { /* non-HTTP src */ }
          }
        }
        if (frameId === null) {
          const children = frames.filter(f => f.parentFrameId === 0 && f.frameId !== 0)
          if (children.length === 1) frameId = children[0].frameId
        }
        if (frameId === null) {
          chrome.runtime.sendMessage({ type: 'picker:error', error: 'Cannot find iframe frame', windowId: pickerWindowId })
          return
        }
        pickerDrill = { tabId, frameId, offset: { x: iframeRect.x, y: iframeRect.y } }
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: pickerScript,
        })
        // Inject guard overlay in parent frame (click outside iframe → go back)
        await (chrome.scripting.executeScript as unknown as ExecuteScriptFn)({
          target: { tabId },
          func: pickerGuardScript,
          args: [iframeRect],
        })
      } catch (e) {
        pickerDrill = null
        chrome.runtime.sendMessage({ type: 'picker:error', error: String(e), windowId: pickerWindowId })
      }
    })()
    return false
  }
  if (message.type === 'picker:back' && pickerDrill) {
    const { tabId, frameId } = pickerDrill
    pickerDrill = null
    ;(async () => {
      try {
        // Clean up iframe picker
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: () => document.querySelectorAll('[data-sidekick-picker]').forEach(e => e.remove()),
        })
        // Re-inject picker into parent frame
        await chrome.scripting.executeScript({
          target: { tabId },
          func: pickerScript,
        })
      } catch (e) {
        chrome.runtime.sendMessage({ type: 'picker:error', error: String(e), windowId: pickerWindowId })
      }
    })()
    return false
  }
  if (message.type === 'shell:clear-page') {
    clearPageDir(message.sessionId)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'shell:delete') {
    deleteShellInstance(message.sessionId)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'dev:ls') {
    listShellFiles(message.sessionId).then(files => {
      if (files === null) {
        sendResponse({ success: false, error: 'Session not found' })
      } else {
        sendResponse({ success: true, files })
      }
    }).catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'dev:cat') {
    readShellFile(message.sessionId, message.path).then(content => {
      if (content === null) {
        sendResponse({ success: false, error: 'File not found or session not found' })
      } else {
        sendResponse({ success: true, content })
      }
    }).catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'pdfbytes:read') {
    const { sessionId, path, offset, length, expectedVersion } = message as { sessionId: string; path: string; offset: number; length: number; expectedVersion?: string }
    withSessionLock(sessionId, async () => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > PDF_CHUNK) {
        throw new Error('Invalid PDF byte range')
      }
      const snapshot = await readPdfSnapshot(sessionId, path)
      if (offset > 0 || expectedVersion !== undefined) assertPdfVersion(expectedVersion, snapshot.documentVersion)
      if (offset > snapshot.content.length) throw new Error('PDF byte offset is out of range')
      return { chunk: snapshot.content.slice(offset, offset + length), size: snapshot.content.length, documentVersion: snapshot.documentVersion }
    })
      .then(result => sendResponse({ success: true, ...result }))
      .catch(e => sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type === 'pdfmd:page') {
    const { sessionId, path, page, expectedVersion } = message as { sessionId: string; path: string; page: number; expectedVersion: string }
    withSessionLock(sessionId, async () => {
      const snapshot = await readPdfSnapshot(sessionId, path)
      assertPdfVersion(expectedVersion, snapshot.documentVersion)
      const result = await parsePdf(snapshot.bytes, [page], { includePageMarkers: true })
      const md = result.markdown ?? ''
      return splitMarkdownPages(md).get(page) ?? md
    })
      .then(markdown => sendResponse({ success: true, markdown }))
      .catch(e => sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type === 'pdfnote:read') {
    withSessionLock(message.sessionId, async () => {
      const snapshot = await readPdfSnapshot(message.sessionId, message.path)
      assertPdfVersion(message.expectedVersion, snapshot.documentVersion)
      return await readShellFile(message.sessionId, `${message.path}.notes.jsonl`) ?? ''
    })
      .then(content => sendResponse({ success: true, content }))
      .catch(e => sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type === 'pdfnote:append' || message.type === 'pdfnote:remove' || message.type === 'pdfnote:edit') {
    const { sessionId, path, expectedVersion } = message as { sessionId: string; path: string; expectedVersion: string }
    const hostTabId = sender.tab?.id ?? -1
    withSessionLock(sessionId, async () => {
      const result = await mutateShellFs(sessionId, hostTabId, await sessionIsPro(sessionId), async fs => {
        const documentVersion = await pdfDocumentVersion(await fs.readFileBuffer(path))
        assertPdfVersion(expectedVersion, documentVersion)
        if (message.type === 'pdfnote:append') {
          const note = (message as { note: Omit<PdfNote, 'id' | 'ts'> }).note
          return appendNoteShell(fs, path, { ...note, documentVersion })
        }
        const ids: string[] = message.type === 'pdfnote:remove' ? message.ids : [message.id]
        for (const note of await readNotesShell(fs, path)) {
          if (ids.includes(note.id)) assertPdfVersion(note.documentVersion, documentVersion)
        }
        if (message.type === 'pdfnote:remove') return removeNotesShell(fs, path, ids)
        return editNoteShell(fs, path, message.id, message.note)
      })
      broadcastNoteChange(sessionId)
      return result
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(e => sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type === 'pdfdoc:open-reader') {
    const { sessionId, path } = message as { sessionId: string; path: string }
    const url = `${chrome.runtime.getURL('src/reader/index.html')}?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(path)}&page=1`
    chrome.tabs.create({ url, active: true })
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'dev:exec') {
    execBash(message.sessionId, message.tabId, message.command).then(result => {
      sendResponse({ success: true, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode })
    }).catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'bridge:send') {
    const sent = sendToCC(message.text ?? '')
    sendResponse({ sent })
    return false
  }
  if (message.type === 'pro:attach') {
    debugSession.attach(message.tabId)
      .then(() => { startBridge(); sendResponse({ success: true }) })
      .catch(e => sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type === 'pro:detach') {
    stopBridge()
    debugSession.detach()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type === 'pro:status') {
    sendResponse({ ...debugSession.getStatus(), bridge: getBridgeStatus() })
    return false
  }
  if (message.type === 'pro:toggle') {
    const { feature } = message as { feature: 'console' | 'network' }
    ;(async () => {
      try {
        // Reason: auto-attach if needed — same pattern as debug-commands.ts
        if (!debugSession.isAttached()) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          if (tab?.id) await debugSession.attach(tab.id)
        }
        if (feature === 'console') {
          if (debugSession.getStatus().consoleListening) debugSession.stopConsoleCapture()
          else await debugSession.startConsoleCapture()
        } else if (feature === 'network') {
          if (debugSession.getStatus().networkListening) await debugSession.stopNetworkCapture()
          else await debugSession.startNetworkCapture()
        }
        sendResponse({ success: true, ...debugSession.getStatus(), bridge: getBridgeStatus() })
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return true
  }
  if (message.type === 'vfs:readDir') {
    const { sessionId } = message as { sessionId: string }
    readAllShellFiles(sessionId)
      .then(files => sendResponse({ success: true, files: files ?? {} }))
      .catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'vfs:upload-start' || message.type === 'vfs:upload-chunk' || message.type === 'vfs:upload-abort') {
    handleVfsUpload(message)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type === 'vfs:write') {
    const { sessionId, path, content } = message as { sessionId: string; path: string; content: string }
    writeToShellFile(sessionId, path, content)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: String(e) }))
    return true
  }
  if (message.type === 'memory:apply-curation') {
    // Reason: apply runs in the SW so closing the side panel mid-apply cannot
    // interrupt the write sequence (promote first, then evict notes).
    applyCurationPlan(message.plan)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (message.type === 'memory:undo-curation') {
    undoCuration()
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (message.type === 'backup:status') {
    sendResponse({ status: getBackupStatus(), paired: isPaired(), sync: getSyncState() })
    return false
  }
  if (message.type === 'backup:connect') {
    ensureConnected(3000).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: String(e) }))
    return true
  }
  if (message.type === 'backup:discover') {
    discover().then(sendResponse).catch(e => sendResponse({ error: String(e) }))
    return true
  }
  if (message.type === 'backup:pair') {
    pair().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: String(e) }))
    return true
  }
  if (message.type === 'backup:unpair') {
    unpair().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: String(e) }))
    return true
  }
  if (message.type === 'backup:restore') {
    requestRestore().then(sendResponse).catch(e => sendResponse({ error: String(e) }))
    return true
  }
  if (message.type?.startsWith('mcp:')) {
    handleMcpMessage(message.type, message, message.tabId)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e instanceof Error ? e.message : String(e) }))
    return true
  }
  if (message.type?.startsWith('tool:')) {
    handleToolMessage(message.type, message.tabId, message.params ?? {}).then(sendResponse)
    return true
  }
  // Reason: the turn's operating tab — resolved from the session's own tab
  // stack, not from whichever tab happens to be active. Doubles as the lazy
  // lock acquisition point (see tab-locks).
  if (message.type === 'env:operating-tab') {
    (async () => {
      if (message.strict) {
        const target = operatingTabOf(message.sessionId) ?? message.anchorTabId
        if (target == null) throw new Error('目标页面不存在')
        await chrome.tabs.get(target)
      }
      return resolveOperatingTab(message.sessionId, message.anchorTabId ?? null, !!message.pinned)
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ tabId: null }))
    return true
  }
  if (message.type === 'tab-lock:release') {
    captureScheduledTab(message.sessionId)
    releaseTurn(message.sessionId)
    sendResponse({ ok: true })
    return undefined
  }
  // Reason: turn-alive heartbeat — a turn spending minutes in reasoning or MCP
  // calls touches no tab, and must not lose its lock (or its stack) to the
  // staleness backstop.
  if (message.type === 'tab-lock:touch') {
    touchTurn(message.sessionId)
    sendResponse({ ok: true })
    return undefined
  }
  // Reason: a panel opening or switching to a session mid-turn missed the
  // tab-lock:changed broadcast — let it pull the current operating tab so its
  // page strip shows the page the context actually points at.
  if (message.type === 'tab-lock:query') {
    sendResponse({ tabId: operatingTabOf(message.sessionId) })
    return undefined
  }
})

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    await chrome.runtime.sendMessage({ type: 'tab-changed', tabId: activeInfo.tabId, windowId: activeInfo.windowId })
  } catch {
    // Reason: side panel may not be open, ignore connection errors
  }
})

// Reason: SPA pages may change URL or title without triggering webNavigation events.
// tabs.onUpdated fires whenever Chrome detects a property change on the tab.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title) return
  console.log('[SW] tabs.onUpdated', tabId, 'url:', changeInfo.url?.slice(0, 60), 'title:', changeInfo.title?.slice(0, 40))
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (activeTab?.id === tabId) {
      await chrome.runtime.sendMessage({ type: 'tab-changed', tabId, windowId: tab.windowId })
      console.log('[SW] sent tab-changed via onUpdated')
    }
  } catch { /* side panel not open */ }
})

