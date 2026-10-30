import { loadConfig, loadSessionIndex } from '../shared/storage'
import { siteOriginOf, isSiteAllowed, grantSitePermission, SITE_ALLOWABLE_TOOLS } from '../shared/site-permissions'
import { execBash, mirrorScreenshotToVfs, KEEP_SCREENSHOTS } from './shell'
import { ensureSelectorLib, ensureResolver } from './element-resolver'
import { pickerScript } from './element-picker'
import { debugSession } from './debug-session'
import {
  planClick, planHover, planType, planKeypress,
  approachPoint, initialMouseState, toCdpCommands,
  describeObservation, shouldRetryAllFrames, noElementError, OVERLAY_SELECTOR,
  hiddenReason, describeHidden,
  AI_POINTER_ID, AI_POINTER_Z_INDEX,
  type CdpCommand, type InputPlan, type MouseState, type Timing, type RenderProbe,
} from '../shared/input'
import { measurePlanTarget, interpretPlan, armObservation, collectObservation, type MeasureResult, type InterpretResult } from './input-interpreter'
import { AI_POINTER_MARKUP, isAiPointerEnabled, animatePointerInTopFrame, hideAiPointer } from './ai-pointer'
import { getMouseState, setMouseState, resetMouseState } from './input-state'
import { ownerOf } from './tab-locks'

// Reason: the owning session is derived from the tab rather than plumbed through
// every tool's params — tab-locks already knows it. Actions on a tab no turn
// holds share one bucket so they still get a continuous pointer.
const ANON_SESSION = '__anon__'

// Reason: chrome-types defines executeScript func as () => void, but the runtime
// API supports parametric functions via the args array — cast to bypass
type ScriptResult<R> = Array<{ result: R; frameId?: number }>
export type ExecuteScriptFn = <R = never>(injection: Record<string, unknown>) => Promise<ScriptResult<R>>

// Reason: executeScript defaults to running at document_idle in EVERY target
// frame and only settles once all injections complete. A single frame that never
// reaches idle — a deferred lazy iframe, an autoplaying media embed — leaves the
// promise pending forever (observed on pages with off-screen Cloudflare Stream
// iframes: getPageContent hung until the tab was reloaded, which tore the frame
// down). Read-only extraction therefore passes injectImmediately, and every
// injection gets a deadline so a stall can never become permanent.
const SCRIPT_DEADLINE_MS = 30_000

// Reason: the fixed-duration sleep legitimately runs its full length, so its
// deadline has to sit above it — this is the margin. It stays small because the
// whole call must finish inside the bash budget (5s in Chat); a lifeline that
// fires after the budget is no lifeline at all, the model just reads "execution
// aborted" and learns nothing.
export const INJECT_HEADROOM_MS = 1_500

// Reason: same budget argument — navigation completion is awaited only as long
// as the caller can still hear the answer.
const NAV_SETTLE_MS = 3_500

// Reason: the element wait polls from here rather than from inside the page.
// Each attempt is an instant check, hence the small deadline; the ceiling comes
// from the caller (see handleWait's maxMs), since only the bash path has a
// budget to fit inside.
const WAIT_POLL_MS = 150
const WAIT_ATTEMPT_DEADLINE_MS = 1_500

// Reason: callers must distinguish "Chrome told us why the injection failed"
// from "nobody told us anything and our own deadline fired". Chrome's messages
// name a concrete cause and are passed through verbatim; only this case warrants
// a guess about what went wrong. A class, not substring matching — Chrome's
// wording drifts between versions.
export class ScriptDeadlineError extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ScriptDeadlineError(`executeScript timed out after ${ms}ms (${label}) — a target frame may never reach document_idle`)),
        ms,
      )
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

// Reason: single choke point for injections — keeps the call shape identical to
// chrome.scripting.executeScript so sites only opt into injectImmediately.
export function execScript<R = never>(
  injection: Record<string, unknown>,
  deadlineMs = SCRIPT_DEADLINE_MS,
): Promise<ScriptResult<R>> {
  const target = injection.target as { allFrames?: boolean; frameIds?: number[] } | undefined
  const label = target?.allFrames ? 'allFrames' : target?.frameIds ? `frame ${target.frameIds.join(',')}` : 'top frame'
  return withDeadline((chrome.scripting.executeScript as unknown as ExecuteScriptFn)<R>(injection), deadlineMs, label)
}

const approvedDebuggerHosts = new Set<string>()

interface ExecFailure { success: false; error: string }
interface FramedResult<R> { result: R; frameId: number }
interface ViewportOffset { success: true; x: number; y: number }
interface NavFrame { frameId: number; parentFrameId: number; url: string }

async function execInTab<R>(
  tabId: number,
  func: (...args: never[]) => R,
  args: unknown[] = [],
  frameId?: number,
  deadlineMs = SCRIPT_DEADLINE_MS,
): Promise<R | ExecFailure> {
  try {
    const target: Record<string, unknown> = { tabId }
    if (frameId !== undefined) target.frameIds = [frameId]
    const results = await execScript<R>({ target, func, args }, deadlineMs)
    if (!results?.length) return { success: false, error: 'executeScript returned no results (tab may have been closed or is a chrome:// page)' }
    return results[0].result
  } catch (e) {
    return { success: false, error: `executeScript failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// Reason: elements inside iframes are invisible to the top frame's DOM.
// This helper runs the function in ALL frames and returns the first successful result.
async function execInAllFrames<R>(
  tabId: number,
  func: (...args: never[]) => R,
  args: unknown[] = [],
): Promise<{ result: R; frameId: number } | ExecFailure> {
  try {
    // Reason: default injection timing is kept here — this path also dispatches
    // DOM actions, where acting on a not-yet-idle frame would be worse than
    // waiting. The deadline alone protects it from hanging.
    const results = await execScript<R>({ target: { tabId, allFrames: true }, func, args })
    if (!results?.length) return { success: false, error: 'No frames returned results' }
    // Reason: find the first frame where the action succeeded (has success: true)
    for (const r of results) {
      if (r.result && typeof r.result === 'object' && 'success' in r.result && (r.result as Record<string, unknown>).success) {
        return { result: r.result, frameId: r.frameId ?? 0 }
      }
    }
    // None succeeded — return the top frame's result (which has the error message)
    return results[0].result as unknown as ExecFailure
  } catch (e) {
    return { success: false, error: `executeScript (allFrames) failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// Reason: all DOM tools need element resolution from a flexible "target" string —
// CSS selector, visible text, or aria-label. Since chrome.scripting.executeScript
// serializes functions (no shared closures), the resolver lives inside one big
// injected function that also dispatches the action via a switch-case.
// If the element isn't found in the top frame, retries across all iframes.
async function resolveAndExecWithFrame(
  tabId: number,
  target: string,
  action: string,
  extraArgs: unknown[] = [],
): Promise<FramedResult<unknown> | ExecFailure> {
  await ensureSelectorLib(tabId)
  await ensureResolver(tabId)
  const result = await execInTab(tabId, resolveAndExecInner, [target, action, ...extraArgs])
  // Reason: if top frame can't find the element, search all iframes
  if (result && typeof result === 'object' && 'success' in result
      && !(result as Record<string, unknown>).success
      && typeof (result as Record<string, unknown>).error === 'string'
      && ((result as Record<string, unknown>).error as string).includes('No element found')) {
    const allFramesResult = await execInAllFrames(tabId, resolveAndExecInner, [target, action, ...extraArgs])
    if ('frameId' in allFramesResult) return allFramesResult
    return allFramesResult
  }
  return { result, frameId: 0 }
}

async function resolveAndExec(
  tabId: number,
  target: string,
  action: string,
  extraArgs: unknown[] = [],
): Promise<unknown> {
  const framed = await resolveAndExecWithFrame(tabId, target, action, extraArgs)
  if ('frameId' in framed) return framed.result
  return framed
}

function resolveAndExecInner(
    target: string, action: string, ...extra: unknown[]
  ) {
    // Reason: resolution delegated to self.__skResolve (installed by ensureResolver)
    const resolve = (self as unknown as { __skResolve?: (t: string) => HTMLElement | null }).__skResolve
    const el = resolve ? resolve(target) : null
    if (!el) return { success: false, error: `No element found matching "${target}". Try a CSS selector or different text.` }

    switch (action) {
      case 'click': {
        const doubleClick = extra[0] as boolean
        if (doubleClick) {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
        } else {
          el.click()
        }
        return { success: true, tagName: el.tagName, text: (el.textContent ?? '').slice(0, 100) }
      }
      case 'hover': {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
        return { success: true }
      }
      case 'type': {
        const text = extra[0] as string
        const clear = extra[1] as boolean
        el.focus()
        const isInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        if (isInput) {
          if (clear) (el as HTMLInputElement).value = ''
          ;(el as HTMLInputElement).value += text
        } else {
          if (clear) el.textContent = ''
          el.textContent += text
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true }
      }
      case 'select': {
        const value = extra[0] as string
        if (el.tagName !== 'SELECT') return { success: false, error: `Element is <${el.tagName.toLowerCase()}>, not a <select>` }
        const sel = el as HTMLSelectElement
        sel.value = value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        const selected = sel.options[sel.selectedIndex]
        return { success: true, selectedText: selected?.text ?? value }
      }
      case 'keypress': {
        const key = extra[0] as string
        const ctrl = extra[1] as boolean
        const shift = extra[2] as boolean
        const alt = extra[3] as boolean
        const meta = extra[4] as boolean
        const opts: KeyboardEventInit = {
          key, bubbles: true, cancelable: true,
          ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta,
        }
        el.dispatchEvent(new KeyboardEvent('keydown', opts))
        el.dispatchEvent(new KeyboardEvent('keyup', opts))
        return { success: true }
      }
      case 'scroll': {
        const direction = extra[0] as string
        const amount = extra[1] as number
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
        el.scrollBy(dx, dy)
        return { success: true }
      }
      case 'scrollIntoView': {
        el.scrollIntoView({ block: 'center', behavior: 'instant' })
        return { success: true }
      }
      case 'getElementInfo': {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        // Reason: checkVisibility walks ancestors; computed style alone reports
        // an element under a display:none parent as visible. Same probe the
        // input engine gates on, so "visible" means one thing project-wide.
        const probeFn = (el as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility
        const rendered = typeof probeFn === 'function'
          ? probeFn.call(el, { visibilityProperty: true, contentVisibilityAuto: true, checkVisibilityCSS: true })
          : style.display !== 'none' && style.visibility !== 'hidden'
        const attrNames = ['id', 'class', 'name', 'type', 'href', 'src', 'placeholder', 'role', 'aria-label']
        const attributes: Record<string, string> = {}
        for (const n of attrNames) {
          const v = el.getAttribute(n)
          if (v) attributes[n] = v
        }
        return {
          success: true as const,
          tagName: el.tagName,
          text: (el.textContent ?? '').slice(0, 500),
          visible: rendered && rect.width > 0 && rect.height > 0,
          probe: {
            connected: el.isConnected,
            rendered,
            display: style.display,
            visibility: style.visibility,
            opacity: parseFloat(style.opacity) || 0,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            viewport: { w: window.innerWidth, h: window.innerHeight },
            // Reason: this action never scrolls, so an off-viewport rect here is
            // just below the fold — reachable, and must not read as unreachable.
            scrolled: false,
          },
          value: (el as HTMLInputElement).value ?? null,
          boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          attributes,
        }
      }
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  }

// --- Helpers ---

const NAV_DETECT_DELAY = 300

async function detectNavigation<T extends Record<string, unknown>>(
  tabId: number,
  action: () => Promise<T | ExecFailure>,
): Promise<T | ExecFailure> {
  let beforeUrl: string | undefined
  try { beforeUrl = (await chrome.tabs.get(tabId)).url } catch { /* tab may be gone */ }
  const result = await action()
  if (!result || (typeof result === 'object' && 'success' in result && !result.success)) return result
  await new Promise(r => setTimeout(r, NAV_DETECT_DELAY))
  try {
    const afterUrl = (await chrome.tabs.get(tabId)).url
    if (beforeUrl && afterUrl && afterUrl !== beforeUrl) {
      (result as Record<string, unknown>).navigatedTo = afterUrl
      // Reason: a new document means the stored coordinates point at geometry
      // that no longer exists.
      resetMouseState(ownerOf(tabId) ?? ANON_SESSION, tabId)
    }
  } catch { /* tab closed */ }
  return result
}

function frameOwnerRectInParent(childUrl: string, allowSingleFrameFallback: boolean) {
  function clean(url: string): string {
    try {
      const u = new URL(url, document.baseURI)
      u.hash = ''
      return u.href
    } catch {
      return url.split('#')[0]
    }
  }

  const wanted = clean(childUrl)
  const frames = Array.from(document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]
  const withMeta = frames.map((el) => {
    const raw = el.getAttribute('src') || ''
    const src = clean(raw || el.src || '')
    return { el, src }
  })
  const exact = withMeta.filter(f => f.src === wanted)
  const candidates = exact.length > 0
    ? exact
    : allowSingleFrameFallback && withMeta.length === 1
      ? withMeta
      : []

  if (candidates.length !== 1) {
    return {
      success: false,
      error: `Could not map iframe owner for real click (${candidates.length || withMeta.length} candidate frames)`,
    }
  }

  const rect = candidates[0].el.getBoundingClientRect()
  return {
    success: true,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
}

export async function frameViewportOffset(tabId: number, frameId: number): Promise<ViewportOffset | ExecFailure> {
  if (frameId === 0) return { success: true, x: 0, y: 0 }

  let frames: NavFrame[] | null
  try {
    const rawFrames = await chrome.webNavigation.getAllFrames({ tabId })
    frames = rawFrames?.map(f => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })) ?? null
  } catch (e) {
    return { success: false, error: `Could not enumerate frames for real click: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!frames?.length) return { success: false, error: 'Could not enumerate frames for real click' }

  const byId = new Map(frames.map(f => [f.frameId, f]))
  const chain: NavFrame[] = []
  let cur = byId.get(frameId)
  while (cur && cur.frameId !== 0) {
    chain.push(cur)
    cur = byId.get(cur.parentFrameId)
  }
  if (!cur || cur.frameId !== 0) return { success: false, error: `Could not build frame chain for frame ${frameId}` }

  let x = 0
  let y = 0
  for (let i = chain.length - 1; i >= 0; i--) {
    const child = chain[i]
    const siblings = frames.filter(f => f.parentFrameId === child.parentFrameId)
    const parentFrameId = child.parentFrameId === 0 ? undefined : child.parentFrameId
    const owner = await execInTab(tabId, frameOwnerRectInParent, [child.url, siblings.length === 1], parentFrameId) as
      | { success: true; rect: { x: number; y: number; width: number; height: number } }
      | ExecFailure
    if (!owner.success) return owner
    x += owner.rect.x
    y += owner.rect.y
  }

  return { success: true, x, y }
}

// --- Plan path (high-fidelity synthetic input) ---

export interface PlanTargetInfo {
  to: { x: number; y: number }
  interactive: boolean
  contentEditable: boolean
  frameId: number
  docId: string | null
}

// Reason: the engine is the planner and the page is the interpreter, so an action
// costs one measure plus one dispatch. ensureSelectorLib is deliberately skipped
// — the unique-selector generator is only needed for reporting, not resolution —
// which keeps the injection count level with the legacy single-shot path.
async function measurePlanTargetIn(tabId: number, target: string): Promise<{ info: PlanTargetInfo; tagName: string } | ExecFailure> {
  await ensureResolver(tabId)

  let frameId = 0
  let measured = await execInTab<MeasureResult>(tabId, measurePlanTarget, [target, true])
  if (!measured.success && shouldRetryAllFrames(measured.error)) {
    const framed = await execInAllFrames<MeasureResult>(tabId, measurePlanTarget, [target, true])
    if (!('frameId' in framed)) return framed
    frameId = framed.frameId
    measured = framed.result
  }
  if (!measured.success || !measured.rect) {
    return { success: false, error: measured.error ?? noElementError(target) }
  }

  // Reason: the element was located, so this is not a resolution failure — it is
  // an unreachable one. Dispatching anyway would either hit nothing (no hit
  // testing on an unrendered box) or land on whatever occupies 0,0, and report
  // success either way. The wording deliberately avoids "No element found" so
  // resolveAndExecWithFrame does not retry across frames for a target it found.
  if (measured.probe) {
    const reason = hiddenReason(measured.probe)
    if (reason) return { success: false, error: describeHidden(measured.probe, reason, target) }
  }

  const { x, y, width, height } = measured.rect
  return {
    tagName: measured.tagName ?? '',
    info: {
      // Reason: frame-local coordinates. The interpreter hit-tests with
      // elementFromPoint inside the target frame, which uses that frame's own
      // viewport — adding the top-level offset here would miss every element.
      to: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) },
      interactive: !!measured.interactive,
      contentEditable: !!measured.contentEditable,
      frameId,
      docId: measured.docId ?? null,
    },
  }
}

async function runPlan(
  tabId: number,
  target: string,
  build: (info: PlanTargetInfo) => InputPlan,
): Promise<Record<string, unknown>> {
  const measured = await measurePlanTargetIn(tabId, target)
  if ('success' in measured && measured.success === false) return measured as unknown as Record<string, unknown>
  const { info } = measured as { info: PlanTargetInfo; tagName: string }

  const plan = build(info)
  const frameId = info.frameId === 0 ? undefined : info.frameId
  const pointer = isAiPointerEnabled()
    ? { id: AI_POINTER_ID, zIndex: AI_POINTER_Z_INDEX, markup: AI_POINTER_MARKUP }
    : null

  // Reason: an iframe target splits the two timelines — the pointer belongs to
  // the top frame, the events must be frame-local. Offsetting the cues into
  // top-frame coordinates and animating them separately is the trade the iframe
  // short hop already accepts; there is too little of it left to drift visibly.
  if (frameId !== undefined && pointer) {
    const offset = await frameViewportOffset(tabId, info.frameId)
    if (offset.success) {
      const shifted = plan.cues.map(c => (
        c.point ? { ...c, point: { x: c.point.x + offset.x, y: c.point.y + offset.y } } : c
      ))
      animatePointerInTopFrame(tabId, shifted, { x: plan.from.x + offset.x, y: plan.from.y + offset.y })
    }
  }

  // Reason: executeScript awaits an async injected function, so the runtime
  // result is the resolved value — execInTab's synchronous signature needs the
  // promise unwrapped by hand.
  const result = await execInTab<InterpretResult>(
    tabId,
    interpretPlan as unknown as (...args: never[]) => InterpretResult,
    [target, JSON.stringify(plan), info.docId, frameId === undefined ? pointer : null],
    frameId,
  )
  if (!result.success) return result as unknown as Record<string, unknown>

  // Reason: only a dispatched plan moved the cursor. Recording endState after a
  // failure would leave the next action animating from a position never reached.
  // A stale document discards it instead — the coordinates no longer mean
  // anything in the replaced page.
  if (!result.staleDoc && info.frameId === 0) {
    // Reason: the planner is deterministic and cannot read the clock, so
    // endState.updatedAt is a plan-local counter. The TTL needs wall time.
    setMouseState(ownerOf(tabId) ?? ANON_SESSION, tabId, {
      ...plan.endState, docId: info.docId, updatedAt: Date.now(),
    })
  }

  const observed = result.observed ? describeObservation(result.observed) : undefined
  return {
    success: true,
    tagName: result.tagName,
    text: result.text,
    ...(result.occludedBy ? { occludedBy: result.occludedBy } : {}),
    ...(observed ? { observed } : {}),
  }
}

// Reason: a target inside an iframe gets a short hop instead of a full
// trajectory. The pointer overlay lives in the top frame while events must be
// dispatched frame-local, and two independent setTimeout timelines share no
// clock — so rather than animate out of sync, the iframe case keeps the events
// correct and gives up the long approach.
function planTimingFor(info: PlanTargetInfo): Partial<Timing> | undefined {
  return info.frameId === 0 ? undefined : { totalMs: 80, maxWaypoints: 3 }
}

// Reason: continuity is the whole point of persisting the position — a second
// click should start where the first ended rather than teleporting back to a
// synthetic origin. approachPoint is only the cold-start fallback, used when the
// service worker was suspended or the document changed underneath us.
function planStartState(tabId: number, info: PlanTargetInfo): MouseState {
  const sessionId = ownerOf(tabId) ?? ANON_SESSION
  // Reason: the map has no frame identity, and an iframe plan is frame-local
  // while a top-frame plan is not. Sharing one slot across both would animate
  // from coordinates measured in a different space, so an iframe target starts
  // cold rather than corrupting the position for whatever runs next.
  const prior = info.frameId === 0 ? getMouseState(sessionId, tabId, info.docId) : null
  if (prior) return prior
  const from = approachPoint(info.to)
  return { ...initialMouseState(), x: from.x, y: from.y, docId: info.docId }
}

async function inputEngineEnabled(): Promise<boolean> {
  const config = await loadConfig()
  return config?.labInputEngine !== false
}

// --- Handlers ---

// Reason: CDP timing is driven from the service worker, so it is not subject to
// the page-level timer throttling that applies to a hidden tab's own scripts —
// the projected delays hold even when the target tab is in the background.
async function dispatchCdpPlan(tabId: number, commands: CdpCommand[]): Promise<void> {
  for (const cmd of commands) {
    // Reason: setTimeout is safe here — the in-flight tool call keeps the SW alive.
    if (cmd.delayBeforeMs > 0) await new Promise(r => setTimeout(r, cmd.delayBeforeMs))
    await chrome.debugger.sendCommand({ tabId }, cmd.method, cmd.params)
  }
}

async function handleClick(tabId: number, params: { target: string; doubleClick?: boolean; real?: boolean }) {
  return detectNavigation(tabId, async () => {
    if (!params.real) {
      if (await inputEngineEnabled()) {
        return runPlan(tabId, params.target, info => planClick(planStartState(tabId, info), info.to, {
          doubleClick: params.doubleClick,
          interactive: info.interactive,
          timing: planTimingFor(info),
        }))
      }
      return resolveAndExec(tabId, params.target, 'click', [params.doubleClick ?? false]) as Promise<Record<string, unknown>>
    }

    // Reason: attaching the debugger raises Chrome's "is debugging this browser"
    // banner, which is both intrusive and resizes the viewport under the page.
    // That deserves its own consent rather than riding on the click approval —
    // cached per hostname exactly like the CSP-driven debugger fallback.
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const hostname = tab?.url ? new URL(tab.url).hostname : ''
    if (!hostname || !approvedDebuggerHosts.has(hostname)) {
      const granted = await requestDebuggerConsent(hostname, tabId)
      if (!granted) return { success: false, error: 'Real click needs debugger access. User declined.' }
      if (hostname) approvedDebuggerHosts.add(hostname)
    }

    // Reason: an element below the fold has a negative boundingRect, which used
    // to be handed to CDP verbatim and clicked whatever sat at those coordinates.
    // Scroll first, then measure — scrolling moves the rect.
    const scrolled = await resolveAndExecWithFrame(tabId, params.target, 'scrollIntoView')
    if (!('frameId' in scrolled)) return scrolled

    const located = await resolveAndExecWithFrame(tabId, params.target, 'getElementInfo')
    if (!('frameId' in located)) return located
    const info = located.result as {
      success: boolean
      error?: string
      boundingRect?: { x: number; y: number; width: number; height: number }
      probe?: RenderProbe
    }
    if (!info.success || !info.boundingRect) return { success: false, error: info.error ?? 'Could not locate element' }

    // Reason: same gate as the synthetic path — a real click is more expensive
    // (debugger attach, banner) and no more able to reach an unrendered box.
    // scrolled is true here because the scrollIntoView above already ran, which
    // is what makes the off-page verdict meaningful.
    if (info.probe) {
      const reason = hiddenReason({ ...info.probe, scrolled: true })
      if (reason) return { success: false, error: describeHidden(info.probe, reason, params.target) }
    }

    const offset = await frameViewportOffset(tabId, located.frameId)
    if (!offset.success) return offset

    const { x, y, width, height } = info.boundingRect
    const to = {
      x: Math.round(offset.x + x + width / 2),
      y: Math.round(offset.y + y + height / 2),
    }

    // Reason: the trajectory is what makes CDP worth its cost here — real
    // mouseMoved events drive genuine hit-testing and CSS :hover, which no
    // synthetic event can trigger. CDP coordinates are top-level viewport
    // coordinates, the same space the state map and the pointer overlay use, so
    // continuity carries across the two backends without conversion.
    const start = planStartState(tabId, {
      to,
      interactive: true,
      contentEditable: false,
      frameId: located.frameId,
      // Reason: getElementInfo does not fingerprint the document, and paying an
      // extra injection for it is not worth it — the navigation reset hooks
      // already clear the position on a hard nav.
      docId: null,
    })
    const plan = planClick(start, to, {
      doubleClick: params.doubleClick,
      interactive: true,
    })

    // Reason: if debugSession already owns this tab's debugger (Pro mode),
    // reuse it — attaching a second debugger would fail, and detaching in
    // finally would kill the existing debug session (console/network capture).
    const ownsDebugger = debugSession.isAttached() && debugSession.getTabId() === tabId
    const obsFrame = located.frameId === 0 ? undefined : located.frameId
    try {
      if (!ownsDebugger) await chrome.debugger.attach({ tabId }, '1.3')
      // Reason: after attach, not before — the debugger banner resizes the
      // viewport, and the pointer has to animate against the layout the user is
      // actually looking at. Fire-and-forget: the overlay is decoration and must
      // never fail a real click.
      animatePointerInTopFrame(tabId, plan.cues, plan.from)
      // Reason: interpretPlan arms and collects inside its own injection. A CDP
      // dispatch runs here instead, so the same measurements have to bracket it
      // from the outside. Armed after consent so a declined click leaves nothing
      // observing, and in the target's frame so focus and value read correctly.
      const armed = await execInTab<{ ok: true }>(tabId, armObservation, [params.target], obsFrame)
      const armedOk = typeof armed === 'object' && armed !== null && 'ok' in armed
      await dispatchCdpPlan(tabId, toCdpCommands(plan))
      if (located.frameId === 0) {
        setMouseState(ownerOf(tabId) ?? ANON_SESSION, tabId, {
          ...plan.endState, docId: null, updatedAt: Date.now(),
        })
      }
      const collected = armedOk
        ? await execInTab<{
          focusChanged: boolean
          valueChanged: boolean
          domMutated: boolean
        }>(tabId, collectObservation, [params.target], obsFrame)
        : null
      // Reason: defaultPrevented is unobtainable here — the browser dispatches
      // the event, so there is no return value, and a window-level listener
      // would read false whenever a handler calls stopPropagation. urlChanged is
      // already reported as navigatedTo by detectNavigation. describeObservation
      // only renders truthy fields, so both simply do not appear. And if the arm
      // never took, nothing is reported at all — an all-false observation would
      // be indistinguishable from a genuinely inert click.
      const observed = typeof collected === 'object' && collected !== null && 'domMutated' in collected
        ? describeObservation({ ...collected, defaultPrevented: false, urlChanged: false })
        : undefined
      return {
        success: true,
        text: `Real click at (${to.x}, ${to.y})`,
        ...(observed ? { observed } : {}),
      }
    } catch (e) {
      return { success: false, error: `Debugger click failed: ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      if (!ownsDebugger) { try { await chrome.debugger.detach({ tabId }) } catch { /* already detached */ } }
    }
  })
}

async function handleHover(tabId: number, params: { target: string }) {
  if (await inputEngineEnabled()) {
    return runPlan(tabId, params.target, info => planHover(planStartState(tabId, info), info.to, {
      interactive: info.interactive,
      timing: planTimingFor(info),
    }))
  }
  return resolveAndExec(tabId, params.target, 'hover')
}

async function handleType(tabId: number, params: { target: string; text: string; clear?: boolean }) {
  const engine = await inputEngineEnabled()
  return detectNavigation(tabId, () => {
    if (engine) {
      return runPlan(tabId, params.target, info => planType(planStartState(tabId, info), params.text, {
        clear: params.clear ?? true,
        contentEditable: info.contentEditable,
      }))
    }
    return resolveAndExec(tabId, params.target, 'type', [params.text, params.clear ?? true]) as Promise<Record<string, unknown>>
  })
}

async function handleSelect(tabId: number, params: { target: string; value: string }) {
  return detectNavigation(tabId, () =>
    resolveAndExec(tabId, params.target, 'select', [params.value]) as Promise<Record<string, unknown>>)
}

async function handleKeypress(tabId: number, params: {
  key: string; target?: string
  ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean
}) {
  if (!params.target) {
    return execInTab(tabId, (
      key: string, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean,
    ) => {
      const opts: KeyboardEventInit = {
        key, bubbles: true, cancelable: true,
        ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta,
      }
      document.body.dispatchEvent(new KeyboardEvent('keydown', opts))
      document.body.dispatchEvent(new KeyboardEvent('keyup', opts))
      return { success: true }
    }, [
      params.key,
      params.ctrlKey ?? false, params.shiftKey ?? false,
      params.altKey ?? false, params.metaKey ?? false,
    ])
  }
  const mods = {
    ctrl: params.ctrlKey ?? false, shift: params.shiftKey ?? false,
    alt: params.altKey ?? false, meta: params.metaKey ?? false,
  }
  if (await inputEngineEnabled()) {
    return runPlan(tabId, params.target, info => planKeypress(planStartState(tabId, info), params.key, mods))
  }
  return resolveAndExec(tabId, params.target, 'keypress', [
    params.key,
    params.ctrlKey ?? false, params.shiftKey ?? false,
    params.altKey ?? false, params.metaKey ?? false,
  ])
}

async function handleScroll(tabId: number, params: { direction: string; amount?: number; target?: string }) {
  if (!params.target) {
    // Reason: many sites scroll inside an overflow container rather than the
    // document. Walk up from document.elementFromPoint to find the nearest
    // scrollable ancestor, then scroll that. Falls back to window.scrollBy.
    return execInTab(tabId, (direction: string, amount: number) => {
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0

      function findScrollable(): Element | null {
        const cx = window.innerWidth / 2
        const cy = window.innerHeight / 2
        let el = document.elementFromPoint(cx, cy)
        while (el && el !== document.documentElement) {
          const style = getComputedStyle(el)
          const oy = style.overflowY
          const ox = style.overflowX
          const scrollableY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight
          const scrollableX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth
          if (scrollableY || scrollableX) return el
          el = el.parentElement
        }
        return null
      }

      const container = findScrollable()
      if (container) {
        container.scrollBy(dx, dy)
      } else {
        window.scrollBy(dx, dy)
      }
      return { success: true }
    }, [params.direction, params.amount ?? 500])
  }
  return resolveAndExec(tabId, params.target, 'scroll', [params.direction, params.amount ?? 500])
}

// Reason: Service Worker has no DOM — use OffscreenCanvas + createImageBitmap
// to resize and compress screenshots to JPEG, keeping token cost manageable
async function compressDataUrl(dataUrl: string, maxWidth: number, quality: number): Promise<string> {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob)
  let w = bitmap.width
  let h = bitmap.height
  if (w > maxWidth) {
    h = Math.round(h * (maxWidth / w))
    w = maxWidth
  }
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  const buf = await jpegBlob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return 'data:image/jpeg;base64,' + btoa(binary)
}

// Reason: OVERLAY_SELECTOR keeps Sidekick's own UI out of the resolver and the
// DOM snapshot, but a screenshot is composited pixels — no selector can filter
// it after the fact. Visibility is toggled on the hosts instead of removing
// them: it needs no transition to wait out and it inherits into shadow trees,
// so the lock indicator's chase border and its island go dark together. No
// overlay sets inline visibility itself, so removeProperty is a clean restore.
export function setOverlayVisibility(overlaySelector: string, hidden: boolean): { ok: true } {
  for (const el of document.querySelectorAll(overlaySelector)) {
    const style = (el as HTMLElement).style
    if (hidden) style.setProperty('visibility', 'hidden', 'important')
    else style.removeProperty('visibility')
  }
  return { ok: true }
}

// Reason: never rejects — a screenshot must not fail because the overlays could
// not be hidden, and the restore pass is idempotent either way.
function setOverlaysHiddenForCapture(tabId: number, hidden: boolean): Promise<void> {
  return execScript({
    target: { tabId, frameIds: [0] },
    injectImmediately: true,
    func: setOverlayVisibility,
    args: [OVERLAY_SELECTOR, hidden],
  }, 5_000).then(() => {}).catch(() => {})
}

// Reason: captureVisibleTab photographs whichever tab is VISIBLE in the
// window — it takes no tab id. With the operating tab switched to the
// background it would silently return the FOREGROUND tab's pixels and feed
// the model a picture of a page it never touched, so fail visibly instead.
function backgroundedCaptureError(tabId: number, title: string): string {
  const label = title ? ` ("${title}")` : ''
  return [
    `Error: screenshot is impossible right now — the tab being operated on (#${tabId}${label}) is in the background.`,
    'The visible-viewport capture API can only photograph the foreground tab, so retrying will keep failing while it stays backgrounded.',
    'Verify with getPageContent instead, or ask the user to bring that tab to the front if pixels are essential.',
    '',
  ].join('\n')
}

async function handleScreenshot(tabId: number, params: { target?: string; sessionId?: string }) {
  // Reason: gate before any side effects — scrollIntoView and overlay hiding
  // are wasted work on a capture that cannot happen.
  try {
    const opTab = await chrome.tabs.get(tabId)
    if (opTab.active === false) {
      return { success: false, error: backgroundedCaptureError(tabId, opTab.title ?? '') }
    }
  } catch { /* a vanished tab fails at the capture step below with the original error */ }
  if (params.target) {
    const resolveResult = await resolveAndExec(tabId, params.target, 'scrollIntoView')
    if (resolveResult && typeof resolveResult === 'object' && 'success' in resolveResult && !resolveResult.success) {
      return resolveResult
    }
  }
  // Reason: OVERLAY_SELECTOR keeps Sidekick's overlays out of the resolver, the
  // snapshot and the raw HTML, but a screenshot is pixels — the only way to keep
  // them out of the frame is to hide them. Awaited so the pointer's fade and the
  // visibility flip are both in flight before the settle wait absorbs them.
  await Promise.all([hideAiPointer(tabId), setOverlaysHiddenForCapture(tabId, true)])
  // Reason: prior tool actions (click, navigate, scroll) return before the page
  // finishes rendering. Wait 200ms for paint settle. Using setTimeout instead of
  // rAF because rAF is suspended when the tab is not focused, which would block
  // the screenshot until the user switches back.
  await new Promise<void>(resolve => setTimeout(resolve, 200))
  let dataUrl: string
  try {
    const tab = await chrome.tabs.get(tabId)
    // Reason: the entry guard runs before the settle wait — the user can switch
    // tabs during it, and captureVisibleTab photographs whatever is foreground by
    // then. Re-check so the pixels always belong to the tab the result names.
    if (tab.active === false) {
      return { success: false, error: backgroundedCaptureError(tabId, tab.title ?? '') }
    }
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 })
  } finally {
    // Reason: without this the lock indicator would stay invisible for the rest
    // of the turn, silently dropping the only in-page signal that Sidekick is
    // driving the tab.
    await setOverlaysHiddenForCapture(tabId, false)
  }
  const compressed = await compressDataUrl(dataUrl, 1280, 0.7)
  let message = 'Screenshot captured'
  if (params.sessionId) {
    const cfg = await loadConfig()
    if (cfg?.labImageFs) {
      // Reason: strip the data URL header and unpack base64 to a latin1 byte
      // string — the VFS convention for binary content.
      const latin1 = atob(compressed.slice(compressed.indexOf(',') + 1))
      const path = await mirrorScreenshotToVfs(params.sessionId, latin1)
      // Reason: the model must know mirrors are a ring — older Saved paths from
      // previous tool results go stale after pruning.
      if (path) message += `. Saved: ${path} (${Math.round(latin1.length / 1024)}KB, only the ${KEEP_SCREENSHOTS} newest screenshots are kept)`
    }
  }
  return { success: true, message, dataUrl: compressed }
}

async function handleWait(tabId: number, params: { target?: string; timeout?: number; duration?: number; maxMs?: number }) {
  if (params.duration) {
    // Reason: cap duration so a runaway model can't hang the tab script for minutes
    const ms = Math.min(params.duration, 30_000)
    // Reason: the sleep legitimately runs the full duration — give the deadline
    // headroom so it never races the wait it is meant to protect.
    return await execInTab(tabId, (ms: number) => new Promise<{ success: boolean }>(resolve => {
      setTimeout(() => resolve({ success: true }), ms)
    }), [ms], undefined, ms + INJECT_HEADROOM_MS)
  }

  if (params.target) {
    // Reason: an instant presence check, not a wait — the loop lives in the SW
    // below. Putting the loop in here instead meant one copy per frame under
    // allFrames, and allFrames only settles once EVERY copy returns, so an
    // iframe that never contains the target polled to the full timeout and set
    // the total. An element already on the page still cost ~1x timeout.
    const findNow = (target: string) => {
      try {
        if (document.querySelector(target)) return { found: true }
      } catch { /* not a valid selector */ }

      const candidates = Array.from(
        document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex], label, summary'),
      ) as HTMLElement[]
      const lower = target.toLowerCase()
      for (const el of candidates) {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue
        const searchable = [
          (el.textContent ?? '').trim(),
          el.getAttribute('aria-label') ?? '',
          (el as HTMLInputElement).placeholder ?? '',
          el.getAttribute('title') ?? '',
        ].map(s => s.toLowerCase())
        if (searchable.some(s => s.includes(lower))) return { found: true }
      }
      return { found: false }
    }

    const requested = params.timeout ?? 3000
    // Reason: only the bash path has a budget to respect, and it passes maxMs.
    // The native wait tool has none, so it is bounded by the same sanity ceiling
    // as the duration branch rather than by a made-up "bash budget".
    const timeout = Math.min(requested, params.maxMs ?? 30_000)
    const deadlineAt = Date.now() + timeout
    for (;;) {
      const remaining = deadlineAt - Date.now()
      // Reason: clamping the attempt to what is left is what keeps the total
      // inside the budget. A fixed per-attempt deadline could start just before
      // the end and add its full length on top, overshooting the very budget
      // this loop exists to respect.
      const attemptMs = Math.max(1, Math.min(WAIT_ATTEMPT_DEADLINE_MS, remaining))
      let results: Awaited<ReturnType<typeof execScript<{ found: boolean }>>>
      try {
        results = await execScript<{ found: boolean }>({
          target: { tabId, allFrames: true },
          injectImmediately: true,
          func: findNow,
          args: [params.target],
        }, attemptMs)
      } catch (e) {
        if (e instanceof ScriptDeadlineError) {
          // Reason: a slow injection must not end the wait — a page that commits
          // at ~2s is exactly what a 4s wait is for. Keep retrying while budget
          // remains; once it is gone, the injection never landed even once, and
          // nobody told us why, so this is where a guess is all we have.
          if (Date.now() >= deadlineAt) {
            return { success: false, error: `Wait deadline exceeded: the tab did not accept the check script within ${timeout}ms. It is probably still navigating — wait for the load to settle, then retry.` }
          }
          continue
        }
        // Reason: Chrome's own message names the cause ("is showing error page",
        // "Cannot access contents of the page", "was removed"). Adding "maybe it
        // is still navigating" on top would contradict it — a refused connection
        // will never settle, so telling the model to wait is actively wrong.
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
      if (results?.some(r => r.result?.found)) return { success: true }
      if (Date.now() >= deadlineAt) break
      await new Promise(r => setTimeout(r, Math.min(WAIT_POLL_MS, deadlineAt - Date.now())))
    }
    // Reason: name the clamp — a silently shortened wait would read as a flaky
    // page rather than a budget the caller can work around.
    const capped = requested > timeout ? ` (requested ${requested}ms, capped to ${timeout}ms by the caller's budget)` : ''
    return { success: false, error: `Timeout: "${params.target}" not found within ${timeout}ms${capped}` }
  }

  return { success: false, error: 'Either target or duration is required' }
}

// --- Content frame ranking ---

export interface FrameMetrics {
  frameId: number
  url: string
  title: string
  textLen: number
  htmlLen: number
  area: number
  hasSemantic: boolean
}

// Reason: text volume is the primary signal — the frame holding the document
// almost always has the most readable text, and measuring text (not markup)
// naturally demotes markup-heavy, text-poor ad slots. Three modifiers cover the
// cases where volume alone misleads. Kept pure so the ranking is unit-testable.
const MIN_TEXT_LEN = 50
// Reason: article/main/contenteditable marks a real content root — the only
// signal that rescues "app shell has more menu text than the document iframe".
const SEMANTIC_BOOST = 2.0
// Reason: the document you navigated to is the subject, so it outranks a larger
// embedded frame (a long comments iframe must not beat a shorter article).
const TOP_FRAME_BOOST = 1.5
const SMALL_FRAME_PENALTY = 0.3
// Reason: standard ad slots are 65k-96k px² (728x90, 300x250, 160x600), so the
// cutoff sits above them while staying well below any real content viewport.
const SMALL_FRAME_AREA = 100_000

export function scoreFrame(m: FrameMetrics): number {
  if (m.textLen < MIN_TEXT_LEN) return 0
  let score = m.textLen
  if (m.hasSemantic) score *= SEMANTIC_BOOST
  if (m.frameId === 0) score *= TOP_FRAME_BOOST
  if (m.area < SMALL_FRAME_AREA) score *= SMALL_FRAME_PENALTY
  return score
}

// Reason: ordering is score → text length → frameId so the pick is reproducible.
export function pickContentFrame(
  metrics: FrameMetrics[],
): { winner: FrameMetrics; others: FrameMetrics[] } | null {
  const ranked = metrics
    .map(m => ({ m, score: scoreFrame(m) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.textLen - a.m.textLen || a.m.frameId - b.m.frameId)
  if (!ranked.length) return null
  return { winner: ranked[0].m, others: ranked.slice(1).map(s => s.m) }
}

const FRAME_LIST_LIMIT = 5

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url.slice(0, 40) }
}

// Reason: the model must know the content came from a nested frame and what else
// is available. Nested frames are unreachable by a top-frame CSS selector, so
// they are addressed by numeric frameId — resolveFrameId accepts both forms.
export function buildFrameNote(winner: FrameMetrics, others: FrameMetrics[]): string | undefined {
  const lines: string[] = []
  if (winner.frameId !== 0) lines.push(`[content from frame ${winner.frameId} · ${hostOf(winner.url)}]`)
  if (others.length) {
    const suffix = others.length > FRAME_LIST_LIMIT ? ` (top ${FRAME_LIST_LIMIT} of ${others.length})` : ''
    lines.push(`[other frames with content${suffix} · read one with frame=<id>]`)
    for (const m of others.slice(0, FRAME_LIST_LIMIT)) {
      lines.push(`- ${m.frameId} · ${hostOf(m.url)} · ${Math.round(m.textLen / 100) / 10}KB text`)
    }
  }
  return lines.length ? lines.join('\n') : undefined
}

const TOP_FRAME_LOAD_CAP_MS = 3000

// Reason: sites watermark text with invisible unicode (observed: ~40 chars of
// U+200B/U+202C/U+2061-2063 prefixed to a DingTalk doc title — a per-user
// tracking mark). They waste tokens, follow summaries out of the product, and
// trip scanMemoryContent when the model saves such text to memory. Stripped set
// is strictly zero-collateral: U+200C (ZWNJ, Persian/Arabic orthography) and
// U+200D (ZWJ, emoji sequences) are deliberately kept — removing them corrupts
// real text — at the cost of leaving a residue if a watermark uses them.
const INVISIBLE_CHARS_RE = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g

export function stripInvisibleChars(s: string): string {
  return s.replace(INVISIBLE_CHARS_RE, '')
}

// Reason: injectImmediately means the injection no longer waits for the top
// frame, so gate on tab.status instead — the native signal for the top-level
// document's load state. Capped: a page with an endlessly pending subresource
// can sit in 'loading' forever, and extraction must still proceed.
async function awaitTopFrameLoaded(tabId: number, capMs = TOP_FRAME_LOAD_CAP_MS): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete') return
  } catch { return }
  await new Promise<void>(resolve => {
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve() }, capMs)
  })
}

async function grabFrameHtml(tabId: number, frameId: number) {
  const res = await execScript<{ title: string; url: string; html: string } | null>({
    target: { tabId, frameIds: [frameId] },
    injectImmediately: true,
    func: () => {
      const body = document.body
      if (!body) return null
      return { title: document.title, url: location.href, html: body.innerHTML.slice(0, 500000) }
    },
  })
  const raw = res?.[0]?.result ?? null
  if (!raw) return null
  // Reason: strip in the SW after extraction (not inside the injected function)
  // so the regex lives in one exported, unit-testable place.
  return { ...raw, title: stripInvisibleChars(raw.title), html: stripInvisibleChars(raw.html) }
}

async function handleGetPageContent(tabId: number, params: { frame?: string }) {
  try {
    // Reason: if a specific frame is requested, resolve its frameId first
    if (params.frame) {
      const frameId = await resolveFrameId(tabId, params.frame)
      if (typeof frameId === 'object') return frameId
      const result = await grabFrameHtml(tabId, frameId)
      if (!result) return { success: false, error: `No content from frame "${params.frame}"` }
      return { success: true, ...result, frameId }
    }

    await awaitTopFrameLoaded(tabId)

    // Reason: measure every frame first (a few hundred bytes total), then fetch
    // HTML from the winner alone. The old design concatenated every frame's HTML
    // into a pseudo-document with text headers, which is neither valid HTML nor
    // clean text, gave ad iframes equal footing with the real content, and paid
    // full serialization cost for frames that were never going to be used.
    // The literal 50 is inlined because injected functions cannot close over
    // module scope — it mirrors MIN_TEXT_LEN.
    const probe = await execScript<Omit<FrameMetrics, 'frameId'> | null>({
      target: { tabId, allFrames: true },
      // Reason: an off-screen lazy iframe never reaches document_idle, so waiting
      // for it would hang the whole call — read what each frame has right now.
      // Frames without a committed document return null and drop out of ranking.
      injectImmediately: true,
      func: () => {
        const body = document.body
        if (!body) return null
        const text = body.innerText ?? ''
        if (text.length < 50) return null
        return {
          url: location.href,
          title: document.title,
          textLen: text.length,
          htmlLen: body.innerHTML.length,
          area: innerWidth * innerHeight,
          hasSemantic: !!document.querySelector('[contenteditable="true"],main,article,[role="document"]'),
        }
      },
    })
    if (!probe?.length) return { success: false, error: 'Failed to extract page content' }

    const metrics: FrameMetrics[] = probe
      .filter(r => r.result)
      .map(r => ({ frameId: r.frameId ?? 0, ...r.result! }))
    const picked = pickContentFrame(metrics)
    if (!picked) return { success: false, error: 'No readable content found on page' }

    const { winner, others } = picked
    let content = await grabFrameHtml(tabId, winner.frameId)
    let frameId = winner.frameId
    // Reason: the page can navigate between the two phases, destroying the frame
    // we picked — fall back to the top frame rather than failing the whole read.
    if (!content && winner.frameId !== 0) {
      content = await grabFrameHtml(tabId, 0)
      frameId = 0
    }
    if (!content) return { success: false, error: 'No readable content found on page' }

    return {
      success: true,
      ...content,
      frameId,
      frameCount: metrics.length,
      frameNote: buildFrameNote({ ...winner, frameId }, others),
    }
  } catch (e) {
    return { success: false, error: `Content extraction failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function handleNavigate(tabId: number, params: { url: string }) {
  try {
    resetMouseState(ownerOf(tabId) ?? ANON_SESSION, tabId)
    await chrome.tabs.update(tabId, { url: params.url })
    // Reason: chrome.tabs.update resolves before the page loads — wait for
    // the tab to finish loading so subsequent tools see the new page content
    const loaded = await new Promise<boolean>((resolve) => {
      const onUpdated = (id: number, info: { status?: string }) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated)
          resolve(true)
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated)
      // Reason: capped below the 5s Chat bash budget. A longer wait cannot help
      // — the budget would abort the whole command first, and the model would
      // read a generic abort instead of learning the page is still loading.
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(false) }, NAV_SETTLE_MS)
    })
    // Reason: returning bare success on a still-pending frame is what sets up
    // the next command to fail — a frame mid-navigation rejects injection, so a
    // following page-wait can never land its poll script. Say it out loud.
    if (!loaded) return { success: true, pending: true, message: `Navigation started, but the page did not finish loading within ${NAV_SETTLE_MS}ms. It is still loading — re-read the page before acting on it, and expect element waits to fail until it settles.` }
    return { success: true }
  } catch (e) {
    return { success: false, error: `Navigation failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function handleGetElementInfo(tabId: number, params: { target: string }) {
  return resolveAndExec(tabId, params.target, 'getElementInfo')
}

async function handleFindElement(tabId: number, params: { text?: string; selector?: string; attr?: string; attrValue?: string }) {
  const results = await execScript({
    target: { tabId, allFrames: true },
    injectImmediately: true,
    func: (text: string | null, selector: string | null, attr: string | null, attrValue: string | null) => {
      function buildSelector(el: Element): string {
        const tag = el.tagName.toLowerCase()
        if (el.id) return `${tag}#${el.id}`
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : ''
        const parent = el.parentElement
        if (!parent) return tag + cls
        const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName)
        const idx = siblings.length > 1 ? `:nth-child(${Array.from(parent.children).indexOf(el) + 1})` : ''
        return tag + cls + idx
      }

      function getPath(el: Element): string {
        const parts: string[] = []
        let cur: Element | null = el
        while (cur && cur !== document.body) {
          parts.unshift(buildSelector(cur))
          cur = cur.parentElement
        }
        return '/' + parts.join('/')
      }

      let elements: Element[]

      if (selector) {
        elements = Array.from(document.querySelectorAll(selector))
      } else {
        elements = Array.from(document.querySelectorAll('*'))
      }

      const matches: Array<{ path: string; tag: string; text: string; selector: string; visible: boolean }> = []

      for (const el of elements) {
        const htmlEl = el as HTMLElement
        const rect = htmlEl.getBoundingClientRect?.()
        const style = window.getComputedStyle(htmlEl)
        const visible = rect && rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden'

        if (text) {
          const elText = (htmlEl.textContent ?? '').trim()
          const ariaLabel = el.getAttribute('aria-label') ?? ''
          const placeholder = (htmlEl as HTMLInputElement).placeholder ?? ''
          const title = el.getAttribute('title') ?? ''
          const lower = text.toLowerCase()
          const searchable = [elText, ariaLabel, placeholder, title].map(s => s.toLowerCase())
          if (!searchable.some(s => s.includes(lower))) continue
          // Prefer elements whose direct text matches (not just inherited)
          const directText = Array.from(htmlEl.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent?.trim() ?? '')
            .join('')
          const hasDirectMatch = directText.toLowerCase().includes(lower)
          if (!hasDirectMatch && htmlEl.children.length > 0) {
            // Skip container elements that only match via child text
            const childMatch = Array.from(htmlEl.children).some(child =>
              (child.textContent ?? '').toLowerCase().includes(lower)
            )
            if (childMatch) continue
          }
        }

        if (attr && attrValue) {
          const val = el.getAttribute(attr)
          if (!val || !val.toLowerCase().includes(attrValue.toLowerCase())) continue
        } else if (attr) {
          if (!el.hasAttribute(attr)) continue
        }

        matches.push({
          path: getPath(el),
          tag: el.tagName.toLowerCase(),
          text: (htmlEl.textContent ?? '').trim().slice(0, 60),
          selector: buildSelector(el),
          visible: !!visible,
        })

        if (matches.length >= 30) break
      }

      return matches
    },
    args: [params.text ?? null, params.selector ?? null, params.attr ?? null, params.attrValue ?? null],
  }) as ScriptResult<Array<{ path: string; tag: string; text: string; selector: string; visible: boolean }>>

  if (!results?.length) return { success: false, error: 'No frames returned results' }

  const allMatches = results.flatMap(r => r.result ?? [])
  if (!allMatches.length) {
    const query = params.text || params.selector || params.attr || 'unknown'
    return { success: false, error: `No elements found matching "${query}"` }
  }

  const lines = allMatches.map(m =>
    `${m.visible ? '✓' : '✗'} ${m.path}  ${m.tag} "${m.text}"  → ${m.selector}`
  )
  const selectors = allMatches.filter(m => m.visible).map(m => m.selector)
  return { success: true, output: lines.join('\n'), selectors, count: allMatches.length }
}

const CSP_FAILURE_MARKER = 'Script did not execute'

// Reason: completion values live only at the program/eval level and never
// survive function bodies, while top-level await parses only inside a
// function body — the two never intersect. Route payload by compile probes
// so each form executes at most once: AsyncFunction construction is a
// side-effect-free parse probe for expressions and top-level await, bare
// eval keeps statement completion values, AsyncFunction body covers
// explicit return. Known window: a statement payload throwing a runtime
// SyntaxError (e.g. JSON.parse) runs in both the eval and the function
// tier — eval has no compile-only probe for program grammar. The bare-eval
// tier runs payload with this wrapper's scope chain (direct eval is how the
// console shadow reaches it), so internals stay __-prefixed.
// Local `console` shadow captures logs without touching the global console.
export function buildReplWrapper(code: string, async?: boolean, timeoutMs?: number): string {
  const consoleDef =
    `var __logs=[];` +
    `var console={` +
      `log:function(){for(var i=0,a=[];i<arguments.length;i++)a.push(typeof arguments[i]==="object"?JSON.stringify(arguments[i]):String(arguments[i]));__logs.push(a.join(" "))},` +
      `warn:function(){console.log.apply(null,arguments)},` +
      `error:function(){for(var i=0,a=[];i<arguments.length;i++)a.push(String(arguments[i]));__logs.push("[error] "+a.join(" "))}` +
    `};`
  // Reason: a string result is already displayable — JSON.stringify would
  // re-wrap it in quotes and escape the content.
  const resultExpr =
    `var __r=__logs.length?__logs.join("\\n"):(__val!==undefined?(typeof __val==="string"?__val:JSON.stringify(__val)):"undefined");` +
    `return {s:1,r:__r}`
  const catchBlock = `catch(__e){return {s:0,e:String(__e),logs:__logs.length?__logs.join("\\n"):undefined}}`

  if (!async) {
    const codeReturnSync = JSON.stringify("return(" + code + ")")
    const codeRawSync = JSON.stringify(code)
    return `(function(){${consoleDef}try{var __val,__f;` +
      `try{__f=new Function("console",${codeReturnSync})}catch(__e){if(__e instanceof SyntaxError)__f=null;else throw __e}` +
      `if(__f)__val=__f(console);else{` +
        `try{__val=eval(${codeRawSync})}` +
        `catch(__e2){if(__e2 instanceof SyntaxError){__val=(new Function("console",${codeRawSync}))(console)}else throw __e2}` +
      `}` +
      `${resultExpr}}${catchBlock}})()`
  }

  const tm = timeoutMs ?? 5000
  const codeReturn = JSON.stringify("return(" + code + ")")
  const codeRaw = JSON.stringify(code)
  return `(async function(){${consoleDef}try{var __val;` +
    `await Promise.race([(async function(){` +
      `var __AF=Object.getPrototypeOf(async function(){}).constructor,__f;` +
      `try{__f=new __AF("console",${codeReturn})}catch(__e){if(__e instanceof SyntaxError)__f=null;else throw __e}` +
      `if(__f)__val=await __f(console);else{` +
        `try{__val=eval(${codeRaw})}` +
        `catch(__e2){if(__e2 instanceof SyntaxError){__val=await new __AF("console",${codeRaw})(console)}else throw __e2}` +
      `}` +
      `if(__val instanceof Promise)__val=await __val` +
    `})(),new Promise(function(_,rej){setTimeout(function(){rej(new Error("Async timeout (${tm}ms)"))},${tm})})]);` +
    `${resultExpr}}${catchBlock}})()`
}

async function executeViaScriptTag(tabId: number, code: string, frameIds?: number[]) {
  const target: Record<string, unknown> = { tabId }
  if (frameIds) target.frameIds = frameIds
  const wrappedCode = buildReplWrapper(code)
  const results: ScriptResult<{ success: boolean; result?: string; error?: string }> =
    await (chrome.scripting.executeScript as unknown as ExecuteScriptFn)({
      target,
      world: 'MAIN',
      func: (wrapped: string) => {
        const key = '__sidekick_' + Date.now() + '_' + Math.random().toString(36).slice(2)
        const script = document.createElement('script')
        script.textContent = `window["${key}"]=${wrapped}`
        document.documentElement.appendChild(script)
        script.remove()
        const w = window as unknown as Record<string, unknown>
        const r = w[key] as { s: number; r?: string; e?: string; logs?: string } | undefined
        delete w[key]
        if (!r) return { success: false, error: 'Script did not execute (page CSP may block inline scripts)' }
        if (r.s) return { success: true, result: r.r }
        return { success: false, error: r.e, result: r.logs }
      },
      args: [wrappedCode],
    })
  if (!results?.length) return { success: false, error: 'executeScript returned no results' }
  return results[0].result
}

// Reason: async-capable path — uses chrome.scripting.executeScript with async func
// instead of <script> tag injection. world: 'MAIN' gives access to page globals;
// async func lets chrome.scripting await the Promise before returning.
async function executeViaEval(tabId: number, code: string, timeoutMs?: number, frameIds?: number[]) {
  const target: Record<string, unknown> = { tabId }
  if (frameIds) target.frameIds = frameIds
  const wrappedCode = buildReplWrapper(code, true, timeoutMs)
  const results: ScriptResult<{ success: boolean; result?: string; error?: string }> =
    await (chrome.scripting.executeScript as unknown as ExecuteScriptFn)({
      target,
      world: 'MAIN',
      func: async (wrapped: string) => {
        try {
          const r = await (0, eval)(wrapped) as { s: number; r?: string; e?: string; logs?: string } | undefined
          if (!r) return { success: false, error: 'Script did not execute (page CSP may block eval)' }
          if (r.s) return { success: true, result: r.r }
          return { success: false, error: r.e, result: r.logs }
        } catch (e) {
          return { success: false, error: `Script did not execute (page CSP may block eval): ${e}` }
        }
      },
      args: [wrappedCode],
    })
  if (!results?.length) return { success: false, error: 'executeScript returned no results' }
  return results[0].result
}

async function executeViaDebugger(tabId: number, code: string, async?: boolean, timeoutMs?: number) {
  const wrappedCode = buildReplWrapper(code, async, timeoutMs)
  const ownsDebugger = debugSession.isAttached() && debugSession.getTabId() === tabId
  if (!ownsDebugger) await chrome.debugger.attach({ tabId }, '1.3')
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: wrappedCode,
      returnByValue: true,
      ...(async ? { awaitPromise: true } : {}),
    }) as { result?: { value?: { s: number; r?: string; e?: string } } }
    const val = res?.result?.value
    if (!val) return { success: true, result: 'undefined' }
    if (val.s) return { success: true, result: val.r }
    return { success: false, error: val.e }
  } catch (e) {
    return { success: false, error: String(e) }
  } finally {
    if (!ownsDebugger) { try { await chrome.debugger.detach({ tabId }) } catch { /* already detached */ } }
  }
}

// Reason: with an offscreen-hosted kernel the panel may be closed mid-turn —
// consent requests pend (retry every 3s) until a panel answers or the 5min
// deadline rejects. "Receiving end does not exist" is the only retried case;
// an explicit user answer (or panel-side silence) is returned immediately.
// setTimeout is acceptable here: the in-flight tool call keeps the SW alive,
// and if Chrome kills it anyway the caller's promise dies with it (= deny).
const CONSENT_PEND_MS = 5 * 60_000
const CONSENT_RETRY_MS = 3_000
async function sendConsentRequest(msg: Record<string, unknown>): Promise<{ granted?: boolean; alwaysAllow?: boolean } | null> {
  const deadline = Date.now() + CONSENT_PEND_MS
  for (;;) {
    try {
      return await chrome.runtime.sendMessage(msg)
    } catch {
      if (Date.now() + CONSENT_RETRY_MS > deadline) return null
      await new Promise(r => setTimeout(r, CONSENT_RETRY_MS))
    }
  }
}

async function requestDebuggerConsent(hostname: string, tabId: number): Promise<boolean> {
  const config = await loadConfig()
  if (config?.securityLevel === 'permissive' || config?.yoloMode) return true
  try {
    const tab = await chrome.tabs.get(tabId)
    const response = await sendConsentRequest({
      type: 'request-debugger-consent',
      hostname,
      windowId: tab.windowId,
    })
    return response?.granted === true
  } catch {
    return false
  }
}

// Reason: resolve an iframe CSS selector to a frameId by querying all frames
// and checking which one's parent document has a matching iframe element
export async function resolveFrameId(tabId: number, frameSelector: string): Promise<number | ExecFailure> {
  // Reason: nested frames cannot be reached by a top-frame CSS selector, so the
  // frame listing addresses them by numeric frameId — accept "7" and "#7"
  // directly. Neither form is a valid CSS selector, so there is no ambiguity.
  const numeric = /^#?(\d+)$/.exec(frameSelector.trim())
  if (numeric) {
    const id = Number(numeric[1])
    if (id === 0) return 0
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    if (!frames?.some(f => f.frameId === id)) {
      return { success: false, error: `No frame with id ${id} on this page` }
    }
    return id
  }
  const results: ScriptResult<number | null> = await (chrome.scripting.executeScript as unknown as ExecuteScriptFn)({
    target: { tabId },
    func: (sel: string) => {
      const iframe = document.querySelector(sel) as HTMLIFrameElement | null
      if (!iframe || iframe.tagName !== 'IFRAME') return null
      // Reason: chrome doesn't expose frameId from DOM directly — use
      // webNavigation.getAllFrames and match by src URL
      return -1
    },
    args: [frameSelector],
  })
  if (!results?.[0]?.result && results?.[0]?.result !== -1) {
    return { success: false, error: `No iframe matching "${frameSelector}" found on page` }
  }
  // Reason: getAllFrames gives us frameId for each frame — match by the iframe's src
  const frames = await chrome.webNavigation.getAllFrames({ tabId })
  if (!frames?.length) return { success: false, error: 'Could not enumerate frames' }

  const srcResult: ScriptResult<string | null> = await (chrome.scripting.executeScript as unknown as ExecuteScriptFn)({
    target: { tabId },
    func: (sel: string) => {
      const iframe = document.querySelector(sel) as HTMLIFrameElement | null
      return iframe?.src || null
    },
    args: [frameSelector],
  })
  const iframeSrc = srcResult?.[0]?.result
  if (!iframeSrc) {
    // Reason: same-origin iframe without src — try matching by parentFrameId=0 order
    const childFrames = frames.filter(f => f.parentFrameId === 0 && f.frameId !== 0)
    if (childFrames.length === 1) return childFrames[0].frameId
    return { success: false, error: `Cannot resolve frameId for "${frameSelector}" (no src attribute and multiple child frames)` }
  }
  // Reason: a top-document selector can only address direct children; duplicate URLs must never silently select a different iframe.
  const children = frames.filter(f => f.parentFrameId === 0 && f.frameId !== 0)
  const exact = children.filter(f => f.url === iframeSrc)
  if (exact.length === 1) return exact[0].frameId
  if (exact.length > 1) return { success: false, error: 'Multiple frames match this URL; use an explicit numeric frameId' }
  // Reason: retain redirected-src compatibility only when the pathname identifies one child unambiguously.
  try {
    const pathname = new URL(iframeSrc).pathname
    const partial = children.filter(f => new URL(f.url).pathname === pathname)
    if (partial.length === 1) return partial[0].frameId
    if (partial.length > 1) return { success: false, error: 'Multiple frames match this pathname; use an explicit numeric frameId' }
  } catch { /* non-HTTP src (about:blank, data:, etc.) */ }
  return { success: false, error: `No frame found with URL matching "${iframeSrc}"` }
}

async function handleExecuteJS(tabId: number, params: { code: string; frameSelector?: string; timeoutMs?: number }) {
  let frameIds: number[] | undefined
  if (params.frameSelector) {
    const resolved = await resolveFrameId(tabId, params.frameSelector)
    if (typeof resolved === 'object') return resolved
    frameIds = [resolved]
  }

  const tab = await chrome.tabs.get(tabId)
  const hostname = tab.url ? new URL(tab.url).hostname : ''
  const config = await loadConfig()
  const useAsync = config?.labAsyncScript !== false

  // Reason: Runtime.evaluate runs in the top frame only — failing fast beats
  // silently executing --frame code in the wrong document.
  const FRAME_DEBUGGER_ERROR = 'Debugger-based execution (used on this site due to CSP) evaluates in the top frame only and does not support --frame. Open the frame URL in a tab and run js there instead.'

  if (hostname && approvedDebuggerHosts.has(hostname)) {
    if (frameIds) return { success: false, error: FRAME_DEBUGGER_ERROR }
    return executeViaDebugger(tabId, params.code, useAsync, params.timeoutMs)
  }

  try {
    const result = useAsync
      ? await executeViaEval(tabId, params.code, params.timeoutMs, frameIds)
      : await executeViaScriptTag(tabId, params.code, frameIds)
    if (result && typeof result === 'object' && 'error' in result
        && typeof result.error === 'string' && result.error.includes(CSP_FAILURE_MARKER)) {
      if (frameIds) return { success: false, error: `Script blocked by frame CSP. ${FRAME_DEBUGGER_ERROR}` }
      const granted = await requestDebuggerConsent(hostname, tabId)
      if (!granted) {
        return { success: false, error: `Script blocked by page CSP. User declined debugger fallback.` }
      }
      if (hostname) approvedDebuggerHosts.add(hostname)
      return executeViaDebugger(tabId, params.code, useAsync, params.timeoutMs)
    }
    return result
  } catch (e) {
    return { success: false, error: `executeScript failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function handleDomSnapshot(tabId: number, params: { root?: string; includeAll?: boolean; maxNodes?: number; flat?: boolean }) {
  const MAX_NODES = params.maxNodes ?? 150

  const results = await execScript({
    target: { tabId, allFrames: true },
    injectImmediately: true,
    func: (rootSel: string | null, includeAll: boolean, maxNodes: number, flat: boolean, overlaySelector: string) => {
      const LANDMARKS = new Set(['NAV', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'SECTION', 'ARTICLE', 'FORM', 'DIALOG'])
      const INTERACTIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS'])
      const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox', 'switch'])

      function isOverlay(el: Element): boolean {
        try {
          return !!el.closest(overlaySelector)
        } catch { return false }
      }

      function isRelevant(el: Element): boolean {
        if (isOverlay(el)) return false
        if (includeAll) return true
        const tag = el.tagName
        if (LANDMARKS.has(tag) || INTERACTIVE.has(tag) || tag === 'IFRAME') return true
        const role = el.getAttribute('role')
        if (role && (INTERACTIVE_ROLES.has(role) || role === 'dialog')) return true
        if (el.hasAttribute('tabindex') || el.hasAttribute('onclick') || el.hasAttribute('contenteditable')) return true
        return false
      }

      function isInteractive(el: Element): boolean {
        if (INTERACTIVE.has(el.tagName)) return true
        const role = el.getAttribute('role')
        if (role && INTERACTIVE_ROLES.has(role)) return true
        if (el.hasAttribute('tabindex') || el.hasAttribute('onclick') || el.hasAttribute('contenteditable')) return true
        return false
      }

      // Reason: hidden nodes are marked, not dropped. A collapsed menu's items
      // have to stay indexable or the model cannot express "reveal this, then
      // click it" — it would be reasoning about a page it cannot see. Marking
      // instead tells it the item exists but is not actionable yet. Opacity is
      // deliberately not consulted: an opacity:0 input still hit-tests, and the
      // sr-only pattern makes that the correct thing to click.
      function isRendered(el: Element): boolean {
        const probeFn = (el as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility
        if (typeof probeFn === 'function'
          && !probeFn.call(el, { visibilityProperty: true, contentVisibilityAuto: true, checkVisibilityCSS: true })) {
          return false
        }
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }

      let hiddenCount = 0

      // Reason: a clipped value with no marker reads as a complete one — a cut
      // URL then looks like a real, shorter URL. The marker counts toward the
      // cap, so the result never exceeds max.
      function clip(value: string, max: number): string {
        return value.length <= max ? value : value.slice(0, max - 3) + '...'
      }

      function describe(el: Element): string {
        const tag = el.tagName.toLowerCase()
        const parts: string[] = []
        const id = el.id ? `#${el.id}` : ''
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : ''
        let selector = tag + id + cls
        const role = el.getAttribute('role')
        if (role) selector += `[role="${role}"]`
        parts.push(selector)

        if (tag === 'iframe') {
          const src = el.getAttribute('src')
          if (src) parts.push(`src="${clip(src, 60)}"`)
        } else if (tag === 'input') {
          const type = (el as HTMLInputElement).type
          const ph = (el as HTMLInputElement).placeholder
          parts.push(`type="${type}"`)
          if (ph) parts.push(`"${clip(ph, 30)}"`)
        } else if (tag === 'a') {
          const href = el.getAttribute('href')
          if (href) parts.push(`href="${clip(href, 200)}"`)
        }

        const ariaLabel = el.getAttribute('aria-label')
        if (ariaLabel) {
          parts.push(`"${clip(ariaLabel, 40)}"`)
        } else {
          const text = (el.textContent ?? '').trim()
          if (text && text.length <= 40) parts.push(`"${text}"`)
          else if (text) parts.push(`"${text.slice(0, 37)}..."`)
        }
        if (!isRendered(el)) {
          hiddenCount++
          parts.push('(hidden)')
        }
        return parts.join(' ')
      }

      const root = rootSel ? document.querySelector(rootSel) as HTMLElement | null : document.body
      if (!root) return null

      // Reason: element index map — stored in the isolated world's window so
      // subsequent resolveAndExecInner calls can look up [N] targets.
      const w = self as unknown as { __skIdx?: Map<number, Element> }
      w.__skIdx = new Map()
      let nextIdx = 1

      // Reason: BFS by level. Before processing level i, check if cumulative
      // node count would exceed maxNodes — if so, stop and annotate the last
      // processed level's leaves with direct child counts.
      interface BfsNode { el: Element; indent: number }
      let currentLevel: BfsNode[] = [{ el: root, indent: 0 }]
      const output: Array<{ indent: number; desc: string }> = []
      let truncated = false

      while (currentLevel.length > 0) {
        const nextLevel: BfsNode[] = []

        for (const { el, indent } of currentLevel) {
          const relevant = isRelevant(el)
          const childIndent = relevant ? indent + 1 : indent

          if (relevant) {
            const interactive = isInteractive(el)
            const prefix = interactive ? `[${nextIdx}] ` : ''
            if (interactive) {
              w.__skIdx!.set(nextIdx, el)
              nextIdx++
            }
            output.push({ indent, desc: prefix + describe(el) })
          }

          // Collect children for next level (skip iframe innards)
          if (el.tagName !== 'IFRAME') {
            for (const child of el.children) {
              if (isOverlay(child)) continue
              nextLevel.push({ el: child, indent: childIndent })
            }
          }
        }

        // Reason: maxNodes=0 means unlimited (Infinity can't be serialized via structured clone)
        if (maxNodes > 0 && output.length + nextLevel.length > maxNodes && nextLevel.length > 0) {
          truncated = true
          // Annotate last-level nodes with children counts as hints
          const lastLevelStart = output.length - currentLevel.filter(n => isRelevant(n.el)).length
          for (let i = Math.max(0, lastLevelStart); i < output.length; i++) {
            // Find how many nextLevel nodes descend from this node
            const node = output[i]
            const childCount = nextLevel.filter(n => n.indent === node.indent + 1).length
            if (childCount > 0) {
              output[i] = { ...node, desc: `${node.desc} → ${childCount} children` }
            }
          }
          break
        }

        currentLevel = nextLevel
      }

      const lines: string[] = []
      if (flat) {
        for (const node of output) {
          lines.push(node.desc)
        }
      } else {
        const rootDesc = rootSel ? `[root: ${rootSel}]` : '[document.body]'
        lines.push(rootDesc)
        for (const node of output) {
          lines.push('  '.repeat(node.indent) + node.desc)
        }
      }
      if (truncated) {
        lines.push(`\n⚠ Truncated at ${maxNodes} nodes. Use "root" to zoom into a subtree.`)
      }
      if (hiddenCount > 0 && !flat) {
        lines.push(`\n${hiddenCount} node(s) marked (hidden) are not rendered — clicking or typing into them will be refused. Reveal them first (hover/click the control that opens them).`)
      }
      if (!flat) lines.push(`\n${output.length} nodes${truncated ? ' (partial)' : ''}`)
      return { snapshot: lines.join('\n'), frameUrl: location.href }
    },
    args: [params.root || null, params.includeAll ?? false, MAX_NODES > 1000000 ? 0 : MAX_NODES, params.flat ?? false, OVERLAY_SELECTOR],
  }) as ScriptResult<{ snapshot: string; frameUrl: string } | null>

  if (!results?.length) return { success: false, error: 'No frames returned results' }

  const parts: string[] = []
  for (const r of results) {
    if (!r.result) continue
    const isTop = r.frameId === 0 || r.frameId === undefined
    if (isTop) {
      parts.unshift(r.result.snapshot)
    } else {
      parts.push(`\n--- iframe: ${r.result.frameUrl.slice(0, 80)} ---\n${r.result.snapshot}`)
    }
  }
  if (!parts.length) {
    const errMsg = params.root ? `No element matching "${params.root}" found` : 'No content available'
    return { success: false, error: errMsg }
  }
  return { success: true, snapshot: parts.join('\n') }
}

type Handler = (tabId: number, params: Record<string, unknown>) => Promise<unknown>

async function sessionIsPro(sessionId: string): Promise<boolean> {
  try {
    const sessions = await loadSessionIndex()
    const session = sessions.find(s => s.id === sessionId)
    return (session?.mode ?? 'chat') === 'pro'
  } catch {
    return false
  }
}

async function handleBash(tabId: number, params: { command: string; sessionId?: string }) {
  const sessionId = (params.sessionId as string) || 'default'
  return execBash(sessionId, tabId, params.command, await sessionIsPro(sessionId))
}

const handlers: Record<string, Handler> = {
  click: handleClick as Handler,
  hover: handleHover as Handler,
  type: handleType as Handler,
  select: handleSelect as Handler,
  keypress: handleKeypress as Handler,
  scroll: handleScroll as Handler,
  screenshot: handleScreenshot as Handler,
  wait: handleWait as Handler,
  getElementInfo: handleGetElementInfo as Handler,
  domSnapshot: handleDomSnapshot as Handler,
  navigate: handleNavigate as Handler,
  getPageContent: handleGetPageContent as Handler,
  executeJS: handleExecuteJS as Handler,
  bash: handleBash as Handler,
}

// Reason: exported for shell-commands.ts to call handlers directly
export {
  execInTab,
  handleClick, handleHover, handleType, handleSelect, handleKeypress,
  handleScroll, handleScreenshot, handleWait, handleGetElementInfo,
  handleFindElement, handleDomSnapshot, handleNavigate, handleGetPageContent,
  handleExecuteJS,
}

// Reason: wait is read-only (DOM polling / fixed sleep) — excluded from consent
const WRITE_TOOLS = new Set(['click', 'hover', 'type', 'select', 'keypress', 'scroll', 'navigate', 'executeJS'])
const ELEMENT_ACTIONS = new Set(['click', 'hover', 'type', 'select', 'keypress'])

function summarizeAction(_action: string, params: Record<string, unknown>): string {
  return (params.target as string) || (params.url as string) || (params.code as string) || ''
}

type ScriptResultAny = Array<{ result: unknown; frameId?: number }>

async function highlightConsentTarget(tabId: number, target: string): Promise<string | null> {
  try {
    await ensureResolver(tabId)
    const results = await (chrome.scripting.executeScript as unknown as ExecuteScriptFn)({
      target: { tabId },
      func: pickerScript,
      args: ['highlight', target],
    }) as ScriptResultAny
    return (results?.[0]?.result as string) ?? null
  } catch { return null }
}

async function clearConsentHighlight(tabId: number): Promise<void> {
  try {
    await (chrome.scripting.executeScript as unknown as ExecuteScriptFn)({
      target: { tabId },
      func: pickerScript,
      args: ['clear'],
    })
  } catch { /* best effort */ }
}

export async function requireConsent(
  action: string, detail: string, tabId: number, highlight?: { tabId: number; target: string },
): Promise<boolean> {
  const config = await loadConfig()
  if (config?.securityLevel === 'permissive' || config?.yoloMode) return true

  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return false
  }

  // Reason: site-level exemption only for interaction/navigation tools on real
  // web origins — execution class (js) and tab management always confirm
  const origin = SITE_ALLOWABLE_TOOLS.has(action) && tab.url ? siteOriginOf(tab.url) : null
  if (origin && await isSiteAllowed(origin, action)) return true

  let resolvedDetail = detail
  if (highlight) {
    const desc = await highlightConsentTarget(highlight.tabId, highlight.target)
    if (desc) {
      resolvedDetail = detail === highlight.target
        ? desc
        : detail.replace(highlight.target, desc)
    }
  }

  try {
    const response = await sendConsentRequest({
      type: 'request-action-consent',
      action,
      detail: resolvedDetail,
      windowId: tab.windowId,
      origin: origin ?? undefined,
    })
    const granted = response?.granted === true
    if (granted && response?.alwaysAllow === true && origin) {
      await grantSitePermission(origin)
    }
    return granted
  } catch {
    return false
  } finally {
    if (highlight) clearConsentHighlight(highlight.tabId)
  }
}

export async function handleToolMessage(
  type: string, tabId: number, params: Record<string, unknown>,
): Promise<unknown> {
  const toolName = type.replace('tool:', '')
  const handler = handlers[toolName]
  if (!handler) return { success: false, error: `Unknown tool: ${toolName}` }

  if (WRITE_TOOLS.has(toolName)) {
    const target = params.target as string | undefined
    const hl = ELEMENT_ACTIONS.has(toolName) && target ? { tabId, target } : undefined
    const granted = await requireConsent(toolName, summarizeAction(toolName, params), tabId, hl)
    if (!granted) return { success: false, error: 'Action denied by user' }
  }

  try {
    return await handler(tabId, params)
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
