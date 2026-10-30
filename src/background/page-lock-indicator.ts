import { execScript, ScriptDeadlineError } from './tool-handlers'
import type { ToolActivity } from '../shared/tool-description'

let indicatorEnabled = true

export function setPageLockIndicatorEnabled(enabled: boolean): void {
  indicatorEnabled = enabled
}

// Reason: the island's lifetime used to have no upper bound — it stayed lit
// until an explicit hide arrived, so ANY lost hide (a late-landing injection, a
// soft nav replacing the isolated world, a terminated service worker) left it on
// forever. A show now only grants presence for the next LEASE_MS; the page
// removes it itself unless renewed. Renewal rides the turn-alive heartbeat (see
// touchTurn in tab-locks), which is well under this budget.
const LEASE_MS = 90_000
const LEAVE_MS = 820

interface IndicatorAck { ok: true; seq: number; stale?: true }

// Reason: exported for tests only — the guard's ordering semantics are the whole
// point of this module and cannot be observed from the outside. Must stay
// self-contained: it is serialized into the page, so no closure references.
export function installLockIndicator(visible: boolean, seq: number, leaseMs: number, leaveMs: number, activities?: ToolActivity[]): IndicatorAck {
  // Reason: execScript races a deadline but never cancels the underlying
  // executeScript, so an injection can land arbitrarily late — after the hide
  // that was meant to supersede it. Nothing else in the chain enforces
  // last-writer-wins, so the guard lives here, the only place that observes
  // actual landing order. It must precede every DOM access: a stale payload has
  // to be inert, and the test environment has no DOM.
  const w = globalThis as typeof globalThis & { __sidekickLockSeq?: number }
  const applied = w.__sidekickLockSeq ?? 0
  if (seq <= applied) return { ok: true, seq: applied, stale: true }
  w.__sidekickLockSeq = seq

  const id = '__sidekick_lock_indicator__'
  type ActivityState = {
    calls: Map<string, ToolActivity & { since: number }>
    label: string
    changedAt: number
    timer?: number
    textTimer?: number
  }
  type IndicatorHost = HTMLDivElement & { __sidekickRemoveTimer?: number; __sidekickActivity?: ActivityState }
  const existing = document.getElementById(id) as IndicatorHost | null
  const cancelActivity = (node: IndicatorHost) => {
    const state = node.__sidekickActivity
    if (!state) return
    window.clearTimeout(state.timer)
    window.clearTimeout(state.textTimer)
    delete node.__sidekickActivity
  }

  if (!visible) {
    if (!existing) return { ok: true, seq }
    cancelActivity(existing)
    existing.dataset.visible = 'leaving'
    if (existing.__sidekickRemoveTimer) window.clearTimeout(existing.__sidekickRemoveTimer)
    existing.__sidekickRemoveTimer = window.setTimeout(() => existing.remove(), leaveMs)
    return { ok: true, seq }
  }

  const host = existing ?? document.createElement('div') as IndicatorHost
  const created = !existing
  if (host.__sidekickRemoveTimer) window.clearTimeout(host.__sidekickRemoveTimer)
  // Reason: the lease — the same removal path an explicit hide uses, just
  // further out. Re-armed by every show, so a renewed island never reaches it.
  host.__sidekickRemoveTimer = window.setTimeout(() => {
    cancelActivity(host)
    host.dataset.visible = 'leaving'
    window.setTimeout(() => host.remove(), leaveMs)
  }, leaseMs)
  if (!existing) {
    host.id = id
    host.dataset.visible = 'false'
    host.style.all = 'initial'
    host.style.position = 'fixed'
    host.style.inset = '0'
    host.style.zIndex = '2147483647'
    host.style.pointerEvents = 'none'
    host.style.colorScheme = 'light dark'
    ;(document.documentElement || document.body).appendChild(host)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        :host { all: initial; }
        @property --sidekick-angle {
          syntax: '<angle>';
          inherits: false;
          initial-value: 0deg;
        }
        .frame {
          position: fixed;
          inset: 0;
          pointer-events: none;
          opacity: 0;
          filter: saturate(.65) brightness(.72);
          transform: scale(.986);
          transform-origin: center;
          transition: opacity 620ms ease, filter 720ms ease, transform 720ms cubic-bezier(.18,.9,.22,1);
          box-shadow:
            inset 0 0 36px rgba(10, 132, 255, .30),
            inset 0 0 76px rgba(191, 90, 242, .24),
            inset 0 0 112px rgba(255, 55, 95, .18);
        }
        .frame::before {
          content: '';
          position: absolute;
          inset: -10px;
          padding: 14px;
          opacity: 0;
          transform: scale(.992);
          transition: opacity 520ms ease, transform 520ms cubic-bezier(.18,.9,.22,1);
          background: conic-gradient(
            from var(--sidekick-angle),
            rgba(10,132,255,0) 0deg,
            rgba(10,132,255,0) 30deg,
            rgba(100,210,255,.28) 72deg,
            rgba(191,90,242,.34) 116deg,
            rgba(255,55,95,.28) 156deg,
            rgba(255,159,10,.18) 198deg,
            rgba(48,209,88,.14) 238deg,
            rgba(100,210,255,.30) 282deg,
            rgba(10,132,255,0) 330deg,
            rgba(10,132,255,0) 360deg
          );
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          filter: blur(10px);
          animation: sidekick-chase 5.6s linear infinite;
        }
        .frame::after {
          content: '';
          position: absolute;
          inset: -34px;
          opacity: 0;
          transform: scale(.985);
          transition: opacity 560ms ease 80ms, transform 560ms cubic-bezier(.18,.9,.22,1) 80ms;
          background:
            radial-gradient(260px 120px at 15% 0%, rgba(100,210,255,.32), transparent 64%),
            radial-gradient(300px 130px at 86% 100%, rgba(255,55,95,.26), transparent 66%),
            radial-gradient(240px 120px at 50% 100%, rgba(191,90,242,.24), transparent 62%);
          filter: blur(22px);
        }
        .hit {
          position: fixed;
          top: 10px;
          left: 50%;
          width: 36px;
          height: 36px;
          transform: translateX(-50%);
          pointer-events: auto;
          transition: width 360ms cubic-bezier(.18,.9,.22,1);
        }
        .island {
          position: absolute;
          left: 50%;
          top: 0;
          width: 36px;
          height: 36px;
          padding: 0;
          transform: translateX(-50%) translateY(-8px) scale(.84);
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          overflow: hidden;
          white-space: nowrap;
          color: #fff;
          background:
            radial-gradient(circle at 50% 0%, rgba(255,255,255,.20), transparent 44%),
            rgba(7,7,9,.94);
          border: 1px solid rgba(255,255,255,.16);
          box-shadow:
            0 0 0 1px rgba(255,255,255,.06),
            0 10px 30px rgba(0,0,0,.34),
            0 0 24px rgba(99,102,241,.18),
            inset 0 0 0 1px rgba(255,255,255,.05);
          backdrop-filter: blur(18px) saturate(1.25);
          -webkit-backdrop-filter: blur(18px) saturate(1.25);
          opacity: 0;
          pointer-events: none;
          font: 500 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
          transition:
            opacity 220ms ease,
            transform 320ms cubic-bezier(.18,.9,.22,1),
            width 360ms cubic-bezier(.18,.9,.22,1),
            padding 360ms cubic-bezier(.18,.9,.22,1),
            box-shadow 220ms ease;
        }
        .sparkles {
          width: 0;
          height: 15px;
          flex: 0 0 auto;
          overflow: hidden;
          opacity: 0;
          transform: translateY(2px) scale(.96);
          transition: width 220ms ease 40ms, opacity 180ms ease 80ms, transform 220ms ease 80ms;
          filter: drop-shadow(0 0 8px rgba(103,232,249,.45));
        }
        .label {
          min-width: 0;
          max-width: 0;
          overflow: hidden;
          opacity: 0;
          transform: translateY(3px);
          transition: max-width 260ms ease 40ms, opacity 180ms ease 90ms, transform 220ms ease 90ms;
          text-overflow: ellipsis;
        }
        .label[data-changing="true"] { animation: sidekick-label-in 320ms ease both; }
        @keyframes sidekick-label-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .dot {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex: 0 0 auto;
          background: #67e8f9;
          box-shadow: 0 0 14px rgba(103,232,249,.85);
          animation: sidekick-dot-pulse 1.6s ease-in-out infinite;
        }
        :host([data-visible="true"]) .frame {
          opacity: 1;
          filter: saturate(1) brightness(1);
          transform: scale(1);
        }
        :host([data-visible="true"]) .frame::before {
          opacity: .82;
          transform: scale(1);
        }
        :host([data-visible="true"]) .frame::after {
          opacity: .84;
          transform: scale(1);
        }
        :host([data-visible="true"]) .island {
          opacity: 1;
          transform: translateX(-50%) translateY(0) scale(1);
        }
        :host([data-visible="leaving"]) .frame {
          opacity: 0;
          filter: saturate(.75) brightness(.82);
          transform: scale(1.024);
        }
        :host([data-visible="leaving"]) .frame::before {
          opacity: 0;
          transform: scale(1.038);
        }
        :host([data-visible="leaving"]) .frame::after {
          opacity: 0;
          transform: scale(1.052);
          transition: opacity 560ms ease, transform 700ms cubic-bezier(.18,.9,.22,1);
        }
        .hit:hover {
          width: min(var(--island-width, 198px), calc(100vw - 20px));
        }
        .hit:hover .island {
          width: min(var(--island-width, 198px), calc(100vw - 20px));
          padding: 0 14px;
        }
        .hit:hover .sparkles {
          width: 15px;
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        .hit:hover .label {
          max-width: 100%;
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        .hit:hover .dot {
          position: static;
          left: auto;
          top: auto;
          animation-name: sidekick-pulse;
        }
        @keyframes sidekick-chase {
          to { --sidekick-angle: 360deg; }
        }
        @keyframes sidekick-dot-pulse {
          0%, 100% { opacity: .38; transform: translate(-50%, -50%) scale(.82); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes sidekick-pulse {
          0%, 100% { opacity: .38; transform: scale(.82); }
          50% { opacity: 1; transform: scale(1); }
        }
      </style>
      <div class="frame" aria-hidden="true"></div>
      <div class="hit" aria-hidden="true">
        <div class="island">
          <svg class="sparkles" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3.2l1.55 4.15L17.7 8.9l-4.15 1.55L12 14.8l-1.55-4.35L6.3 8.9l4.15-1.55L12 3.2Z"/>
            <path d="M5.2 14.8l.68 1.82 1.82.68-1.82.68-.68 1.82-.68-1.82-1.82-.68 1.82-.68.68-1.82Z"/>
            <path d="M18.4 3.9l.52 1.38 1.38.52-1.38.52-.52 1.38-.52-1.38-1.38-.52 1.38-.52.52-1.38Z"/>
          </svg>
          <span class="label">Agent 正在此页工作</span>
          <span class="dot"></span>
        </div>
      </div>
    `
  }
  const label = host.shadowRoot?.querySelector<HTMLElement>('.label')
  if (label) {
    const generic = 'Agent 正在此页工作'
    if (!host.__sidekickActivity) {
      label.textContent = generic
      label.title = generic
      label.dataset.changing = 'false'
      host.style.setProperty('--island-width', '198px')
    }
    const state: ActivityState = host.__sidekickActivity ??= { calls: new Map(), label: generic, changedAt: Date.now() - 2_000 }
    if (activities !== undefined) {
      const now = Date.now()
      state.calls = new Map(activities.map(call => [call.id, { ...call, since: state.calls.get(call.id)?.since ?? now }]))
    }
    window.clearTimeout(state.timer)
    const update = () => {
      // Reason: pending callbacks must not resurrect a hidden or replaced island.
      if (host.__sidekickActivity !== state || host.dataset.visible === 'leaving') return
      const now = Date.now()
      // Reason: parallel calls share one slot; only the latest live candidate is
      // considered. Old candidates are never queued for playback.
      const candidate = [...state.calls.values()].at(-1)
      const eligibleAt = candidate ? candidate.since + 600 : now
      const next = candidate && now >= eligibleAt
        ? `${candidate.phase === 'preparing' ? '准备：' : ''}${candidate.description}` : generic
      const canChangeAt = state.changedAt + 2_000
      if (next !== state.label && now >= canChangeAt) {
        state.label = next
        state.changedAt = now
        label.textContent = next
        label.title = next
        label.dataset.changing = 'false'
        // Reason: restarting only the text animation leaves the island and its
        // hover expansion stable across activity updates.
        void label.offsetWidth
        label.dataset.changing = 'true'
        window.clearTimeout(state.textTimer)
        state.textTimer = window.setTimeout(() => { label.dataset.changing = 'false' }, 320)
        host.style.setProperty('--island-width', `${Math.min(360, Math.max(198, next.length * 12 + 64))}px`)
      }
      const nextAt = candidate && now < eligibleAt
        ? Math.max(eligibleAt, next !== state.label ? canChangeAt : now)
        : next !== state.label ? canChangeAt : null
      if (nextAt !== null) state.timer = window.setTimeout(update, Math.max(1, nextAt - now))
    }
    update()
  }
  const reveal = () => { host.dataset.visible = 'true' }
  if (created || host.dataset.visible !== 'true') {
    host.dataset.visible = 'false'
    window.requestAnimationFrame(() => window.requestAnimationFrame(reveal))
  } else {
    reveal()
  }
  return { ok: true, seq }
}

// Reason: NOT seeded from Date.now() — a backwards clock correction would hand
// out sequences below what a live document already applied, silently rejecting
// every later injection and reproducing the very bug this guards against.
// Instead the counter self-heals: the page reports the sequence it has applied
// and we climb above it, so a service-worker restart converges on its own.
let lastIssuedSeq = 0

async function injectIndicator(tabId: number, visible: boolean, activities?: ToolActivity[]): Promise<void> {
  const seq = ++lastIssuedSeq
  try {
    // Reason: world and frame are pinned because the guard's marker lives on the
    // isolated world's global — an injection landing in MAIN, or in a subframe,
    // would keep its own marker and silently reduce the guard to a no-op.
    const res = await execScript<IndicatorAck>({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      injectImmediately: true,
      func: installLockIndicator,
      args: [visible, seq, LEASE_MS, LEAVE_MS, ...(activities === undefined ? [] : [activities])],
    }, 5_000)
    const ack = res?.[0]?.result
    if (!ack) return
    if (ack.seq > lastIssuedSeq) lastIssuedSeq = ack.seq
    if (ack.stale) {
      console.warn(`[lock-indicator] tab ${tabId}: dropped a stale ${visible ? 'show' : 'hide'} (seq ${seq} <= applied ${ack.seq}) — it landed out of order`)
    }
  } catch (err) {
    // Reason: chrome://, Web Store, discarded tabs and transient navigations may
    // reject injection; the side panel remains the authoritative indicator. A
    // deadline is the one class worth reporting: it does NOT cancel the
    // injection, so that payload can still land later.
    if (err instanceof ScriptDeadlineError) {
      console.warn(`[lock-indicator] tab ${tabId}: ${visible ? 'show' : 'hide'} (seq ${seq}) hit its deadline and may still land later:`, err.message)
    }
  }
}

export async function showPageLockIndicator(tabId: number, activities?: ToolActivity[]): Promise<void> {
  if (!indicatorEnabled) return
  await injectIndicator(tabId, true, activities)
}

export async function hidePageLockIndicator(tabId: number): Promise<void> {
  await injectIndicator(tabId, false)
}

export function syncPageLockIndicator(prevTabId: number | null | undefined, nextTabId: number | null): void {
  if (prevTabId != null && prevTabId !== nextTabId) hidePageLockIndicator(prevTabId)
  if (nextTabId != null) showPageLockIndicator(nextTabId)
}
