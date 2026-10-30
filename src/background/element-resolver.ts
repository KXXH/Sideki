// Reason: shared element resolution logic — injected into page context via executeScript.
// All commands that accept a "target" string (click, type-text, element-info, locate,
// find-element, screenshot) use this same resolver. Ensures consistent behavior.

import { OVERLAY_SELECTOR } from '../shared/input'

export interface ResolvedElement {
  found: true
  selector: string
  tag: string
  text: string
  visible: boolean
  rect: { x: number; y: number; width: number; height: number }
  attributes: Record<string, string>
  value?: string
}

export interface ResolveError {
  found: false
  error: string
  candidates?: string[]
}

export type ResolveResult = ResolvedElement | ResolveError

/**
 * Page-context function: installs self.__skResolve — the single source of truth
 * for target → HTMLElement resolution. Must be self-contained.
 * Cascade: [N] index → CSS selector → text/aria/placeholder search.
 */
export function installResolver(overlaySelector: string): void {
  const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex], label, summary'
  const w = self as unknown as { __skResolve?: (target: string) => HTMLElement | null; __skIdx?: Map<number, Element> }

  w.__skResolve = function (target: string): HTMLElement | null {
    // [N] index from dom snapshot
    const idxMatch = target.match(/^\[(\d+)]$/)
    if (idxMatch) {
      const idx = parseInt(idxMatch[1])
      if (!w.__skIdx?.has(idx)) return null
      const el = w.__skIdx.get(idx)!
      return el.isConnected ? el as HTMLElement : null
    }

    // CSS selector
    try {
      const el = document.querySelector(target) as HTMLElement | null
      if (el) return el
    } catch { /* not a valid selector */ }

    // Text / attribute search on interactive elements
    const candidates = Array.from(document.querySelectorAll(INTERACTIVE)) as HTMLElement[]
    const lower = target.toLowerCase()

    const visible = candidates.filter(c => {
      // Reason: Sidekick's own overlays are interactive-looking DOM. Without
      // this the agent can target its own pointer or lock indicator.
      try {
        if (c.closest(overlaySelector)) return false
      } catch { /* selector unsupported in this document */ }
      const rect = c.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      // Reason: computed style reports an element under a display:none ancestor
      // as visible, which let a collapsed menu's items outrank the real control
      // in the text match. checkVisibility walks ancestors.
      const probeFn = (c as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility
      if (typeof probeFn === 'function') {
        return probeFn.call(c, { visibilityProperty: true, contentVisibilityAuto: true, checkVisibilityCSS: true })
      }
      const style = getComputedStyle(c)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })

    const scored: Array<{ el: HTMLElement; exact: boolean }> = []
    for (const c of visible) {
      const text = (c.textContent ?? '').trim().toLowerCase()
      const ariaLabel = (c.getAttribute('aria-label') ?? '').toLowerCase()
      const placeholder = ((c as HTMLInputElement).placeholder ?? '').toLowerCase()
      const title = (c.getAttribute('title') ?? '').toLowerCase()
      const alt = (c.getAttribute('alt') ?? '').toLowerCase()
      const name = (c.getAttribute('name') ?? '').toLowerCase()
      const searchable = [text, ariaLabel, placeholder, title, alt, name]

      const isExact = searchable.some(s => s === lower)
      const isContains = searchable.some(s => s.includes(lower))
      if (isExact || isContains) scored.push({ el: c, exact: isExact })
    }

    const exactMatches = scored.filter(s => s.exact)
    const matches = exactMatches.length > 0 ? exactMatches : scored
    return matches.length > 0 ? matches[0].el : null
  }
}

/**
 * Service-worker helper: ensure self.__skResolve is installed on the tab (idempotent).
 */
export async function ensureResolver(tabId: number): Promise<void> {
  try {
    // Reason: the resolver used to be installed in the top frame only, so
    // __skResolve was undefined inside iframes and the allFrames retry in
    // resolveAndExecWithFrame could never succeed for an iframe target.
    // injectImmediately matters here: a deferred lazy iframe never reaches
    // document_idle, which would leave an allFrames injection pending forever.
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      func: () => !!(self as unknown as { __skResolve?: unknown }).__skResolve,
    })
    if (results.length > 0 && results.every(r => r?.result)) return
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      func: installResolver as unknown as () => void,
      args: [OVERLAY_SELECTOR],
    })
  } catch { /* best effort */ }
}

/**
 * Page-context function: resolves a target string to an element with metadata.
 * Requires self.__skResolve to be installed (call ensureResolver first).
 */
export function pageResolveElement(target: string): ResolveResult {
  const w = self as unknown as { __skResolve?: (t: string) => HTMLElement | null; __skIdx?: Map<number, Element> }
  const resolve = w.__skResolve
  const el = resolve ? resolve(target) : null

  if (!el) {
    // Reason: differentiate [N] index failures so the agent knows whether to re-run `dom`
    const idxMatch = target.match(/^\[(\d+)]$/)
    if (idxMatch) {
      const idx = parseInt(idxMatch[1])
      if (!w.__skIdx || w.__skIdx.size === 0) {
        return { found: false, error: `No element snapshot exists. Run "dom" first to index page elements, then retry ${target}.` }
      }
      if (!w.__skIdx.has(idx)) {
        return { found: false, error: `Index ${target} does not exist (snapshot has ${w.__skIdx.size} elements, max [${w.__skIdx.size - 1}]). Run "dom" to refresh.` }
      }
      return { found: false, error: `Element ${target} was removed or replaced since last "dom" snapshot. Run "dom" to refresh indices.` }
    }
    return { found: false, error: `No element found matching "${target}". Try a CSS selector or different text.` }
  }

  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const isVisible = rect.width > 0 && rect.height > 0
    && style.display !== 'none' && style.visibility !== 'hidden'
    && parseFloat(style.opacity) > 0

  const attrNames = ['id', 'class', 'name', 'type', 'href', 'src', 'placeholder', 'role', 'aria-label', 'value']
  const attributes: Record<string, string> = {}
  for (const name of attrNames) {
    const val = el.getAttribute(name)
    if (val) attributes[name] = val.slice(0, 100)
  }

  return {
    found: true,
    selector: uniqueSelector(el),
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').trim().slice(0, 200),
    visible: isVisible,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    attributes,
    value: (el as HTMLInputElement).value || undefined,
  }
}

/**
 * Page-context function: find ALL matching elements (for find-element).
 */
export function pageFindElements(target: string, selector?: string, attr?: string, attrValue?: string): Array<{ selector: string; tag: string; text: string }> {
  let elements: HTMLElement[] = []

  if (selector) {
    elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[]
  } else if (attr) {
    const escVal = (attrValue ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const sel = attrValue ? `[${CSS.escape(attr)}="${escVal}"]` : `[${CSS.escape(attr)}]`
    elements = Array.from(document.querySelectorAll(sel)) as HTMLElement[]
  } else if (target) {
    const lower = target.toLowerCase()
    const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex], label, summary'
    const all = Array.from(document.querySelectorAll(INTERACTIVE)) as HTMLElement[]
    elements = all.filter(el => {
      const text = (el.textContent ?? '').trim().toLowerCase()
      const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase()
      const placeholder = ((el as HTMLInputElement).placeholder ?? '').toLowerCase()
      return text.includes(lower) || ariaLabel.includes(lower) || placeholder.includes(lower)
    })
  }

  return elements.slice(0, 20).map(el => ({
    selector: uniqueSelector(el),
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').trim().slice(0, 60),
  }))
}

/**
 * Page-context function: generates a unique CSS selector for an element.
 * Uses css-selector-generator if available (injected), else fallback.
 */
function uniqueSelector(el: Element): string {
  // Reason: css-selector-generator UMD exposes self.CssSelectorGenerator
  const lib = (self as unknown as { CssSelectorGenerator?: { getCssSelector: (el: Element) => string } }).CssSelectorGenerator
  if (lib) {
    try { return lib.getCssSelector(el) } catch { /* fallback */ }
  }
  return fallbackUniqueSelector(el)
}

function fallbackUniqueSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  const tag = el.tagName.toLowerCase()
  const cls = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).map(c => CSS.escape(c)).join('.')
    : ''
  if (cls && document.querySelectorAll(`${tag}${cls}`).length === 1) return `${tag}${cls}`
  // nth-of-type path
  const path: string[] = []
  let node: Element | null = el
  while (node && node !== document.body) {
    const parent: Element | null = node.parentElement
    if (!parent) break
    const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === node!.tagName)
    const part = siblings.length > 1
      ? `${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`
      : node.tagName.toLowerCase()
    path.unshift(part)
    if (document.querySelectorAll(path.join(' > ')).length === 1) break
    node = parent
  }
  return path.join(' > ') || tag
}

/**
 * Service-worker helper: inject css-selector-generator lib into a tab (idempotent).
 */
export async function ensureSelectorLib(tabId: number): Promise<void> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(self as unknown as { CssSelectorGenerator?: unknown }).CssSelectorGenerator,
    })
    if (result?.result) return
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/css-selector-generator.js'],
    })
  } catch { /* best effort */ }
}
