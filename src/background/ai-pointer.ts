import { execScript } from './tool-handlers'
import { AI_POINTER_ID, AI_POINTER_Z_INDEX } from '../shared/input'

// Reason: pointer visibility is independent of event dispatch. The worker
// combines the display preference with engine availability so the legacy
// path stays silent, including CDP plans that exist with the engine off.
let pointerEnabled = true

export function setAiPointerEnabled(enabled: boolean): void {
  pointerEnabled = enabled
}

export function isAiPointerEnabled(): boolean {
  return pointerEnabled
}

// Reason: the visual lives here as a string so the interpreter can drive it
// without duplicating markup. The interpreter is serialized by executeScript and
// cannot import this module, so it arrives as an injection argument instead.
// Shadow DOM (not canvas) both keeps page styles out and keeps the overlay out
// of extractRawHtml's outerHTML — a bare <canvas> would still serialize.
export const AI_POINTER_MARKUP = `
<style>
  :host { all: initial; }
  .p {
    position: fixed;
    top: 0; left: 0;
    width: 26px; height: 26px;
    pointer-events: none;
    will-change: transform;
    transition: transform 90ms linear, opacity 200ms ease;
    opacity: 0;
  }
  .p[data-on='1'] { opacity: 1; }

  /* Reason: the glyph must be hidden by default and revealed by shape. The
     hiding rule needs at least the specificity of the sizing rule, or the
     sizing rule wins and every glyph renders at once. */
  .p > svg {
    position: absolute;
    width: 26px; height: 26px;
    overflow: visible;
    display: none;
    /* Reason: an icon glyph is drawn centred in its box, but a cursor's hotspot
       has to sit exactly on the event coordinate. Each shape declares where its
       own tip is, in viewBox units, and shifts itself by that much. */
    transform: translate(calc(var(--tx) / 24 * -26px), calc(var(--ty) / 24 * -26px));
  }
  .p[data-shape='arrow'] > svg.arrow { display: block; }
  .p[data-shape='hand'] > svg.hand { display: block; }

  .halo { stroke: #ffffff; stroke-width: 5; fill: none; }
  .body { stroke: #1c1c1e; stroke-width: 2; }
  /* Reason: the press state is the fill, not a separate ring — one shape, one
     signal. Idle keeps a faint tint so the glyph still reads as filled. */
  .tint { fill: #0a84ff; fill-opacity: .16; transition: fill-opacity 120ms ease; }
  .p[data-press='1'] .tint { fill-opacity: .95; }
</style>
<div class="p" data-shape="arrow">
  <svg class="arrow" viewBox="0 0 24 24" style="--tx:4;--ty:4" stroke-linecap="round" stroke-linejoin="round">
    <path class="halo" d="M11 21L4 4l17 7l-6.265 2.685a2 2 0 0 0-1.05 1.05z"/>
    <path class="body tint" d="M11 21L4 4l17 7l-6.265 2.685a2 2 0 0 0-1.05 1.05z"/>
  </svg>
  <svg class="hand" viewBox="0 0 24 24" style="--tx:9.5;--ty:3" stroke-linecap="round" stroke-linejoin="round">
    <path class="halo" d="M8 13V4.5a1.5 1.5 0 0 1 3 0V12m0-.5v-2a1.5 1.5 0 1 1 3 0V12m0-1.5a1.5 1.5 0 0 1 3 0V12"/>
    <path class="halo" d="M17 11.5a1.5 1.5 0 0 1 3 0V16a6 6 0 0 1-6 6h-2h.208a6 6 0 0 1-5.012-2.7L7 19q-.468-.718-3.286-5.728a1.5 1.5 0 0 1 .536-2.022a1.87 1.87 0 0 1 2.28.28L8 13"/>
    <path class="body tint" d="M17 11.5a1.5 1.5 0 0 1 3 0V16a6 6 0 0 1-6 6h-2h.208a6 6 0 0 1-5.012-2.7L7 19q-.468-.718-3.286-5.728a1.5 1.5 0 0 1 .536-2.022a1.87 1.87 0 0 1 2.28.28L8 13"/>
    <path class="body" fill="none" d="M8 13V4.5a1.5 1.5 0 0 1 3 0V12m0-.5v-2a1.5 1.5 0 1 1 3 0V12m0-1.5a1.5 1.5 0 0 1 3 0V12"/>
  </svg>
</div>`

/**
 * Page-context: drive the pointer through a cue timeline on its own clock.
 * Used for iframe targets, where the pointer must animate in the top frame while
 * events are dispatched frame-local.
 */
export async function animateAiPointer(
  id: string,
  zIndex: number,
  markup: string,
  cuesJson: string,
  from: { x: number; y: number },
): Promise<{ ok: true }> {
  const cues = JSON.parse(cuesJson) as Array<{ at: number; kind: string; point?: { x: number; y: number }; shape?: string }>

  let host = document.getElementById(id) as (HTMLDivElement & { __skRemoveTimer?: number }) | null
  if (!host) {
    host = document.createElement('div') as HTMLDivElement & { __skRemoveTimer?: number }
    host.id = id
    host.setAttribute('data-sidekick-overlay', 'pointer')
    host.style.all = 'initial'
    host.style.position = 'fixed'
    host.style.inset = '0'
    host.style.zIndex = String(zIndex)
    host.style.pointerEvents = 'none'
    ;(document.documentElement || document.body).appendChild(host)
    host.attachShadow({ mode: 'open' }).innerHTML = markup
  }
  if (host.__skRemoveTimer) {
    clearTimeout(host.__skRemoveTimer)
    host.__skRemoveTimer = undefined
  }

  const el = host.shadowRoot?.querySelector('.p') as HTMLElement | null
  if (!el) return { ok: true }
  el.style.transform = `translate3d(${from.x}px, ${from.y}px, 0)`
  el.dataset.on = '1'

  // Reason: a hidden tab gets no frames and its timers are clamped to ~1/s, so
  // there is nothing to animate — jump to the final state instead of stalling.
  const instant = document.visibilityState !== 'visible'
  let elapsed = 0
  for (const cue of cues) {
    if (!instant && cue.at > elapsed) {
      const dt = cue.at - elapsed
      await new Promise(r => { setTimeout(r, dt) })
    }
    elapsed = Math.max(elapsed, cue.at)
    if (cue.kind === 'move' && cue.point) {
      el.style.transform = `translate3d(${cue.point.x}px, ${cue.point.y}px, 0)`
    } else if (cue.kind === 'press') {
      el.dataset.press = '1'
    } else if (cue.kind === 'release') {
      el.dataset.press = '0'
    } else if (cue.kind === 'shape' && cue.shape) {
      el.dataset.shape = cue.shape
    }
  }
  return { ok: true }
}

/**
 * Page-context: fade the pointer out and detach it.
 */
export function removeAiPointer(id: string): { ok: true } {
  const host = document.getElementById(id) as (HTMLDivElement & { __skRemoveTimer?: number }) | null
  if (!host) return { ok: true }
  const el = host.shadowRoot?.querySelector('.p') as HTMLElement | null
  if (el) el.dataset.on = '0'
  if (host.__skRemoveTimer) clearTimeout(host.__skRemoveTimer)
  host.__skRemoveTimer = setTimeout(() => host.remove(), 260) as unknown as number
  return { ok: true }
}

// Reason: fire-and-forget. The pointer is decoration — a failed injection on a
// chrome:// page or a mid-navigation tab must never fail the action itself.
export function animatePointerInTopFrame(tabId: number, cues: unknown[], from: { x: number; y: number }): void {
  if (!pointerEnabled || cues.length === 0) return
  execScript({
    target: { tabId, frameIds: [0] },
    injectImmediately: true,
    func: animateAiPointer,
    args: [AI_POINTER_ID, AI_POINTER_Z_INDEX, AI_POINTER_MARKUP, JSON.stringify(cues), from],
  }, 5_000).catch(() => {})
}

// Reason: returns the promise so a caller that must not photograph the pointer
// can await the hide before waiting out the fade. Never rejects, so the
// fire-and-forget callers stay correct by ignoring it.
export function hideAiPointer(tabId: number): Promise<void> {
  return execScript({
    target: { tabId, frameIds: [0] },
    injectImmediately: true,
    func: removeAiPointer,
    args: [AI_POINTER_ID],
  }, 5_000).then(() => {}).catch(() => {})
}
