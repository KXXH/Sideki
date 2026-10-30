import type { SessionRuntime } from './kernel-runtime'
import type { ApiConfig } from '../types'
import { extractTurnSnippet, type TurnDoneMessage } from '../turn-notify'

// Reason: turn-boundary automation must live kernel-side — the panel that
// used to run these effects may be closed mid-turn. The 5s streaming
// checkpoint bounds data loss if the kernel itself dies mid-turn.
export function wireTurnAutomation(rt: SessionRuntime, getConfig: () => ApiConfig | null): () => void {
  let prevStatus = rt.kstate.status
  let lastCheckpoint = 0
  let lastTabLockTouch = 0
  // Reason: kstate.messages is copy-on-write — reference identity is a
  // complete change detector. Without this guard the subscriber feeds back:
  // flushSave() bumps kstate (and its onSessionUpdated bumps every live
  // runtime via the pool), which would reschedule another save forever.
  // Seeded with the just-loaded array: storage-fresh messages need no save.
  let lastSavedMessages: unknown = rt.kstate.messages
  return rt.kstate.subscribe(() => {
    const st = rt.kstate.status
    const msgs = rt.kstate.messages
    if (st === 'ready' && msgs.length > 0 && msgs !== lastSavedMessages) {
      lastSavedMessages = msgs
      rt.scheduleSave()
    }
    if (st === 'streaming' && Date.now() - lastCheckpoint > 5000) {
      lastCheckpoint = Date.now()
      rt.flushSave()
    }
    // Reason: tab-lock liveness is "the turn is alive", not "the turn touched a
    // tab" — long reasoning or MCP-only stretches would otherwise let the lock
    // (and the turn's tab stack) expire. kstate bumps on every stream chunk, so
    // this rides the existing channel. It also paces the page indicator's lease
    // renewal. Throttled against Chrome's ~30s idle eviction of the service
    // worker (the tight budget), not the 120s staleness TTL.
    if (st !== 'ready' && Date.now() - lastTabLockTouch > 20_000) {
      lastTabLockTouch = Date.now()
      rt.env.sendMessage({ type: 'tab-lock:touch', sessionId: rt.sessionId }).catch(() => {})
    }
    if (st === 'ready' && prevStatus !== 'ready') {
      // Reason: queued sends are a continuation of the same page-operation
      // context. Keep the stack across the ready handoff; release only after
      // the queue drains so user tab switches cannot redirect the next item.
      const retainTabStack = rt.kernel.hasQueuedContinuation
      rt.env.sendMessage({ type: retainTabStack ? 'tab-lock:touch' : 'tab-lock:release', sessionId: rt.sessionId }).catch(() => {})
      // Reason: the panel that would show this answer may be closed, showing
      // another session, or behind another app — the kernel is the only place
      // that sees the turn end regardless, so the facts travel from here and
      // the SW decides whether to announce them. A brand-new session is still
      // titled 'New Chat' at this instant, hence the wait.
      rt.settleTitle()
        .then(() => rt.env.sendMessage({
          type: 'turn:done',
          sessionId: rt.sessionId,
          title: rt.session.title,
          snippet: extractTurnSnippet(rt.kstate.messages),
          foreground: rt.env.isSessionForeground?.(rt.sessionId) !== false,
          mode: rt.session.mode ?? 'chat',
        } satisfies TurnDoneMessage))
        .catch(() => {})
      onTurnBoundary(rt, getConfig()).catch(e => console.warn('[kernel] turn boundary failed:', e))
    }
    // Reason: 'error' is terminal for the SDK — it never reaches 'ready' on its
    // own, so the release above never fires and the lock (plus the page
    // indicator and pointer) survives until the staleness backstop. Released
    // unconditionally: #schedule bails while status is not 'ready', so a queue
    // cannot drain from a failed turn and retaining the stack buys nothing.
    // onTurnBoundary stays out — archiving belongs to a turn that produced a result.
    if (st === 'error' && prevStatus !== 'error') {
      rt.env.sendMessage({ type: 'tab-lock:release', sessionId: rt.sessionId }).catch(() => {})
    }
    prevStatus = st
  })
}

async function onTurnBoundary(rt: SessionRuntime, cfg: ApiConfig | null): Promise<void> {
  if (!cfg || cfg.labAutoCompress === false) return
  await rt.kernel.archiveNow()
  const cw = cfg.contextWindow
  const used = rt.lastTurnTokens.input
  if (cw && used > 0 && used / cw >= 0.8 && Date.now() - rt.kernel.lastCompactionAt >= 30_000) {
    await rt.kernel.compactNow()
  }
}
