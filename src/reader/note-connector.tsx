import { useEffect, useState } from 'react'
import type { PdfNote } from '../shared/pdf-note-store'

const STROKE_HEX: Record<PdfNote['color'], string> = {
  yellow: '#ca8a04',
  green: '#059669',
  blue: '#2563eb',
  pink: '#db2777',
}

interface ConnectorPath {
  d: string
  sx: number
  sy: number
  color: string
}

// Reason: getBoundingClientRect is viewport-relative, so the SVG lives in a
// fixed inset-0 layer and never needs coordinate translation between the two
// independently scrolling containers.
function measure(note: PdfNote): ConnectorPath | null {
  const bands = Array.from(document.querySelectorAll<HTMLElement>(`[data-note-id="${note.id}"]`))
  const target = document.getElementById(`note-entry-${note.id}`)
  if (bands.length === 0 || !target) return null
  const end = target.getBoundingClientRect()
  const ey = end.top + end.height / 2
  // Reason: anchor on the band closest to the entry's height — the flattest
  // curve reads best and works regardless of how many lines the quote spans.
  let best = bands[0].getBoundingClientRect()
  let bestDy = Infinity
  for (const el of bands) {
    const r = el.getBoundingClientRect()
    const dy = Math.abs(r.top + r.height / 2 - ey)
    if (dy < bestDy) {
      bestDy = dy
      best = r
    }
  }
  const sx = best.right + 4
  const sy = best.top + best.height / 2
  const ex = end.left - 4
  if (ex <= sx) return null
  const dx = Math.max(24, Math.min(120, (ex - sx) / 2))
  return {
    d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`,
    sx,
    sy,
    color: STROKE_HEX[note.color],
  }
}

export function NoteConnector({
  note,
  zoom,
  sidebarOpen,
}: {
  note: PdfNote | null
  zoom: number | null
  sidebarOpen: boolean
}) {
  const [path, setPath] = useState<ConnectorPath | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    // Reason: capture-phase scroll on window catches scrolling inside any
    // scrollable descendant (main view + sidebar list) — scroll events do not
    // bubble, but they do pass through capturing ancestors.
    const bump = () => setTick(t => t + 1)
    window.addEventListener('scroll', bump, { capture: true, passive: true })
    window.addEventListener('resize', bump)
    return () => {
      window.removeEventListener('scroll', bump, { capture: true })
      window.removeEventListener('resize', bump)
    }
  }, [])

  useEffect(() => {
    if (!note) {
      setPath(null)
      return
    }
    const p = measure(note)
    setPath(p)
    // Reason: the note's page may still be lazily rendering when the note
    // activates — a short retry covers the async band mount without polling
    // forever (the active window itself times out).
    if (!p) {
      const t = setTimeout(() => setTick(v => v + 1), 350)
      return () => clearTimeout(t)
    }
  }, [note, zoom, sidebarOpen, tick])

  if (!note || !path) return null
  return (
    // Reason: keyed by note id so the draw-in animation replays per
    // activation, but not on scroll-driven path updates.
    <svg key={note.id} className="pointer-events-none fixed inset-0 z-40 h-full w-full">
      <path
        className="note-connector-path"
        d={path.d}
        fill="none"
        stroke={path.color}
        strokeWidth={1.5}
        strokeLinecap="round"
        pathLength={1}
      />
      <circle className="note-connector-dot" cx={path.sx} cy={path.sy} r={3} fill={path.color} />
    </svg>
  )
}
