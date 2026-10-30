import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TextLayer, type PageViewport, type RenderTask } from 'pdfjs-dist'
import type { PdfNote } from '../shared/pdf-note-store'
import {
  AnnotationBands,
  CROSS_PAGE_SELECTION_MESSAGE,
  computeNoteBands,
  hitTestNote,
  selectionStaysOnPage,
  selectionToDraft,
  type NewNoteDraft,
  type NoteBands,
  type TextLayerGeometry,
} from './annotation-layer'
import type { DocStore, PageData } from './use-doc-index'
import { usePageMarkdown } from './use-page-md'

interface PageSlotProps {
  n: number
  store: DocStore
  scale: number
  sessionId: string
  filePath: string
  documentVersion: string
  notes: PdfNote[]
  activeNoteId: string | null
  onNoteActivate: (id: string) => void
  onDraft: (draft: NewNoteDraft | null, screenRect: DOMRect | null) => void
  onIndexLoad: (page: number, itemCount: number) => void
  onSelectionError: (message: string) => void
  onPageLayout: (page: number) => void
}

export function PageSlot({
  n,
  store,
  scale,
  sessionId,
  filePath,
  documentVersion,
  notes,
  activeNoteId,
  onNoteActivate,
  onDraft,
  onIndexLoad,
  onSelectionError,
  onPageLayout,
}: PageSlotProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [near, setNear] = useState(false)
  const [data, setData] = useState<PageData | null>(null)
  const [dim, setDim] = useState<{ width: number; height: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [textLayer, setTextLayer] = useState<{
    data: PageData; viewport: PageViewport; geometry: TextLayerGeometry
  } | null>(null)
  const [layoutTick, setLayoutTick] = useState(0)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      rootMargin: '150% 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!near) return
    let alive = true
    store.loadDim(n).then(d => {
      if (alive) setDim(d)
    }).catch(e => setError(String(e)))
    store.load(n).then(d => {
      if (alive) setData(d)
    }).catch(e => setError(String(e)))
    return () => {
      alive = false
    }
  }, [near, n, store])

  useEffect(() => {
    if (data) onIndexLoad(n, data.index.itemCount)
  }, [data, n, onIndexLoad])

  const viewport = useMemo<PageViewport | null>(
    () => (data ? data.page.getViewport({ scale }) : null),
    [data, scale],
  )

  useEffect(() => {
    if (!viewport || !data || !canvasRef.current) return
    const canvas = canvasRef.current
    // Reason: render at device pixels for crisp text, but keep the CSS box at
    // viewport size — the text layer and highlight bands are laid out in CSS
    // pixels and must stay in sync with the canvas box.
    const dpr = window.devicePixelRatio || 1
    const renderViewport = data.page.getViewport({ scale: scale * dpr })
    // Reason: CSS size updates immediately (text layer must stay aligned), but
    // the bitmap swap waits for the render — assigning canvas.width clears
    // the bitmap to transparent, so doing it up-front makes rapid zoom bursts
    // flash blank/content; the stale bitmap stretched by CSS is the visible
    // interim instead.
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const off = document.createElement('canvas')
    off.width = Math.ceil(renderViewport.width)
    off.height = Math.ceil(renderViewport.height)
    renderTaskRef.current?.cancel()
    const task = data.page.render({ canvas: off, viewport: renderViewport })
    renderTaskRef.current = task
    let alive = true
    task.promise
      .then(() => {
        if (!alive) return
        canvas.width = off.width
        canvas.height = off.height
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.drawImage(off, 0, 0)
      })
      .catch(e => {
        if (alive && (e as { name?: string }).name !== 'RenderingCancelledException') setError(String(e))
      })
    return () => {
      alive = false
      task.cancel()
    }
  }, [viewport, data, scale])

  useLayoutEffect(() => {
    const host = textRef.current
    const pageElement = boxRef.current
    if (!data || !viewport || !host || !pageElement) return
    // Reason: a cancelled async render must never append spans into its replacement's container.
    const container = document.createElement('div')
    container.className = 'pdf-text-layer'
    host.replaceChildren(container)
    const totalScale = viewport.scale * viewport.userUnit
    container.style.setProperty('--total-scale-factor', String(totalScale))
    const layer = new TextLayer({ textContentSource: data.textContent, container, viewport })
    const sideways = viewport.rotation % 180 !== 0
    container.style.width = `${sideways ? viewport.height : viewport.width}px`
    container.style.height = `${sideways ? viewport.width : viewport.height}px`
    let alive = true
    layer.render().then(() => document.fonts.ready).then(() => {
      if (!alive) return
      // Reason: textDivs includes empty items even though their spans are not attached to the DOM.
      layer.textDivs.forEach((div, i) => { div.dataset.item = String(i) })
      setTextLayer({ data, viewport, geometry: { pageElement, textDivs: layer.textDivs } })
    }).catch(e => { if (alive) setError(String(e)) })
    return () => {
      alive = false
      layer.cancel()
      container.remove()
    }
  }, [data, viewport])

  useEffect(() => {
    if (!textLayer || !near) return
    let frame = 0
    const update = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setLayoutTick(t => t + 1)
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(textLayer.geometry.pageElement)
    window.addEventListener('scroll', update, { capture: true, passive: true })
    window.addEventListener('resize', update)
    document.fonts.addEventListener('loadingdone', update)
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      document.fonts.removeEventListener('loadingdone', update)
    }
  }, [textLayer, near])

  const hasAiNote = useMemo(() => notes.some(nt => nt.author === 'ai' && nt.page === n), [notes, n])
  const mdNorm = usePageMarkdown(sessionId, filePath, n, hasAiNote, documentVersion)

  const [bands, setBands] = useState<NoteBands[]>([])
  useLayoutEffect(() => {
    setBands(data && viewport && textLayer?.data === data && textLayer.viewport === viewport
      ? computeNoteBands(notes, data, viewport, textLayer.geometry, mdNorm)
      : [])
  }, [data, viewport, textLayer, notes, mdNorm, layoutTick])

  useLayoutEffect(() => { onPageLayout(n) }, [bands, n, onPageLayout])

  const handleMouseUp = () => {
    const sel = window.getSelection()
    const el = textRef.current
    const box = boxRef.current
    if (!sel || sel.isCollapsed) {
      onDraft(null, null)
      return
    }
    if (box && !selectionStaysOnPage(sel, box)) {
      onDraft(null, null)
      onSelectionError(CROSS_PAGE_SELECTION_MESSAGE)
      return
    }
    if (!el || !data || textLayer?.viewport !== viewport) return
    const draft = selectionToDraft(sel, el, data)
    const rect = sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null
    onDraft(draft, draft && rect ? rect : null)
  }

  const handleClick = (e: React.MouseEvent) => {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    if (!bands.length) return
    const box = boxRef.current
    if (!box || !viewport) return
    const rect = box.getBoundingClientRect()
    const note = hitTestNote(bands,
      (e.clientX - rect.left) * viewport.width / rect.width,
      (e.clientY - rect.top) * viewport.height / rect.height,
    )
    if (note) onNoteActivate(note.id)
  }

  const size = data?.base ?? dim
  const width = (size?.width ?? 595) * scale
  const height = (size?.height ?? 842) * scale

  return (
    <div
      id={`pdf-page-${n}`}
      data-pagenum={n}
      ref={boxRef}
      className="relative shrink-0 overflow-clip rounded-md bg-white shadow-sm ring-1 ring-border-muted"
      style={{ width, height }}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
    >
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center px-6 text-center text-xs text-error">
          {error}
        </div>
      )}
      {data && viewport && (
        <>
          <canvas ref={canvasRef} className="absolute left-0 top-0 z-0" />
          <AnnotationBands bands={bands} activeNoteId={activeNoteId} />
          <div ref={textRef} className="absolute inset-0 z-20" />
        </>
      )}
      {!data && !error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-[11px] text-text-muted">
          第 {n} 页
        </div>
      )}
    </div>
  )
}
