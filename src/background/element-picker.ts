// Reason: this function is serialized by chrome.scripting.executeScript —
// it must be fully self-contained with zero imports or closure references.
// Reason: all functions are ordered so NO forward references exist — bundlers
// convert function declarations to const/let, which triggers TDZ errors on
// forward refs in the serialized output.
//
// Modes:
//   'pick'      (default) — interactive element picker with full overlay
//   'highlight' — consent highlight: resolve target, draw pulsing highlight, return description
//   'clear'     — remove consent highlight
export function pickerScript(mode?: string, highlightTarget?: string): string | null | void {
  const ATTR = 'data-sidekick-picker'
  const FILL = 'rgba(99, 102, 241, 0.12)'
  const STROKE = 'rgba(99, 102, 241, 0.8)'
  const LABEL_BG = 'rgba(99, 102, 241, 0.9)'
  const IFRAME_FILL = 'rgba(245, 158, 11, 0.10)'
  const IFRAME_STROKE = 'rgba(245, 158, 11, 0.8)'
  const IFRAME_LABEL_BG = 'rgba(217, 119, 6, 0.9)'
  const LABEL_FONT = '11px "JetBrains Mono", ui-monospace, monospace'
  const MIN_SIZE = 4

  const w = self as unknown as { __skResolve?: (t: string) => HTMLElement | null; __skHighlightRaf?: number }

  // --- Clear mode: remove highlight and return ---
  if (mode === 'clear') {
    if (w.__skHighlightRaf) { cancelAnimationFrame(w.__skHighlightRaf); delete w.__skHighlightRaf }
    document.querySelectorAll(`[${ATTR}="highlight"]`).forEach(e => e.remove())
    return
  }

  // --- Highlight mode: resolve, draw, return description ---
  if (mode === 'highlight') {
    // Clean up any previous highlight
    if (w.__skHighlightRaf) { cancelAnimationFrame(w.__skHighlightRaf); delete w.__skHighlightRaf }
    document.querySelectorAll(`[${ATTR}="highlight"]`).forEach(e => e.remove())

    if (!highlightTarget || !w.__skResolve) return null
    const el = w.__skResolve(highlightTarget)
    if (!el) return null

    el.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // Build human-readable description
    const TAG_ZH: Record<string, string> = {
      button: '按钮', a: '链接', input: '输入框', select: '下拉框',
      textarea: '文本域', label: '标签', summary: '折叠', option: '选项',
    }
    const tag = el.tagName.toLowerCase()
    const tagLabel = TAG_ZH[tag] || tag
    const rawText = (el.textContent ?? '').trim().slice(0, 50)
    const ariaLabel = el.getAttribute('aria-label') ?? ''
    const placeholder = (el as HTMLInputElement).placeholder ?? ''
    const displayText = rawText || ariaLabel || placeholder || el.getAttribute('title') || ''
    const shortText = displayText.length > 30 ? displayText.slice(0, 30) + '…' : displayText
    const description = shortText ? `${tagLabel} "${shortText}"` : tagLabel

    // Create non-blocking canvas
    const canvas = document.createElement('canvas')
    canvas.setAttribute(ATTR, 'highlight')
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex: '2147483646',
    })
    document.documentElement.appendChild(canvas)

    const ctx = canvas.getContext('2d')!
    const dpr = devicePixelRatio || 1
    canvas.width = innerWidth * dpr
    canvas.height = innerHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    let pulsePhase = 0

    function drawHighlight() {
      const rect = el!.getBoundingClientRect()
      const x = rect.left, y = rect.top
      const rw = Math.max(rect.width, MIN_SIZE), rh = Math.max(rect.height, MIN_SIZE)

      ctx.clearRect(0, 0, innerWidth, innerHeight)

      const pulse = 0.5 + 0.5 * Math.sin(pulsePhase)

      // Fill: alpha oscillates 0.06 → 0.22
      ctx.fillStyle = `rgba(99, 102, 241, ${0.06 + 0.16 * pulse})`
      ctx.fillRect(x, y, rw, rh)

      // Border: lineWidth pulses 1.5 → 2.5
      ctx.strokeStyle = STROKE
      ctx.lineWidth = 1.5 + pulse
      ctx.strokeRect(x, y, rw, rh)

      // Outer glow: expands 2→6px, alpha 0.1→0.4
      const glowPad = 2 + 4 * pulse
      ctx.strokeStyle = `rgba(99, 102, 241, ${0.1 + 0.3 * pulse})`
      ctx.lineWidth = 3 + 2 * pulse
      ctx.strokeRect(x - glowPad, y - glowPad, rw + glowPad * 2, rh + glowPad * 2)

      // Label
      ctx.font = LABEL_FONT
      const tm = ctx.measureText(description)
      const pad = 6, lh = 18
      const lw = tm.width + pad * 2

      let lx = x
      let ly = y - lh - 4
      if (ly < 0) ly = y + rh + 4
      if (lx + lw > innerWidth) lx = innerWidth - lw
      if (lx < 0) lx = 0

      ctx.fillStyle = LABEL_BG
      ctx.beginPath()
      const anyCtx = ctx as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }
      if (typeof anyCtx.roundRect === 'function') anyCtx.roundRect(lx, ly, lw, lh, 4)
      else ctx.rect(lx, ly, lw, lh)
      ctx.fill()

      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(description, lx + pad, ly + lh / 2)

      pulsePhase += 0.06
      w.__skHighlightRaf = requestAnimationFrame(drawHighlight)
    }

    drawHighlight()
    return description
  }

  // --- Pick mode (default): interactive element picker ---
  const LERP_SPEED = 0.25

  function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
  function rectsClose(a: number[], b: number[], threshold = 0.5) {
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) >= threshold) return false
    return true
  }

  // --- Overlay + Canvas ---
  const overlay = document.createElement('div')
  overlay.setAttribute(ATTR, '1')
  // Reason: -1 rather than 0 — overlay.focus() below still needs a focusable
  // host, but the page's Tab order must not walk into Sidekick's own overlay.
  overlay.setAttribute('tabindex', '-1')
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    cursor: 'crosshair', outline: 'none',
  })

  const canvas = document.createElement('canvas')
  canvas.setAttribute(ATTR, '1')
  Object.assign(canvas.style, { width: '100%', height: '100%', pointerEvents: 'none' })
  overlay.appendChild(canvas)
  document.documentElement.appendChild(overlay)
  // Reason: focus the overlay so keydown events fire in this document,
  // critical when picker is injected into an iframe that doesn't have focus
  overlay.focus()

  const ctx = canvas.getContext('2d')!
  let dpr = 1

  // --- Animation state (must precede all functions that read them) ---
  const cur = [0, 0, 0, 0]
  const tgt = [0, 0, 0, 0]
  let labelTag = ''
  let hasTarget = false
  let rafId = 0
  let hoveredEl: Element | null = null
  let isIframe = false

  // --- Drawing (reads cur, ctx, labelText — all above) ---
  function drawFrame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight)

    ctx.fillStyle = isIframe ? IFRAME_FILL : FILL
    ctx.fillRect(cur[0], cur[1], cur[2], cur[3])
    ctx.strokeStyle = isIframe ? IFRAME_STROKE : STROKE
    ctx.lineWidth = 1
    ctx.strokeRect(cur[0], cur[1], cur[2], cur[3])

    const labelText = isIframe
      ? `iframe ↓  ${Math.round(cur[2])}×${Math.round(cur[3])}`
      : `${labelTag} ${Math.round(cur[2])}×${Math.round(cur[3])}`
    ctx.font = LABEL_FONT
    const tm = ctx.measureText(labelText)
    const pad = 4, lh = 16
    const lw = tm.width + pad * 2

    let lx = cur[0]
    let ly = cur[1] - lh - 2
    if (ly < 0) ly = cur[1] + 2
    if (lx + lw > innerWidth) lx = innerWidth - lw
    if (lx < 0) lx = 0

    ctx.fillStyle = isIframe ? IFRAME_LABEL_BG : LABEL_BG
    ctx.beginPath()
    const any = ctx as unknown as { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }
    if (typeof any.roundRect === 'function') any.roundRect(lx, ly, lw, lh, 3)
    else ctx.rect(lx, ly, lw, lh)
    ctx.fill()

    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'middle'
    ctx.fillText(labelText, lx + pad, ly + lh / 2)
  }

  // --- Animation loop (calls drawFrame, lerp, rectsClose — all above) ---
  function animLoop() {
    if (!hasTarget) return
    if (rectsClose(cur, tgt)) {
      cur[0] = tgt[0]; cur[1] = tgt[1]; cur[2] = tgt[2]; cur[3] = tgt[3]
    } else {
      cur[0] = lerp(cur[0], tgt[0], LERP_SPEED)
      cur[1] = lerp(cur[1], tgt[1], LERP_SPEED)
      cur[2] = lerp(cur[2], tgt[2], LERP_SPEED)
      cur[3] = lerp(cur[3], tgt[3], LERP_SPEED)
    }
    drawFrame()
    if (!rectsClose(cur, tgt)) {
      rafId = requestAnimationFrame(animLoop)
    }
  }

  // --- Set target (calls drawFrame, animLoop — all above) ---
  function setTarget(r: DOMRect, tag: string) {
    labelTag = tag.toLowerCase()
    tgt[0] = r.left; tgt[1] = r.top
    tgt[2] = Math.max(r.width, MIN_SIZE); tgt[3] = Math.max(r.height, MIN_SIZE)
    if (!hasTarget) {
      cur[0] = tgt[0]; cur[1] = tgt[1]; cur[2] = tgt[2]; cur[3] = tgt[3]
      hasTarget = true
      drawFrame()
    } else {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(animLoop)
    }
  }

  // --- Resize canvas (calls drawFrame — above) ---
  function resizeCanvas() {
    dpr = devicePixelRatio || 1
    canvas.width = innerWidth * dpr
    canvas.height = innerHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (hasTarget) drawFrame()
  }
  resizeCanvas()

  // --- Element detection (calls setTarget — above) ---
  function onMouseMove(e: MouseEvent) {
    overlay.style.pointerEvents = 'none'
    const el = document.elementFromPoint(e.clientX, e.clientY)
    overlay.style.pointerEvents = ''
    if (!el || el.hasAttribute(ATTR)) return
    hoveredEl = el
    isIframe = el.tagName === 'IFRAME'
    setTarget(el.getBoundingClientRect(), el.tagName)
  }

  function onScroll() {
    if (hoveredEl?.isConnected) {
      setTarget(hoveredEl.getBoundingClientRect(), hoveredEl.tagName)
    }
  }

  // --- DOM snapshot ---
  function compactSnapshot(el: Element, maxLen = 1500): string {
    const tag = el.tagName.toLowerCase()
    const attrs: string[] = []
    const keys = ['id', 'class', 'role', 'aria-label', 'href', 'src', 'type', 'name', 'placeholder']
    for (const k of keys) {
      let v = el.getAttribute(k)
      if (!v) continue
      if (k === 'class') v = v.trim().split(/\s+/).slice(0, 3).join(' ')
      if (v.length > 80) v = v.slice(0, 77) + '...'
      attrs.push(`${k}="${v}"`)
    }
    const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
    const close = `</${tag}>`

    const children = el.children
    const childLines: string[] = []
    const limit = Math.min(children.length, 5)
    for (let i = 0; i < limit; i++) {
      const c = children[i]
      const ct = c.tagName.toLowerCase()
      const cId = c.id ? ` id="${c.id}"` : ''
      const cCls = c.className && typeof c.className === 'string'
        ? ` class="${c.className.trim().split(/\s+/).slice(0, 2).join(' ')}"`
        : ''
      const txt = (c.textContent ?? '').trim().slice(0, 60)
      childLines.push(`  <${ct}${cId}${cCls}>${txt}</${ct}>`)
    }
    if (children.length > 5) {
      childLines.push(`  <!-- ...${children.length - 5} more -->`)
    }

    const text = (el.textContent ?? '').trim()
    const textPreview = text.length > 200 ? text.slice(0, 197) + '...' : text

    let snapshot = childLines.length > 0
      ? `${open}\n${childLines.join('\n')}\n${close}`
      : `${open}${textPreview}${close}`

    if (snapshot.length > maxLen) snapshot = snapshot.slice(0, maxLen - 3) + '...'
    return snapshot
  }

  // --- Cleanup via AbortController (no forward refs to onClick/onKeyDown) ---
  const ac = new AbortController()

  function cleanup() {
    cancelAnimationFrame(rafId)
    hasTarget = false
    ac.abort()
    overlay.remove()
  }

  // --- Event handlers (call cleanup, compactSnapshot — all above) ---
  function onClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    overlay.style.pointerEvents = 'none'
    const el = document.elementFromPoint(e.clientX, e.clientY)
    overlay.style.pointerEvents = ''
    if (!el || el.hasAttribute(ATTR)) return

    // Reason: iframe drill-down — inject picker into the iframe instead of selecting the iframe itself
    if (el.tagName === 'IFRAME') {
      const ir = el.getBoundingClientRect()
      const src = (el as HTMLIFrameElement).src || ''
      cleanup()
      chrome.runtime.sendMessage({
        type: 'picker:drill',
        iframeSrc: src,
        iframeRect: { x: ir.x, y: ir.y, width: ir.width, height: ir.height },
      })
      return
    }

    const r = el.getBoundingClientRect()
    const rect = { x: r.x, y: r.y, width: r.width, height: r.height }
    const domSnapshot = compactSnapshot(el)
    const tag = el.tagName.toLowerCase()
    const labelStr = `${tag.toUpperCase()} ${Math.round(r.width)}×${Math.round(r.height)}`

    cleanup()

    chrome.runtime.sendMessage({
      type: 'picker:result',
      rect,
      domSnapshot,
      label: labelStr,
      devicePixelRatio: window.devicePixelRatio,
    })
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      cleanup()
      chrome.runtime.sendMessage({ type: 'picker:cancel' })
    }
  }

  // --- Bind events (all handlers defined above, use signal for bulk removal) ---
  const sig = { signal: ac.signal }
  overlay.addEventListener('mousemove', onMouseMove, sig)
  overlay.addEventListener('click', onClick, sig)
  document.addEventListener('keydown', onKeyDown, { capture: true, ...sig })
  window.addEventListener('scroll', onScroll, { capture: true, ...sig })
  window.addEventListener('resize', resizeCanvas, sig)
}

// Reason: parent-frame guard overlay when picker has drilled into an iframe.
// Clip-path cuts a hole over the iframe so clicks there pass through to the
// iframe picker; clicks outside the hole trigger "go back to parent".
export function pickerGuardScript(rect: { x: number; y: number; width: number; height: number }): void {
  const ATTR = 'data-sidekick-picker'
  document.querySelectorAll(`[${ATTR}="guard"]`).forEach(e => e.remove())

  const guard = document.createElement('div')
  guard.setAttribute(ATTR, 'guard')

  const r = rect.x + rect.width
  const b = rect.y + rect.height
  Object.assign(guard.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    cursor: 'pointer', background: 'rgba(0, 0, 0, 0.2)',
    clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 ${rect.y}px, ${rect.x}px ${rect.y}px, ${rect.x}px ${b}px, ${r}px ${b}px, ${r}px ${rect.y}px, 0 ${rect.y}px)`,
  })

  const ac = new AbortController()
  const sig = { signal: ac.signal }

  function cleanup() { ac.abort(); guard.remove() }

  guard.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    cleanup()
    chrome.runtime.sendMessage({ type: 'picker:back' })
  }, sig)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cleanup()
      chrome.runtime.sendMessage({ type: 'picker:cancel' })
    }
  }, { capture: true, ...sig })

  document.documentElement.appendChild(guard)
}
