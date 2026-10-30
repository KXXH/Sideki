import type { TimerWake } from '../shared/scheduled-task'
import { canvasRequest } from '../shared/canvas-client'
import { parsePageContent } from '../shared/parser'
import { loadUserSkills } from '../shared/skills'
import { buildOrogenLines } from '../shared/agent'
import { KernelPool } from '../shared/kernel/kernel-pool'
import { KernelMux } from '../shared/kernel/kernel-mux'
import { KernelSyncHost } from '../shared/kernel/kernel-host'
import { wireTurnAutomation } from '../shared/kernel/turn-automation'
import type { KernelEnv, SessionRuntime } from '../shared/kernel/kernel-runtime'
import type { ApiConfig, ChatSession, PageContent, ElementAttachment, PermissionMode } from '../shared/types'
import type { SkillPartData } from '../shared/message-protocol'

// Reason: temporary probe — marks each offscreen document creation, so the
// console shows whether the kernel host itself was rebuilt between sessions.
console.log(`[kernel] offscreen boot @${new Date().toISOString().slice(11, 23)}`)

// Reason: liveness probe — the SW's ensureOffscreen pings before trusting an
// existing document. Registered first so even a partially-initialized page
// answers; a page whose module init crashed never registers and gets rebuilt.
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse): undefined => {
  if (msg?.type === 'kernel:ping') sendResponse({ pong: true })
  return undefined
})

// Reason: offscreen documents only get chrome.runtime — every other chrome
// API (storage, tabs, scripting) is proxied through the service worker via
// env:* messages. Network (fetch) works directly, so LLM calls stay local.
const env: KernelEnv = {
  loadConfig: async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'env:load-config' })
    return (resp?.config ?? null) as ApiConfig | null
  },
  onConfigChanged: (cb) => {
    const listener = (msg: { type?: string; config?: ApiConfig }): undefined => {
      if (msg?.type === 'env:config-changed' && msg.config) cb(msg.config)
      return undefined
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  },
  loadSessions: async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'env:load-sessions' })
    if (resp?.error) throw new Error(resp.error)
    return (resp?.sessions ?? []) as ChatSession[]
  },
  loadSession: async (id) => {
    const resp = await chrome.runtime.sendMessage({ type: 'env:load-session', id })
    if (resp?.error) throw new Error(resp.error)
    return (resp?.session ?? null) as ChatSession | null
  },
  saveSession: async (session) => {
    const resp = await chrome.runtime.sendMessage({ type: 'env:save-session', session })
    if (!resp?.success) throw new Error(resp?.error ?? 'Failed to save session')
  },
  updateSessionMeta: async (id, patch) => {
    const resp = await chrome.runtime.sendMessage({ type: 'env:update-session-meta', id, patch })
    if (!resp?.success) throw new Error(resp?.error ?? 'Failed to update session')
  },
  deleteSession: async (id) => {
    const resp = await chrome.runtime.sendMessage({ type: 'env:delete-session', id })
    if (!resp?.success) throw new Error(resp?.error ?? 'Failed to delete session')
  },
  removeHistory: async (sessionId) => {
    await chrome.runtime.sendMessage({ type: 'env:remove-history', sessionId })
  },
  sendMessage: (msg) => chrome.runtime.sendMessage(msg),
  // Reason: panel presence is a port-binding property, so the mux (declared
  // below, only ever reached after init) is the single source for it.
  isSessionForeground: (sessionId) => mux.hasVisiblePanelFor(sessionId),
}

// Reason: user skills live in chrome.storage (SW side) — load through the
// env proxy so every kernel's skill index matches the panel's, and follow
// SW-forwarded change notifications.
loadUserSkills().catch(e => console.warn('[offscreen] user skills load failed:', e))
chrome.runtime.onMessage.addListener((msg: { type?: string }): undefined => {
  if (msg?.type === 'env:user-skills-changed') {
    loadUserSkills().catch(e => console.warn('[offscreen] user skills reload failed:', e))
  }
  return undefined
})

// Reason: automation subscriptions belong to the runtime's lifetime — a
// deleted session's runtime must stop checkpointing before dispose(), or its
// next save resurrects the storage record the user just removed.
const turnAutomation = new Map<string, () => void>()

const pool = new KernelPool(env, {
  extractContent: async (_sessionId, tabId): Promise<PageContent> => {
    let target = tabId
    if (target == null) {
      const t = await chrome.runtime.sendMessage({ type: 'env:active-tab' })
      target = t?.tabId ?? null
    }
    if (target == null) throw new Error('No active tab found')
    const resp = await chrome.runtime.sendMessage({ type: 'extract-content', tabId: target })
    if (!resp?.success) throw new Error(resp?.error ?? 'Failed to extract page content')
    return parsePageContent(resp.data)
  },
  onRuntimeCreated: (rt: SessionRuntime) => {
    turnAutomation.get(rt.sessionId)?.()
    turnAutomation.set(rt.sessionId, wireTurnAutomation(rt, () => pool.config))
  },
  onRuntimeEvicted: (sessionId) => {
    turnAutomation.get(sessionId)?.()
    turnAutomation.delete(sessionId)
  },
})

interface PageCtxArgs {
  pageInfo?: { title: string; url: string } | null
  tabId?: number | null
}

type SendArgs = PageCtxArgs & {
  text: string
  attachments?: ElementAttachment[]
  opts?: { skill?: SkillPartData; fromBridge?: boolean; page?: { title: string; url: string } }
  debugStatus?: unknown
}

// Reason: session commands close over their runtime — the mux routes each
// port's commands to the host of its bound session, so page context and
// debug status always land on the right conversation.
function createHost(rt: SessionRuntime): KernelSyncHost {
  const acceptPageCtx = (args: PageCtxArgs | undefined) => {
    if (!args) return
    const patch: PageCtxArgs = {}
    if (args.pageInfo !== undefined) patch.pageInfo = args.pageInfo
    if (args.tabId !== undefined) patch.tabId = args.tabId
    if (Object.keys(patch).length > 0) pool.updatePageCtx(rt.sessionId, patch)
  }
  const mode = rt.session.mode ?? 'chat'
  return new KernelSyncHost(rt.kernel, {
    extras: () => ({
      // Reason: session list without message bodies — the panel's session bar
      // only needs metadata; full messages travel via the message patch stream.
      sessions: pool.sessions
        .filter(s => (s.mode ?? 'chat') === mode)
        .map(s => ({
          id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
          pageUrl: s.pageUrl, mode: s.mode ?? 'chat',
          permissionMode: s.permissionMode,
          // Reason: list entries may be metadata-only (stripped bodies) —
          // surface the real count so the panel's empty-session filter works.
          messageCount: s.messageCount ?? s.messages?.length ?? 0,
        })),
      activeId: rt.sessionId,
      lastTurnTokens: rt.lastTurnTokens,
      approvalState: rt.approvals.state,
      // Reason: extraction happens kernel-side on send — the panel's local
      // contextLoaded flag never flips in mirror mode, so the indicator would
      // stay on "load ctx" forever without this kernel-truth signal.
      contextLoaded: rt.pageContextRef.current != null,
      contextWindow: pool.config?.contextWindow ?? 0,
      modelName: pool.config?.model ?? '',
      config: pool.config,
    }),
    commands: {
      'send': (args) => {
        const a = args as SendArgs
        acceptPageCtx(a)
        // Reason: debug status is observed panel-side (DebugToolbar) — latest
        // value rides along with each send for orogen injection.
        if (a.debugStatus !== undefined) rt.debugStatusRef.current = a.debugStatus as typeof rt.debugStatusRef.current
        // Reason: mirror mode captures page provenance panel-side and ships it
        // with the send — pin it onto the item so a queued flush keeps the page
        // the user actually asked from.
        const opts = { ...a.opts, page: a.opts?.page ?? a.pageInfo ?? undefined }
        rt.kernel.handleSend(a.text, a.attachments, opts).catch(e => { if (e?.name !== 'AbortError') rt.kstate.error = e instanceof Error ? e : new Error(String(e)) })
      },
      'page-context': (args) => {
        const a = args as PageCtxArgs & { content: PageContent | null }
        acceptPageCtx(a)
        // Reason: storing content is all this does now — the craton that reads
        // it is built on the first send, so a manual load neither blocks nor
        // spends a build on a session the user may not send in.
        rt.offerPageContext(a.content)
      },
      'stop': () => { rt.stop().catch(() => {}) },
      'set-permission-mode': (args) => { void rt.setPermissionMode((args as { mode: PermissionMode }).mode).catch(error => console.error('[permissions] save failed', error)) },
      'clear-error': () => { rt.chat.clearError() },
      'remove-queued': (args) => { rt.kernel.removeQueued((args as { id: string }).id) },
      'clear-queue': () => { rt.kernel.clearQueue() },
      'regenerate': (args) => { rt.regenerate((args as { messageId: string }).messageId) },
      'inject-message': (args) => {
        const a = args as { role: 'user' | 'assistant'; text: string; metadata?: Record<string, unknown> }
        rt.injectMessage(a.role, a.text, a.metadata)
      },
      'compact-now': () => { rt.kernel.compactNow().catch(() => {}) },
      'flush-save': () => { rt.flushSave() },
    },
    requests: {
      'approval-debug': () => rt.approvals.getDebugSnapshot(),
      'approval-debug-clear': () => { rt.approvals.clearDebugHistory(); return { success: true } },
      'approval-debug-test': async (args) => { await rt.approvals.testApproval((args as { command: string }).command); return { success: true } },
      'set-permission-mode': async (args) => { await rt.setPermissionMode((args as { mode: PermissionMode }).mode); return { success: true } },
      // Reason: the Dev inspector needs the frozen craton for this exact
      // session runtime. Full page prompts are too large for 80ms extras.
      'session-inspector': () => ({
        craton: rt.craton,
        orogenLines: buildOrogenLines(
          rt.pageContextRef.current,
          rt.debugStatusRef.current,
          (rt.session.mode ?? 'chat') === 'pro',
        ),
      }),
    },
  })
}

const mux = new KernelMux(pool, { createHost })
let schedulerReady = false
void mux.start().then(async () => {
  await chrome.runtime.sendMessage({ type: 'schedule:host-start' })
  schedulerReady = true
}).catch(e => console.error('[offscreen] pool init failed:', e))

const scheduledSessions = new Set<string>()
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== 'canvas:enqueue-offscreen') return undefined
  void (async () => {
    if (!schedulerReady) throw new Error('后台执行环境正在准备，请稍后重试')
    await pool.refreshSessions()
    const rt = await pool.retain(msg.sessionId)
    if (!rt) throw new Error('来源会话不存在')
    try {
      const valid = await canvasRequest<boolean>(m => chrome.runtime.sendMessage(m), 'validate-target', { sessionId: rt.sessionId, tabId: rt.canvasTargetTabId })
      if (!valid) throw new Error('请打开来源会话并恢复执行页面绑定后重试')
      const run = rt.kernel.handleSend(msg.prompt, undefined, { canvasSource: { canvasId: msg.canvasId, title: msg.title, tabId: rt.canvasTargetTabId! } })
      void run.catch(error => { if (error?.name !== 'AbortError') rt.kstate.error = error instanceof Error ? error : new Error(String(error)) })
      const messageId = await rt.kernel.whenAccepted()
      respond({ accepted: true, messageId })
      // Reason: retain the runtime until the accepted send settles, including time in its queue.
      void run.finally(() => pool.release(rt.sessionId)).catch(() => {})
    } catch (error) { pool.release(rt.sessionId); throw error }
  })().catch(error => respond({ accepted: false, error: String(error) }))
  return true
})
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type !== 'schedule:wake') return undefined
  if (!schedulerReady || scheduledSessions.has(msg.sessionId)) {
    respond({ accepted: false, reason: '等待后台运行就绪' })
    return undefined
  }
  scheduledSessions.add(msg.sessionId)
  void (async () => {
    let retained = false
    let heldRuntime: SessionRuntime | null = null
    try {
      await pool.refreshSessions()
      const rt = await pool.retain(msg.sessionId)
      if (!rt) { respond({ accepted: false, reason: '会话不存在' }); return }
      retained = true
      const k = rt.kernel
      if (k.kstate.status !== 'ready' || k.compacting || k.preparing || k.dispatching || k.queue.length) {
        respond({ accepted: false, reason: k.kstate.status === 'error' ? '等待处理会话错误' : '等待当前会话空闲' })
        return
      }
      const wake = msg.wake as TimerWake
      // Reason: handleSend claims dispatch synchronously, before acknowledging the scheduler.
      const before = rt.kstate.messages.length
      const run = k.handleSend(msg.instruction, undefined, { timer: wake, page: { title: wake.pageTitle, url: wake.pageUrl } })
      k.holdScheduleBoundary(true)
      heldRuntime = rt
      respond({ accepted: true })
      await run
      rt.flushSave()
      const newMessages = rt.kstate.messages.slice(before)
      const answered = newMessages.some(m => m.role === 'assistant')
      await chrome.runtime.sendMessage({
        type: 'schedule:finish', sessionId: msg.sessionId, taskId: wake.taskId, occurrenceId: wake.occurrenceId,
        error: rt.kstate.error?.message ?? ((!answered || rt.lastTurnAborted) ? '任务未完成或已中止，请检查后恢复' : undefined),
      })
    } catch (e) {
      respond({ accepted: false, reason: String(e) })
      await chrome.runtime.sendMessage({ type: 'schedule:finish', sessionId: msg.sessionId, taskId: msg.wake.taskId, occurrenceId: msg.wake.occurrenceId, error: String(e) }).catch(() => {})
    } finally {
      if (heldRuntime) {
        await chrome.runtime.sendMessage({ type: 'tab-lock:release', sessionId: msg.sessionId }).catch(() => {})
        heldRuntime.kernel.holdScheduleBoundary(false)
      }
      scheduledSessions.delete(msg.sessionId)
      if (retained) pool.release(msg.sessionId)
    }
  })()
  return true
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'kernel-sync') return
  mux.attachPort(port)
})

console.log('[offscreen] kernel host ready (multiplexed)')
