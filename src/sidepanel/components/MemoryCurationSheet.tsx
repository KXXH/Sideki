import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { iconAlertCircleOutline } from '../../shared/icons'
import AppDialog, { DialogAction } from './AppDialog'
import HerHelix from './HerHelix'
import ShinyText from './ShinyText'
import { t } from '../../shared/i18n'
import type { ApiConfig } from '../../shared/types'
import { generateCurationProposal, computeLineDiff } from '../../shared/memory-curator'
import type { CurationResult } from '../../shared/memory-curator'
import { GLOBAL_LIMIT, SITE_LIMIT, parseMemoryLines } from '../../shared/memory-storage'

type Phase = 'intro' | 'generating' | 'review' | 'applying' | 'done' | 'error'

// Reason: phases have very different natural heights — animate the wrapper
// between measured pixel heights so the sheet grows/shrinks smoothly instead
// of jumping when the loading screen is swapped for the review data.
function AnimatedHeight({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div
      className="overflow-hidden transition-[height] duration-300 ease-out"
      style={{ height: height === null ? 'auto' : height }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  )
}

interface Props {
  open: boolean
  onClose: () => void
  config: ApiConfig | null
  showIntro: boolean
  onIntroSeen: () => void
  onApplied: () => void
}

// Reason: final store text = proposal lines minus vetoed additions, plus
// vetoed removals appended back — every checkbox maps to a deterministic edit.
function buildFinalText(
  proposalText: string,
  added: string[],
  removed: string[],
  vetoedAdded: Set<string>,
  vetoedRemoved: Set<string>,
): string {
  const addedSet = new Set(added)
  const lines = parseMemoryLines(proposalText).filter(l => !(addedSet.has(l) && vetoedAdded.has(l)))
  for (const l of removed) {
    if (vetoedRemoved.has(l)) lines.push(l)
  }
  return lines.join('\n')
}

export default function MemoryCurationSheet({ open, onClose, config, showIntro, onIntroSeen, onApplied }: Props) {
  const [phase, setPhase] = useState<Phase>('intro')
  const [error, setError] = useState('')
  const [result, setResult] = useState<CurationResult | null>(null)
  // Vetoed (unchecked) items — default empty = everything approved
  const [vetoAddG, setVetoAddG] = useState<Set<string>>(new Set())
  const [vetoRemG, setVetoRemG] = useState<Set<string>>(new Set())
  const [vetoAddS, setVetoAddS] = useState<Set<string>>(new Set())
  const [vetoRemS, setVetoRemS] = useState<Set<string>>(new Set())
  const [vetoNotes, setVetoNotes] = useState<Set<string>>(new Set())
  const [doneStats, setDoneStats] = useState<{ promoted: number; dropped: number }>({ promoted: 0, dropped: 0 })
  // Reason: helixDone drives the Her-style outro — the proposal may be ready,
  // but the review screen waits until the helix has collapsed into the circle.
  const [helixDone, setHelixDone] = useState(false)

  const generate = useCallback(async () => {
    if (!config) { setError('未配置模型'); setPhase('error'); return }
    setPhase('generating')
    setError('')
    setHelixDone(false)
    try {
      let hostname = ''
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        hostname = tab?.url ? new URL(tab.url).hostname : ''
        if (!hostname.includes('.')) hostname = ''
      } catch { /* no active tab */ }
      const r = await generateCurationProposal(config, hostname)
      setResult(r)
      setVetoAddG(new Set()); setVetoRemG(new Set())
      setVetoAddS(new Set()); setVetoRemS(new Set())
      setVetoNotes(new Set())
      // Reason: don't switch phases here — the helix outro (morph to circle +
      // fade) plays first; its onDone callback moves us to review.
      setHelixDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [config])

  useEffect(() => {
    if (!open) return
    setResult(null)
    if (showIntro) { setPhase('intro'); return }
    generate()
  }, [open, showIntro, generate])

  const globalDiff = useMemo(() => result ? computeLineDiff(result.oldGlobal, result.proposal.globalText) : null, [result])
  const siteDiff = useMemo(() => (result && result.proposal.siteText !== null) ? computeLineDiff(result.oldSite, result.proposal.siteText) : null, [result])

  const finalGlobal = useMemo(() => {
    if (!result || !globalDiff) return ''
    return buildFinalText(result.proposal.globalText, globalDiff.added, globalDiff.removed, vetoAddG, vetoRemG)
  }, [result, globalDiff, vetoAddG, vetoRemG])

  const finalSite = useMemo(() => {
    if (!result || !siteDiff || result.proposal.siteText === null) return null
    return buildFinalText(result.proposal.siteText, siteDiff.added, siteDiff.removed, vetoAddS, vetoRemS)
  }, [result, siteDiff, vetoAddS, vetoRemS])

  const evictions = useMemo(() => {
    if (!result) return []
    return result.proposal.notes.filter(v => v.verdict !== 'keep' && !vetoNotes.has(v.id))
  }, [result, vetoNotes])

  const globalOver = finalGlobal.length > GLOBAL_LIMIT
  const siteOver = finalSite !== null && finalSite.length > SITE_LIMIT
  const hasChanges = !!result && (
    (globalDiff && (globalDiff.added.length > 0 || globalDiff.removed.length > 0)) ||
    (siteDiff && (siteDiff.added.length > 0 || siteDiff.removed.length > 0)) ||
    result.proposal.notes.some(v => v.verdict !== 'keep')
  )

  const apply = async () => {
    if (!result) return
    setPhase('applying')
    const promoted = evictions.filter(v => v.verdict === 'promoted').length
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'memory:apply-curation',
        plan: {
          hostname: result.hostname || undefined,
          globalText: finalGlobal,
          siteText: finalSite ?? undefined,
          dropNoteIds: evictions.map(v => v.id),
          fingerprint: result.fingerprint,
        },
      }) as { ok: boolean; error?: string }
      if (!res?.ok) { setError(res?.error ?? 'apply failed'); setPhase('error'); return }
      setDoneStats({ promoted, dropped: evictions.length })
      setPhase('done')
      onApplied()
    } catch (e) {
      setError(String(e))
      setPhase('error')
    }
  }

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  const noteContent = (id: string) => result?.notes.find(n => n.id === id)?.content ?? ''

  // Reason: accent + dim from the live theme vars — re-read on every open, the
  // sheet stays mounted across theme switches so an empty dep array would
  // freeze the palette at mount time.
  const helixColors = useMemo<[string, string]>(() => {
    const css = getComputedStyle(document.documentElement)
    const accent = css.getPropertyValue('--color-accent').trim() || '#6366f1'
    const dim = css.getPropertyValue('--color-accent-dim').trim() || '#4f46e5'
    return [accent, dim]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read CSS vars when the sheet opens
  }, [open])

  const renderStoreDiff = (
    label: string,
    diff: { added: string[]; removed: string[]; keptCount: number },
    vetoAdd: Set<string>, setVA: (s: Set<string>) => void,
    vetoRem: Set<string>, setVR: (s: Set<string>) => void,
    finalLen: number, limit: number, over: boolean,
  ) => {
    if (diff.added.length === 0 && diff.removed.length === 0) return null
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-text-secondary">{label}</p>
          <span className={`font-mono text-[9px] ${over ? 'text-red-400' : 'text-text-muted'}`}>{finalLen}/{limit}</span>
        </div>
        {diff.added.map(line => (
          <label key={`+${line}`} className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-overlay/50 px-2.5 py-1.5">
            <input type="checkbox" checked={!vetoAdd.has(line)} onChange={() => toggle(vetoAdd, setVA, line)} className="mt-0.5 shrink-0" />
            <span className="text-[10px] leading-snug text-text-secondary"><span className="mr-1 font-mono text-accent">+</span>{line}</span>
          </label>
        ))}
        {diff.removed.map(line => (
          <label key={`-${line}`} className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-overlay/30 px-2.5 py-1.5">
            <input type="checkbox" checked={!vetoRem.has(line)} onChange={() => toggle(vetoRem, setVR, line)} className="mt-0.5 shrink-0" />
            <span className="text-[10px] leading-snug text-text-muted line-through"><span className="mr-1 font-mono text-red-400 no-underline">−</span>{line}</span>
          </label>
        ))}
        {diff.keptCount > 0 && <p className="px-1 text-[9px] text-text-muted">{t.memoryCurateKept(diff.keptCount)}</p>}
      </div>
    )
  }

  if (!open) return null

  return (
    <AppDialog open={open} title={t.memoryCurateTitle} placement="bottom" onClose={onClose} dismissible={phase !== 'applying'} footer={<>
      {phase !== 'done' && <DialogAction onClick={onClose} disabled={phase === 'applying'}>{phase === 'intro' ? t.memoryCurateLater : phase === 'generating' ? '关闭' : t.cancel}</DialogAction>}
      {phase === 'intro' && <DialogAction variant="primary" onClick={() => { onIntroSeen(); generate() }}>{t.memoryCurateStart}</DialogAction>}
      {phase === 'error' && <DialogAction variant="primary" onClick={generate}>{t.memoryCurateRetry}</DialogAction>}
      {phase === 'review' && result && hasChanges && <DialogAction variant="primary" onClick={apply} disabled={globalOver || siteOver}>{t.memoryCurateApply}</DialogAction>}
      {phase === 'applying' && <DialogAction variant="primary" disabled>{t.memoryCurateApplying}</DialogAction>}
      {(phase === 'done' || phase === 'review' && !hasChanges) && <DialogAction variant="primary" onClick={onClose}>知道了</DialogAction>}
    </>}>
        <AnimatedHeight>
        {phase === 'intro' && (
          <div className="flex flex-col gap-3">
            <p className="text-[12px] font-medium text-text-primary">{t.memoryCurateIntroTitle}</p>
            <ul className="flex flex-col gap-1.5">
              {t.memoryCurateIntro.map((line, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-text-secondary">· {line}</li>
              ))}
            </ul>
          </div>
        )}

        {phase === 'generating' && (
          <div className="curation-loading relative flex min-h-[180px] flex-col items-center justify-end overflow-hidden pb-4">
            <div className="pointer-events-none absolute inset-0">
              <HerHelix
                colors={helixColors}
                done={helixDone}
                onDone={() => setPhase('review')}
              />
            </div>
            <p className="relative z-10 text-[11px]">
              <ShinyText text={t.memoryCurateGenerating} />
            </p>
          </div>
        )}

        {phase === 'review' && result && (
          hasChanges ? (
            <div className="animate-fade-in-up flex flex-col gap-4">
              {(globalOver || siteOver) && <p role="alert" className="text-xs text-error">{t.memoryCurateOverLimit}</p>}
              {result.proposal.warnings.length > 0 && (
                <div className="flex flex-col gap-1 rounded-lg bg-surface-overlay/40 px-2.5 py-2">
                  {result.proposal.warnings.map((w, i) => (
                    <p key={i} className="flex items-start gap-1 text-[9px] text-amber-400">
                      <Icon icon={iconAlertCircleOutline} className="mt-px shrink-0" />{w}
                    </p>
                  ))}
                </div>
              )}
              {globalDiff && renderStoreDiff(
                t.memoryGlobal, globalDiff, vetoAddG, setVetoAddG, vetoRemG, setVetoRemG,
                finalGlobal.length, GLOBAL_LIMIT, globalOver,
              )}
              {siteDiff && result.proposal.siteText !== null && renderStoreDiff(
                `${t.memorySites} (${result.hostname})`, siteDiff, vetoAddS, setVetoAddS, vetoRemS, setVetoRemS,
                finalSite?.length ?? 0, SITE_LIMIT, siteOver,
              )}
              {result.proposal.notes.some(v => v.verdict !== 'keep') && (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] font-medium text-text-secondary">{t.memoryNotes}</p>
                  {result.proposal.notes.filter(v => v.verdict !== 'keep').map(v => (
                    <label key={v.id} className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-overlay/30 px-2.5 py-1.5">
                      <input type="checkbox" checked={!vetoNotes.has(v.id)} onChange={() => toggle(vetoNotes, setVetoNotes, v.id)} className="mt-0.5 shrink-0" />
                      <span className="flex-1 text-[10px] leading-snug">
                        <span className={`text-text-muted ${vetoNotes.has(v.id) ? '' : 'line-through'}`}>{noteContent(v.id)}</span>
                        <span className="mt-0.5 block text-[9px] text-text-muted">
                          {v.verdict === 'promoted' ? t.memoryCuratePromoted : `${t.memoryCurateDropReason}: ${v.reason || '—'}`}
                        </span>
                      </span>
                    </label>
                  ))}
                  <p className="px-1 text-[9px] text-text-muted">
                    {t.memoryCurateNotesKept(result.proposal.notes.filter(v => v.verdict === 'keep').length + vetoNotes.size)}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="animate-fade-in-up flex min-h-[120px] items-center justify-center">
              <p className="text-[11px] text-text-muted">{t.memoryCurateNothing}</p>
            </div>
          )
        )}

        {phase === 'applying' && (
          <div className="flex min-h-[120px] items-center justify-center">
            <p className="text-[11px] text-text-muted">{t.memoryCurateApplying}</p>
          </div>
        )}

        {phase === 'done' && (
          <div className="animate-fade-in-up flex min-h-[120px] items-center justify-center">
            <p className="text-[11px] text-text-secondary">{t.memoryCurateDone(doneStats.promoted, doneStats.dropped)}</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-2">
            <p className="max-w-full break-all px-2 text-center text-[10px] text-red-400">{error}</p>
          </div>
        )}
        </AnimatedHeight>
    </AppDialog>
  )
}
