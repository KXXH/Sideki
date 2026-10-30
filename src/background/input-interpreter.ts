// Reason: the page-side half of the input engine. Both functions here are
// serialized by chrome.scripting.executeScript, so they must be FULLY
// self-contained — no imports, no closure references, and no forward references
// between nested helpers (bundlers rewrite function declarations to const/let,
// which turns a forward reference into a TDZ error in the serialized output).
// Only type imports are allowed; they are erased at compile time.

import type { InputPlan, Observation, RenderProbe } from '../shared/input'

export interface MeasureResult {
  success: boolean
  error?: string
  rect?: { x: number; y: number; width: number; height: number }
  probe?: RenderProbe
  tagName?: string
  interactive?: boolean
  contentEditable?: boolean
  docId?: string
}

export interface InterpretResult {
  success: boolean
  error?: string
  tagName?: string
  text?: string
  /** Set when the point was covered and a different subtree took the event. */
  occludedBy?: string
  observed?: Observation
  staleDoc?: boolean
}

/**
 * Page-context: resolve the plan's target, scroll it into view, and report the
 * geometry the planner needs. Requires self.__skResolve (ensureResolver).
 */
export function measurePlanTarget(target: string, scroll: boolean): MeasureResult {
  const w = self as unknown as {
    __skResolve?: (t: string) => HTMLElement | null
    __skInputDocId?: string
  }
  const resolve = w.__skResolve
  const el = resolve ? resolve(target) : null
  // Reason: this wording is load-bearing — resolveAndExecWithFrame keys its
  // allFrames retry off the "No element found" substring.
  if (!el) return { success: false, error: `No element found matching "${target}". Try a CSS selector or different text.` }

  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })

  if (!w.__skInputDocId) {
    // Reason: a document fingerprint lets the planner notice an SPA soft
    // navigation the service worker never observed, and discard a stale start
    // position instead of animating from coordinates that no longer mean
    // anything. Not random — a soft nav replaces the isolated world too.
    w.__skInputDocId = `${location.href}|${document.title}`
  }

  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  // Reason: checkVisibility walks ancestors, which computed style cannot — an
  // element under a display:none parent reports its own specified display. It
  // landed in Chrome 125 with these option names (the 105-era spelling is
  // passed too; unknown dictionary members are ignored), so the manual fallback
  // only matters on a browser this extension does not target.
  const probeFn = (el as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility
  const rendered = typeof probeFn === 'function'
    ? probeFn.call(el, { visibilityProperty: true, contentVisibilityAuto: true, checkVisibilityCSS: true })
    : style.display !== 'none' && style.visibility !== 'hidden'
  const tag = el.tagName
  const role = el.getAttribute('role') ?? ''
  const interactiveTag = tag === 'BUTTON' || tag === 'A' || tag === 'INPUT'
    || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY'
  const interactiveRole = role === 'button' || role === 'link' || role === 'tab'
    || role === 'menuitem' || role === 'checkbox' || role === 'radio'
    || role === 'textbox' || role === 'combobox' || role === 'switch'

  return {
    success: true,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    probe: {
      connected: el.isConnected,
      rendered,
      display: style.display,
      visibility: style.visibility,
      opacity: parseFloat(style.opacity) || 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrolled: scroll,
    },
    tagName: tag,
    interactive: interactiveTag || interactiveRole || style.cursor === 'pointer',
    contentEditable: el.isContentEditable && tag !== 'INPUT' && tag !== 'TEXTAREA',
    docId: w.__skInputDocId,
  }
}

/**
 * Page-context: bracket a service-worker-driven dispatch with the same
 * measurements interpretPlan takes inline.
 */
interface ObsState {
  focus: Element | null
  value: string | null
  mutated: boolean
  observer: MutationObserver
  timer: number
}

/**
 * Page-context: start observing, for the CDP path. The synthetic path arms and
 * collects inside one injection; a CDP dispatch runs in the service worker, so
 * the same measurements have to bracket it from two.
 */
export function armObservation(target: string): { ok: true } {
  const w = self as unknown as {
    __skResolve?: (t: string) => HTMLElement | null
    __skObs?: ObsState
  }
  const prev = w.__skObs
  if (prev) {
    prev.observer.disconnect()
    clearTimeout(prev.timer)
  }

  const el = w.__skResolve ? w.__skResolve(target) : null
  const anyEl = el as unknown as { value?: unknown } | null
  const observer = new MutationObserver(() => {
    const s = (self as unknown as { __skObs?: ObsState }).__skObs
    if (s) s.mutated = true
  })
  const state: ObsState = {
    focus: document.activeElement,
    value: !anyEl ? null : typeof anyEl.value === 'string' ? anyEl.value : (el?.textContent ?? null),
    mutated: false,
    observer,
    // Reason: if the dispatch throws, collectObservation never runs. A live
    // MutationObserver on documentElement is not something to leave behind, so
    // it disconnects itself well after any plan could still be running.
    timer: setTimeout(() => {
      observer.disconnect()
      ;(self as unknown as { __skObs?: ObsState }).__skObs = undefined
    }, 10_000) as unknown as number,
  }
  w.__skObs = state
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true,
  })
  return { ok: true }
}

/**
 * Page-context: stop observing and report what changed.
 */
export function collectObservation(target: string): {
  focusChanged: boolean
  valueChanged: boolean
  domMutated: boolean
} {
  const w = self as unknown as {
    __skResolve?: (t: string) => HTMLElement | null
    __skObs?: ObsState
  }
  const state = w.__skObs
  if (!state) return { focusChanged: false, valueChanged: false, domMutated: false }
  state.observer.disconnect()
  clearTimeout(state.timer)
  w.__skObs = undefined

  const el = w.__skResolve ? w.__skResolve(target) : null
  const anyEl = el as unknown as { value?: unknown } | null
  const value = !anyEl ? null : typeof anyEl.value === 'string' ? anyEl.value : (el?.textContent ?? null)
  return {
    focusChanged: document.activeElement !== state.focus,
    valueChanged: value !== state.value,
    domMutated: state.mutated,
  }
}

/**
 * Page-context: execute a plan's step timeline against the real DOM.
 */
export async function interpretPlan(
  target: string,
  planJson: string,
  expectedDocId: string | null,
  pointer: { id: string; zIndex: number; markup: string } | null,
): Promise<InterpretResult> {
  const w = self as unknown as {
    __skResolve?: (t: string) => HTMLElement | null
    __skInputDocId?: string
  }

  const resolve = w.__skResolve
  const el = resolve ? resolve(target) : null
  if (!el) return { success: false, error: `No element found matching "${target}". Try a CSS selector or different text.` }

  const plan = JSON.parse(planJson) as InputPlan
  const staleDoc = !!expectedDocId && w.__skInputDocId !== expectedDocId

  // --- observation baseline ---
  const startUrl = location.href
  const startFocus = document.activeElement
  const valueOf = (n: Element | null): string | null => {
    if (!n) return null
    const anyN = n as unknown as { value?: unknown }
    return typeof anyN.value === 'string' ? anyN.value : n.textContent
  }
  const startValue = valueOf(el)
  let defaultPrevented = false
  let domMutated = false

  // Reason: constructed here to capture the baseline, but armed only after the
  // pointer overlay is installed — appending the overlay host to
  // documentElement is itself a childList mutation, and observing it would make
  // domMutated permanently true. The host is absent at the start of most turns
  // (releaseTurn fades it), so the first action of every turn would report it.
  const observer = new MutationObserver(() => { domMutated = true })

  // --- timing ---
  // Reason: Chrome stops calling requestAnimationFrame entirely for a hidden
  // page and clamps its timers to roughly one firing per second, so a waypoint
  // timeline cannot be honoured in a background tab at all. Event ORDER needs no
  // timer, only the delays do — so a hidden tab collapses every delay to zero
  // and still gets the full-fidelity sequence.
  let instant = document.visibilityState !== 'visible'
  const onVisibility = () => { if (document.visibilityState !== 'visible') instant = true }
  document.addEventListener('visibilitychange', onVisibility)

  let elapsed = 0
  const waitUntil = (at: number): Promise<void> => {
    const dt = at - elapsed
    // Reason: cues and steps are drained against this one counter, so a cue
    // scheduled at or before the current position must not rewind it.
    elapsed = Math.max(elapsed, at)
    if (instant || dt <= 0) return Promise.resolve()
    return new Promise(resolveWait => { setTimeout(resolveWait, dt) })
  }

  // --- hover chain ---
  // Reason: the ancestor chain of the topmost hit element, innermost first —
  // this is what mouseenter/mouseleave traverse. elementsFromPoint would also
  // return unrelated elements stacked underneath.
  const chainAt = (x: number, y: number): Element[] => {
    const out: Element[] = []
    let node = document.elementFromPoint(x, y)
    while (node) {
      out.push(node)
      node = node.parentElement
    }
    return out
  }

  const diffChain = (prev: Element[], next: Element[]) => {
    const left = prev.filter(n => next.indexOf(n) === -1)
    const entered = next.filter(n => prev.indexOf(n) === -1).reverse()
    return { left, entered }
  }

  const mouseInit = (
    type: string, x: number, y: number, button: number, buttons: number,
    detail: number, mods: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean },
    related: Element | null,
  ): MouseEventInit => ({
    // Reason: the old implementation dispatched bare MouseEvents with no
    // coordinates, so any library reading clientX/clientY got 0,0. bubbles and
    // composed also matter: without composed the event never crosses a shadow
    // boundary.
    bubbles: type !== 'mouseenter' && type !== 'mouseleave'
      && type !== 'pointerenter' && type !== 'pointerleave',
    cancelable: type !== 'mouseenter' && type !== 'mouseleave'
      && type !== 'pointerenter' && type !== 'pointerleave',
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    button,
    buttons,
    detail,
    ctrlKey: mods.ctrl,
    shiftKey: mods.shift,
    altKey: mods.alt,
    metaKey: mods.meta,
    relatedTarget: related,
  })

  const fire = (node: Element, event: Event): void => {
    const ok = node.dispatchEvent(event)
    if (!ok) defaultPrevented = true
  }

  const firePair = (
    node: Element, pointerType: string, mouseType: string,
    x: number, y: number, button: number, buttons: number, detail: number,
    mods: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean },
    related: Element | null,
  ): void => {
    const pInit = mouseInit(pointerType, x, y, button, buttons, detail, mods, related)
    fire(node, new PointerEvent(pointerType, {
      ...pInit, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }))
    fire(node, new MouseEvent(mouseType, mouseInit(mouseType, x, y, button, buttons, detail, mods, related)))
  }

  const setNativeValue = (node: Element, value: string): boolean => {
    // Reason: assigning .value directly bypasses React's value tracker, so a
    // controlled input never fires onChange. Going through the prototype's
    // native setter is the only synthetic path React observes.
    const proto = node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : node instanceof HTMLInputElement ? HTMLInputElement.prototype : null
    if (!proto) return false
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (!desc || !desc.set) return false
    desc.set.call(node, value)
    return true
  }

  const currentValue = (node: Element): string => {
    const anyN = node as unknown as { value?: unknown }
    return typeof anyN.value === 'string' ? anyN.value : (node.textContent ?? '')
  }

  const writeValue = (node: Element, value: string): void => {
    if (!setNativeValue(node, value)) node.textContent = value
  }

  const beforeInput = (node: Element, inputType: string, data: string | null): boolean => {
    // Reason: beforeinput is cancelable. A page that prevents it must see the
    // character dropped, exactly as a real keystroke would behave.
    const ev = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, inputType, data,
    })
    const ok = node.dispatchEvent(ev)
    if (!ok) defaultPrevented = true
    return ok
  }

  const afterInput = (node: Element, inputType: string, data: string | null): void => {
    node.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType, data,
    }))
  }

  const insertAtCaret = (node: Element, ch: string): void => {
    const input = node as unknown as {
      selectionStart?: number | null; selectionEnd?: number | null
      setSelectionRange?: (s: number, e: number) => void
    }
    const value = currentValue(node)
    const hasCaret = typeof input.selectionStart === 'number'
    const start = hasCaret ? (input.selectionStart as number) : value.length
    const end = hasCaret ? (input.selectionEnd as number) : value.length
    writeValue(node, value.slice(0, start) + ch + value.slice(end))
    if (hasCaret && input.setSelectionRange) {
      const caret = start + ch.length
      input.setSelectionRange(caret, caret)
    }
  }

  const selectAll = (node: Element): void => {
    const input = node as unknown as { setSelectionRange?: (s: number, e: number) => void }
    if (input.setSelectionRange) {
      input.setSelectionRange(0, currentValue(node).length)
      return
    }
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      const range = document.createRange()
      range.selectNodeContents(node)
      sel.addRange(range)
    }
  }

  const applyEdit = (node: Element, op: string, data: string, inputType: string): void => {
    if (op === 'deleteAll') {
      selectAll(node)
      if (!beforeInput(node, inputType, null)) return
      writeValue(node, '')
      afterInput(node, inputType, null)
      return
    }
    if (op === 'insertChar') {
      if (!beforeInput(node, inputType, data)) return
      insertAtCaret(node, data)
      afterInput(node, inputType, data)
      return
    }
    if (op === 'setValue') {
      if (!beforeInput(node, inputType, data)) return
      writeValue(node, data)
      afterInput(node, inputType, data)
      return
    }
    // insertText: contenteditable hosts. Reason: execCommand is the only
    // synthetic route that enters the real beforeinput pipeline that Lexical,
    // ProseMirror and Quill all depend on.
    let inserted: boolean
    try {
      inserted = document.execCommand('insertText', false, data)
    } catch { inserted = false }
    if (!inserted) {
      if (!beforeInput(node, inputType, data)) return
      node.textContent = (node.textContent ?? '') + data
      afterInput(node, inputType, data)
    }
  }

  // --- pointer overlay ---
  // Reason: same injection as the steps on purpose. A separate injection would
  // run an independent setTimeout timeline with no shared time base, so the
  // visual would drift away from the events it is supposed to depict.
  let cursor: HTMLElement | null = null
  if (pointer) {
    try {
      let host = document.getElementById(pointer.id) as (HTMLDivElement & { __skRemoveTimer?: number }) | null
      if (!host) {
        host = document.createElement('div') as HTMLDivElement & { __skRemoveTimer?: number }
        host.id = pointer.id
        host.setAttribute('data-sidekick-overlay', 'pointer')
        host.style.all = 'initial'
        host.style.position = 'fixed'
        host.style.inset = '0'
        host.style.zIndex = String(pointer.zIndex)
        host.style.pointerEvents = 'none'
        ;(document.documentElement || document.body).appendChild(host)
        host.attachShadow({ mode: 'open' }).innerHTML = pointer.markup
      }
      if (host.__skRemoveTimer) {
        clearTimeout(host.__skRemoveTimer)
        host.__skRemoveTimer = undefined
      }
      cursor = host.shadowRoot?.querySelector('.p') as HTMLElement | null
      if (cursor) {
        cursor.style.transform = `translate3d(${plan.from.x}px, ${plan.from.y}px, 0)`
        cursor.dataset.on = '1'
      }
    } catch { cursor = null }
  }

  // Reason: armed only now. The overlay host append above is a childList
  // mutation on documentElement; counting it would report dom mutated for every
  // action. Cue updates are safe — they write into the shadow root, which a
  // MutationObserver on documentElement does not traverse.
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true,
  })

  const cues = cursor ? plan.cues : []
  let cueIdx = 0
  const drainCues = async (until: number): Promise<void> => {
    while (cueIdx < cues.length && cues[cueIdx].at <= until) {
      const cue = cues[cueIdx]
      cueIdx++
      await waitUntil(cue.at)
      if (!cursor) continue
      if (cue.kind === 'move' && cue.point) {
        cursor.style.transform = `translate3d(${cue.point.x}px, ${cue.point.y}px, 0)`
      } else if (cue.kind === 'press') {
        cursor.dataset.press = '1'
      } else if (cue.kind === 'release') {
        cursor.dataset.press = '0'
      } else if (cue.kind === 'shape' && cue.shape) {
        cursor.dataset.shape = cue.shape
      }
    }
  }

  // --- run the timeline ---
  let hoverChain: Element[] = []
  let lastPoint = { x: plan.from.x, y: plan.from.y }

  try {
    for (const step of plan.steps) {
      await drainCues(step.at)
      await waitUntil(step.at)
      const op = step.op
      const mods = step.modifiers
      const point = step.point ?? lastPoint
      if (step.point) lastPoint = step.point

      if (op.kind === 'mouse') {
        if (op.type === 'move') {
          const next = chainAt(point.x, point.y)
          const top = next[0] ?? el
          if (step.recomputeHover) {
            const d = diffChain(hoverChain, next)
            const prevTop = hoverChain[0] ?? null
            if (d.left.length > 0) {
              firePair(d.left[0], 'pointerout', 'mouseout', point.x, point.y, -1, step.buttons, 0, mods, top)
              for (const node of d.left) {
                firePair(node, 'pointerleave', 'mouseleave', point.x, point.y, -1, step.buttons, 0, mods, top)
              }
            }
            if (d.entered.length > 0) {
              firePair(top, 'pointerover', 'mouseover', point.x, point.y, -1, step.buttons, 0, mods, prevTop)
              for (const node of d.entered) {
                firePair(node, 'pointerenter', 'mouseenter', point.x, point.y, -1, step.buttons, 0, mods, prevTop)
              }
            }
            hoverChain = next
          }
          firePair(top, 'pointermove', 'mousemove', point.x, point.y, -1, step.buttons, 0, mods, null)
          continue
        }

        const node = hoverChain[0] ?? el
        if (op.type === 'down') {
          firePair(node, 'pointerdown', 'mousedown', point.x, point.y, op.button, step.buttons, op.clickCount, mods, null)
        } else if (op.type === 'up') {
          firePair(node, 'pointerup', 'mouseup', point.x, point.y, op.button, step.buttons, op.clickCount, mods, null)
        } else if (op.type === 'click') {
          fire(node, new MouseEvent('click', mouseInit('click', point.x, point.y, op.button, step.buttons, op.clickCount, mods, null)))
        } else {
          fire(node, new MouseEvent('dblclick', mouseInit('dblclick', point.x, point.y, op.button, step.buttons, op.clickCount, mods, null)))
        }
        continue
      }

      if (op.kind === 'key') {
        // Reason: keyCode/charCode are legacy KeyboardEventInit members Blink
        // still honours. Patching them onto the instance instead would create an
        // ISOLATED-world expando the page's wrapper never sees, so listeners in
        // MAIN would read 0. `which` derives from keyCode automatically.
        const init: KeyboardEventInit = {
          key: op.key, code: op.code, keyCode: op.keyCode, charCode: 0,
          bubbles: true, cancelable: true, composed: true,
          ctrlKey: mods.ctrl, shiftKey: mods.shift, altKey: mods.alt, metaKey: mods.meta,
        }
        const ev = new KeyboardEvent(op.type === 'down' ? 'keydown' : 'keyup', init)
        const focusTarget = (document.activeElement ?? el) as Element
        fire(focusTarget, ev)
        continue
      }

      if (op.kind === 'edit') {
        applyEdit(el, op.op, op.data, op.inputType)
        continue
      }

      if (op.type === 'focus') {
        const focusable = el as unknown as { focus?: () => void }
        if (focusable.focus) focusable.focus()
      } else if (op.type === 'blur') {
        const blurable = el as unknown as { blur?: () => void }
        if (blurable.blur) blurable.blur()
      } else {
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
    await drainCues(Number.MAX_SAFE_INTEGER)
  } finally {
    document.removeEventListener('visibilitychange', onVisibility)
    observer.disconnect()
  }

  // Reason: events go to the topmost element at the point, which is right — a
  // real mouse hits the cookie banner too. But the fields below name the element
  // we resolved, so without this the model is told it clicked Submit when a
  // banner took the event, and domMutated hands it false confidence on top.
  // Only a genuinely different subtree counts: hitting a descendant (a button's
  // inner span) or an ancestor (pointer-events:none) is ordinary.
  const hit = hoverChain[0] ?? null
  const occluded = hit && !el.contains(hit) && !hit.contains(el) ? hit : null
  let occludedBy: string | undefined
  if (occluded) {
    const cls = typeof occluded.className === 'string' && occluded.className.trim()
      ? '.' + occluded.className.trim().split(/\s+/).slice(0, 2).join('.')
      : ''
    occludedBy = occluded.tagName.toLowerCase() + (occluded.id ? `#${occluded.id}` : '') + cls
  }

  return {
    success: true,
    tagName: el.tagName,
    text: (el.textContent ?? '').slice(0, 100),
    ...(occludedBy ? { occludedBy } : {}),
    observed: {
      defaultPrevented,
      focusChanged: document.activeElement !== startFocus,
      valueChanged: valueOf(el) !== startValue,
      domMutated,
      urlChanged: location.href !== startUrl,
    },
    ...(staleDoc ? { staleDoc: true } : {}),
  }
}
