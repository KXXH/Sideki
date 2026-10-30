import { snapdom } from '@zumer/snapdom'

export interface ExportStats {
  promptTokens?: number
  completionTokens: number
  elapsed: number
  speed: number
  ttft: number
  reasoningElapsed: number
}

// Reason: light-mode CSS variable values are hardcoded here so the exported card
// always renders on a white background with dark text, regardless of the user's
// current theme. These must stay in sync with the @theme block in index.css.
const LIGHT_VARS: Record<string, string> = {
  '--color-surface': '#ffffff',
  '--color-surface-raised': '#f3f4f6',
  '--color-surface-overlay': '#e8eaed',
  '--color-border-subtle': '#d4d6dc',
  '--color-border-muted': '#e5e7eb',
  '--color-text-primary': '#18191c',
  '--color-text-secondary': '#5c5e66',
  '--color-text-muted': '#9a9da6',
  '--color-accent': '#6366f1',
  '--color-accent-dim': '#4f46e5',
  '--color-accent-wash': 'rgba(99, 102, 241, 0.07)',
  '--color-accent-glow': 'rgba(99, 102, 241, 0.13)',
}

const CARD_WIDTH = 640
const OUTER_BG = '#1a1a2e'

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

function buildOuterBackground(): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `
    padding: 28px;
    background: radial-gradient(ellipse at 30% 20%, rgba(99,102,241,0.22) 0%, ${OUTER_BG} 70%);
    border-radius: 0;
  `
  return el
}

function buildCard(): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `
    background: #ffffff;
    border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.06);
    overflow: hidden;
  `
  return el
}

function buildStatsRow(stats: ExportStats): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `
    padding: 10px 20px;
    border-top: 1px solid #e5e7eb;
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 11px;
    color: #9a9da6;
    display: flex;
    align-items: center;
    gap: 8px;
    font-variant-numeric: tabular-nums;
  `

  const parts: string[] = []
  if (stats.promptTokens) {
    parts.push(`${formatTokens(stats.promptTokens)} ↑ ${formatTokens(stats.completionTokens)} ↓`)
  } else {
    parts.push(`${stats.completionTokens} tokens`)
  }
  parts.push(`${stats.elapsed.toFixed(1)}s${stats.reasoningElapsed > 0 ? ` (思考 ${stats.reasoningElapsed.toFixed(1)}s)` : ''}`)
  parts.push(`${stats.speed.toFixed(1)} tok/s`)
  if (stats.ttft > 0) {
    parts.push(`TTFT ${stats.ttft < 1 ? `${Math.round(stats.ttft * 1000)}ms` : `${stats.ttft.toFixed(1)}s`}`)
  }
  el.textContent = parts.join('  ·  ')
  return el
}

// Reason: icon.svg path data inlined to avoid loading external files in the offscreen container.
const BRAND_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" width="16" height="16">
  <defs><linearGradient id="eg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#818cf8"/>
  </linearGradient></defs>
  <rect width="128" height="128" rx="28" fill="#18181b"/>
  <circle cx="44" cy="64" r="14" fill="url(#eg)"/>
  <circle cx="84" cy="64" r="8" fill="url(#eg)" opacity="0.6"/>
  <rect x="44" y="60" width="40" height="8" rx="4" fill="url(#eg)" opacity="0.35"/>
</svg>`

function buildFooter(): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `
    padding: 10px 20px;
    border-top: 1px solid #e5e7eb;
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 11px;
    color: #9a9da6;
    display: flex;
    align-items: center;
    gap: 6px;
  `

  const iconSpan = document.createElement('span')
  iconSpan.innerHTML = BRAND_ICON_SVG
  iconSpan.style.cssText = 'display: flex; align-items: center;'

  const name = document.createElement('span')
  name.textContent = 'Sideki'
  name.style.cssText = 'font-weight: 600; color: #5c5e66;'

  const dot = document.createElement('span')
  dot.textContent = '·'

  const now = new Date()
  const ts = document.createElement('span')
  ts.textContent = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  el.appendChild(iconSpan)
  el.appendChild(name)
  el.appendChild(dot)
  el.appendChild(ts)
  return el
}

export async function copyMessageAsImage(
  contentNode: HTMLElement,
  stats?: ExportStats,
): Promise<void> {
  // Reason: mount the offscreen container inside the message area (not document.body)
  // so it inherits the full CSS context — variables like --font-content, --font-content-size,
  // KaTeX font-face rules, Tailwind utility classes all resolve correctly. Placing it in
  // document.body breaks CSS variable inheritance and causes font/layout mismatches.
  // position: absolute + left: -9999px keeps it fully rendered but invisible.
  const mountPoint = contentNode.parentElement || document.body

  const style = document.createElement('style')
  style.textContent = '[data-export-root] *{animation:none!important;transition:none!important}'

  const container = document.createElement('div')
  container.setAttribute('data-export-root', '')
  container.style.cssText = `
    position: absolute; left: -9999px; top: 0; width: ${CARD_WIDTH}px; z-index: -1;
    font-family: 'DM Sans', system-ui, sans-serif;
  `
  // Reason: override CSS variables to light-mode values so the card is always
  // white with dark text, regardless of the user's current dark/light theme.
  for (const [k, v] of Object.entries(LIGHT_VARS)) {
    container.style.setProperty(k, v)
  }
  mountPoint.appendChild(style)
  mountPoint.appendChild(container)

  const outer = buildOuterBackground()
  const card = buildCard()

  const content = contentNode.cloneNode(true) as HTMLElement

  // Reason: only keep elements marked data-export="keep" (text content blocks).
  // Everything else (tool calls, thinking, StatsBar) is removed for readability.
  const topChildren = Array.from(content.children) as HTMLElement[]
  for (const child of topChildren) {
    if (child.getAttribute('data-export') !== 'keep') {
      child.remove()
    }
  }

  content.style.padding = '12px 20px 20px'
  content.style.backgroundColor = '#ffffff'
  content.style.color = LIGHT_VARS['--color-text-primary']

  card.appendChild(content)
  if (stats) card.appendChild(buildStatsRow(stats))
  card.appendChild(buildFooter())
  outer.appendChild(card)
  container.appendChild(outer)

  try {
    await new Promise(resolve => requestAnimationFrame(resolve))

    const img = await snapdom.toPng(container, { dpr: 2 })

    // Reason: snapdom.toPng returns HTMLImageElement; convert src to blob for clipboard
    const res = await fetch(img.src)
    const blob = await res.blob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } finally {
    mountPoint.removeChild(container)
    mountPoint.removeChild(style)
  }
}
