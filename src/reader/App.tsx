import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfNote } from '../shared/pdf-note-store'
import type { NewNoteDraft } from './annotation-layer'
import { PageSlot } from './pdf-view'
import { NoteConnector } from './note-connector'
import { advanceNoteJump, type PendingNoteJump } from './note-navigation'
import { Sidebar } from './sidebar'
import { useDocIndex } from './use-doc-index'
import { appendNoteVfs, editNoteVfs, fetchNotes, loadPdfBytes, removeNotesVfs } from './vfs-client'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const COLORS: Array<PdfNote['color']> = ['yellow', 'green', 'blue', 'pink']
const COLOR_SWATCH: Record<PdfNote['color'], string> = {
  yellow: '#facc15',
  green: '#34d399',
  blue: '#60a5fa',
  pink: '#f472b6',
}

interface DraftState {
  data: NewNoteDraft
  rect: DOMRect
}

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), [])
  const sessionId = params.get('session') ?? ''
  const filePath = params.get('file') ?? ''
  const initialPage = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [documentVersion, setDocumentVersion] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scale, setScale] = useState<number | null>(null)
  const [notes, setNotes] = useState<PdfNote[]>([])
  const currentNotes = useMemo(() => notes.filter(note => note.documentVersion === documentVersion), [notes, documentVersion])
  const [itemCounts, setItemCounts] = useState<Map<number, number>>(new Map())
  const [currentPage, setCurrentPage] = useState(initialPage)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [draftText, setDraftText] = useState('')
  const [draftColor, setDraftColor] = useState<PdfNote['color']>('yellow')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const store = useDocIndex(doc)
  const scrollRef = useRef<HTMLDivElement>(null)
  const jumpedRef = useRef(false)
  const pendingJumpRef = useRef<PendingNoteJump | null>(null)
  const cancelNoteJump = useCallback(() => { pendingJumpRef.current = null }, [])
  // Reason: the pinch wheel handler needs the scale synchronously (wheel
  // bursts outpace React commits) and the anchor layout effect needs the
  // pending scroll target across the render boundary.
  const scaleRef = useRef<number | null>(null)
  const pinchAnchorRef = useRef<{ px: number; py: number; cx: number; cy: number; from: number } | null>(null)

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  // Reason: apply after the new page widths are committed — the content point
  // under the fingers must land back at the same viewport position.
  useLayoutEffect(() => {
    const a = pinchAnchorRef.current
    const el = scrollRef.current
    if (!a || scale === null || !el) return
    pinchAnchorRef.current = null
    const ratio = scale / a.from
    el.scrollLeft = a.cx * ratio - a.px
    el.scrollTop = a.cy * ratio - a.py
  }, [scale])

  useEffect(() => {
    // Reason: macOS trackpad pinch surfaces as ctrl+wheel; React attaches
    // wheel passively, so preventDefault (which stops Chrome's whole-page
    // zoom) needs a native non-passive listener.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const cur = scaleRef.current
      if (cur === null) return
      // Reason: pinch emits small deltaY bursts; the exponential map keeps
      // the gesture feeling uniform across zoom levels.
      const next = Math.min(4, Math.max(0.4, cur * Math.exp(-e.deltaY * 0.01)))
      if (next === cur) return
      // Reason: update synchronously — the effect-based sync runs after paint,
      // so a second wheel event in the same burst would recompute from a
      // stale base and visibly jump the zoom readout.
      scaleRef.current = next
      const el = scrollRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        pinchAnchorRef.current = { px, py, cx: el.scrollLeft + px, cy: el.scrollTop + py, from: cur }
      }
      setScale(next)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (!sessionId || !filePath) {
      setLoadError('缺少 session 或 file 参数 — 请从 Sideki 的 PDF 附件打开阅读器。')
      return
    }
    let alive = true
    loadPdfBytes(sessionId, filePath)
      .then(async ({ bytes, documentVersion }) => {
        const loaded = await pdfjsLib.getDocument({ data: bytes, useSystemFonts: false }).promise
        if (alive) {
          setDoc(loaded)
          setDocumentVersion(documentVersion)
          pendingJumpRef.current = null
        } else {
          await loaded.loadingTask.destroy()
        }
      })
      .catch(e => { if (alive) setLoadError(String(e)) })
    return () => {
      alive = false
    }
  }, [sessionId, filePath])

  const refreshNotes = useCallback(async () => {
    if (!sessionId || !filePath || !documentVersion) return
    try {
      setNotes(await fetchNotes(sessionId, filePath, documentVersion))
    } catch (e) {
      setToast(String(e))
    }
  }, [sessionId, filePath, documentVersion])

  useEffect(() => {
    refreshNotes()
  }, [refreshNotes])

  // Reason: the SW broadcasts pdfnote:changed after every write (bash command
  // or another reader tab) — this is the cross-context sync point.
  useEffect(() => {
    const listener = (msg: { type?: string; sessionId?: string }): undefined => {
      if (msg.type === 'pdfnote:changed' && msg.sessionId === sessionId) void refreshNotes()
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [sessionId, refreshNotes])

  // Reason: warm up all page dims sequentially so unmounted placeholder slots
  // get correct aspect ratios; getPage is cached by pdf.js core.
  useEffect(() => {
    if (!store) return
    let alive = true
    ;(async () => {
      for (let n = 1; n <= store.numPages; n++) {
        if (!alive) return
        await store.loadDim(n).catch(() => undefined)
      }
    })()
    return () => {
      alive = false
    }
  }, [store])

  useEffect(() => {
    if (scale !== null || !store) return
    let alive = true
    // Reason: fit page 1 to viewport width on first paint; every page is then
    // rendered at that scale (mixed-width pages keep their own aspect ratio).
    store.loadDim(1)
      .then(d => {
        if (!alive || !scrollRef.current) return
        const avail = scrollRef.current.clientWidth - 48
        setScale(Math.min(3, Math.max(0.4, avail / d.width)))
      })
      .catch(() => {
        if (alive) setScale(1)
      })
    return () => {
      alive = false
    }
  }, [store, scale])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!activeNoteId) return
    const t = setTimeout(() => setActiveNoteId(null), 4000)
    // Reason: the connector lands on the sidebar card — bring it into view so
    // the line has both endpoints on screen when a page highlight is clicked.
    document.getElementById(`note-entry-${activeNoteId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    return () => clearTimeout(t)
  }, [activeNoteId])

  useEffect(() => {
    if (jumpedRef.current || !store || scale === null) return
    jumpedRef.current = true
    if (initialPage > 1) {
      document.getElementById(`pdf-page-${initialPage}`)?.scrollIntoView({ block: 'start' })
    }
  }, [store, scale, initialPage])

  const handleDraft = useCallback((data: NewNoteDraft | null, rect: DOMRect | null) => {
    if (!data || !rect) {
      setDraft(null)
      return
    }
    setDraft({ data, rect })
    setDraftText('')
  }, [])

  const handleIndexLoad = useCallback((page: number, itemCount: number) => {
    setItemCounts(prev => {
      if (prev.get(page) === itemCount) return prev
      const next = new Map(prev)
      next.set(page, itemCount)
      return next
    })
  }, [])

  const noTextLayer = useMemo(() => {
    const counts = [...itemCounts.values()]
    return counts.length > 0 && counts.every(c => c === 0)
  }, [itemCounts])

  const saveDraft = async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      await appendNoteVfs(sessionId, filePath, {
        author: 'user',
        page: draft.data.page,
        quote: draft.data.quote,
        prefix: draft.data.prefix,
        suffix: draft.data.suffix,
        note: draftText.trim() || undefined,
        color: draftColor,
      }, documentVersion)
      setDraft(null)
      window.getSelection()?.removeAllRanges()
      await refreshNotes()
    } catch (e) {
      setToast(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = useCallback(
    async (ids: string[]) => {
      try {
        await removeNotesVfs(sessionId, filePath, ids, documentVersion)
        await refreshNotes()
      } catch (e) {
        setToast(String(e))
      }
    },
    [sessionId, filePath, documentVersion, refreshNotes],
  )

  const handleEdit = useCallback(
    async (id: string, note: string) => {
      try {
        await editNoteVfs(sessionId, filePath, id, note, documentVersion)
        await refreshNotes()
      } catch (e) {
        setToast(String(e))
      }
    },
    [sessionId, filePath, documentVersion, refreshNotes],
  )

  const handleJump = useCallback((note: PdfNote) => {
    const target = currentNotes.find(n => n.id === note.id)
    if (!target) return
    setActiveNoteId(target.id)
    pendingJumpRef.current = advanceNoteJump({ id: target.id, page: target.page, scrolledToPage: false }, currentNotes)
  }, [currentNotes])

  const handlePageLayout = useCallback((page: number) => {
    if (pendingJumpRef.current?.page !== page) return
    pendingJumpRef.current = advanceNoteJump(pendingJumpRef.current, currentNotes)
  }, [currentNotes])

  useLayoutEffect(() => {
    const pending = pendingJumpRef.current
    if (pending && !currentNotes.some(n => n.id === pending.id && n.page === pending.page)) cancelNoteJump()
  }, [currentNotes, cancelNoteJump])

  const gotoPage = (n: number) => {
    cancelNoteJump()
    if (!store) return
    const clamped = Math.max(1, Math.min(store.numPages, n))
    document.getElementById(`pdf-page-${clamped}`)?.scrollIntoView({ block: 'start' })
    setCurrentPage(clamped)
  }

  const trackPage = () => {
    const el = scrollRef.current
    if (!el) return
    const y = el.scrollTop + 60
    let cur = 1
    for (const slot of el.querySelectorAll<HTMLElement>('[data-pagenum]')) {
      if (slot.offsetTop <= y) cur = Number(slot.dataset.pagenum)
    }
    setCurrentPage(prev => (prev === cur ? prev : cur))
  }

  const zoom = (factor: number) => {
    cancelNoteJump()
    setScale(prev => Math.min(4, Math.max(0.4, Math.round((prev ?? 1) * factor * 100) / 100)))
  }

  const title = useMemo(() => filePath.split('/').pop() ?? filePath, [filePath])
  const activeNote = useMemo(
    () => currentNotes.find(n => n.id === activeNoteId) ?? null,
    [currentNotes, activeNoteId],
  )

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-surface px-8 text-center">
        <div className="text-sm text-error">{loadError}</div>
        <div className="text-xs text-text-muted">在 Sideki 中用「pdf open &lt;路径&gt;」或点击 PDF 附件的「阅读器」按钮打开。</div>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <span className="animate-pulse-glow text-xs text-text-muted">正在加载 PDF…</span>
      </div>
    )
  }

  const popoverLeft = draft
    ? Math.max(8, Math.min(window.innerWidth - 288, draft.rect.left + draft.rect.width / 2 - 140))
    : 0
  const popoverTop = draft
    ? draft.rect.bottom + 8 + 180 > window.innerHeight
      ? Math.max(8, draft.rect.top - 188)
      : draft.rect.bottom + 8
    : 0

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-text-primary">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border-muted bg-surface px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{title}</div>
          <div className="truncate text-[10px] text-text-muted">{filePath}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md px-2 py-1 text-sm text-text-secondary transition-colors hover:bg-surface-raised disabled:opacity-30"
            disabled={currentPage <= 1}
            onClick={() => gotoPage(currentPage - 1)}
          >
            ‹
          </button>
          <span className="min-w-14 text-center text-xs tabular-nums text-text-secondary">
            {currentPage} / {store?.numPages ?? '…'}
          </span>
          <button
            className="rounded-md px-2 py-1 text-sm text-text-secondary transition-colors hover:bg-surface-raised disabled:opacity-30"
            disabled={!store || currentPage >= store.numPages}
            onClick={() => gotoPage(currentPage + 1)}
          >
            ›
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md px-2 py-1 text-sm text-text-secondary transition-colors hover:bg-surface-raised"
            onClick={() => zoom(1 / 1.2)}
          >
            −
          </button>
          <span className="w-11 text-center text-xs tabular-nums text-text-secondary">
            {Math.round((scale ?? 1) * 100)}%
          </span>
          <button
            className="rounded-md px-2 py-1 text-sm text-text-secondary transition-colors hover:bg-surface-raised"
            onClick={() => zoom(1.2)}
          >
            +
          </button>
        </div>
        <button
          title={sidebarOpen ? '收起批注栏' : '展开批注栏'}
          className={`rounded-md px-2 py-1 text-xs transition-colors hover:bg-surface-raised ${
            sidebarOpen ? 'text-accent' : 'text-text-secondary'
          }`}
          onClick={() => setSidebarOpen(v => !v)}
        >
          批注
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main
          ref={scrollRef}
          onScroll={trackPage}
          onWheelCapture={cancelNoteJump}
          onPointerDownCapture={cancelNoteJump}
          onTouchStartCapture={cancelNoteJump}
          onKeyDownCapture={cancelNoteJump}
          className="min-w-0 flex-1 overflow-y-auto bg-surface-overlay/50"
        >
          {store && scale !== null && (
            <div className="flex flex-col items-center gap-4 py-6">
              {Array.from({ length: store.numPages }, (_, i) => i + 1).map(n => (
                <PageSlot
                  key={`${documentVersion}:${n}`}
                  n={n}
                  store={store}
                  scale={scale}
                  sessionId={sessionId}
                  filePath={filePath}
                  documentVersion={documentVersion}
                  notes={currentNotes}
                  activeNoteId={activeNoteId}
                  onNoteActivate={setActiveNoteId}
                  onDraft={handleDraft}
                  onIndexLoad={handleIndexLoad}
                  onSelectionError={setToast}
                  onPageLayout={handlePageLayout}
                />
              ))}
            </div>
          )}
        </main>
        {sidebarOpen && (
          <Sidebar
            notes={notes}
            documentVersion={documentVersion}
            activeNoteId={activeNoteId}
            noTextLayer={noTextLayer}
            onJump={handleJump}
            onRemove={handleRemove}
            onEdit={handleEdit}
          />
        )}
      </div>

      <NoteConnector note={activeNote} zoom={scale} sidebarOpen={sidebarOpen} />

      {draft && (
        <div
          className="fixed z-50 w-72 animate-slide-up-in rounded-lg border border-border-subtle bg-surface p-3 shadow-xl"
          style={{ left: popoverLeft, top: popoverTop }}
        >
          <div className="text-[10px] text-text-muted">第 {draft.data.page} 页 · 选中文本</div>
          <div className="mt-0.5 line-clamp-2 text-[11px] italic leading-snug text-text-secondary">
            “{draft.data.quote}”
          </div>
          <textarea
            autoFocus
            rows={3}
            value={draftText}
            onChange={e => setDraftText(e.target.value)}
            className="input-base mt-2 resize-none text-xs"
            placeholder="写下你的评论…"
          />
          <div className="mt-2 flex items-center justify-between">
            <div className="flex gap-1.5">
              {COLORS.map(c => (
                <button
                  key={c}
                  title={c}
                  className={`h-4 w-4 rounded-full transition-transform ${
                    draftColor === c ? 'scale-110 ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''
                  }`}
                  style={{ background: COLOR_SWATCH[c] }}
                  onClick={() => setDraftColor(c)}
                />
              ))}
            </div>
            <div className="flex gap-1.5">
              <button
                className="rounded-md px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay"
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button
                className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-40"
                disabled={saving}
                onClick={saveDraft}
              >
                {saving ? '保存中…' : '保存批注'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-surface-overlay px-3 py-1.5 text-xs text-error shadow-lg ring-1 ring-border-subtle">
          {toast}
        </div>
      )}
    </div>
  )
}
