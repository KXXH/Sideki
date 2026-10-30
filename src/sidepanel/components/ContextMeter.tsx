import { useState, useRef, useEffect, useId, type CSSProperties, type ComponentPropsWithRef } from 'react'
import { Icon } from '@iconify/react'
import { iconLoading, iconBrain } from '../../shared/icons'
import AnimatedPopover from './AnimatedPopover'
import { usePopoverHeight } from '../hooks/use-popover-height'

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

function ContextRing({ ratio }: { ratio: number }) {
  return <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 rounded-full" style={{
    background: `conic-gradient(currentColor ${ratio * 360}deg, var(--color-border-subtle) 0deg)`,
    maskImage: 'radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))',
  }} />
}

export function ContextMeterTrigger({ ratio, label, ...props }: ComponentPropsWithRef<'button'> & { ratio: number; label: string }) {
  const textColor = ratio > 0.9 ? 'text-error/70' : ratio > 0.7 ? 'text-warning/70' : 'text-text-muted'
  return <button {...props} type="button" className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 py-1 text-[11px] tabular-nums transition-colors hover:bg-surface-overlay ${textColor}`}><ContextRing ratio={ratio} />{label}</button>
}

export function EmptyContextMeter() {
  return <span role="img" aria-label="上下文占用 0%，用量尚不可用" title="上下文用量尚不可用" className="flex shrink-0 items-center gap-1 rounded-md px-1 py-1 text-[11px] tabular-nums text-text-muted">
    <ContextRing ratio={0} />0%
  </span>
}

export function ContextMeter({
  used, total, exact = false, onCompact, compacting = false, canCompact = false, direction = 'down',
}: {
  used: number; total: number; exact?: boolean
  onCompact?: () => void; compacting?: boolean; canCompact?: boolean
  direction?: 'up' | 'down'
}) {
  const ratio = total > 0 ? Math.max(0, Math.min(used / total, 1)) : 0
  const pct = Math.round(ratio * 100)
  // Reason: 0% alongside a non-empty meter reads as "nothing used"; <1% keeps
  // small but real usage honest without spending width on a decimal.
  const pctLabel = pct === 0 && used > 0 ? '<1%' : `${pct}%`
  const barColor = ratio > 0.9 ? 'bg-error' : ratio > 0.7 ? 'bg-warning' : 'bg-success/60'
  const barGlow = ratio > 0.9 ? 'shadow-error/40' : ratio > 0.7 ? 'shadow-warning/30' : ''
  const pctColor = ratio > 0.9 ? 'text-error' : ratio > 0.7 ? 'text-warning' : 'text-text-secondary'

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const anchor = `--context-${id.replace(/[^a-zA-Z0-9-]/g, '')}`
  const maxHeight = usePopoverHeight(open, ref, direction)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); ref.current?.focus() } }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', keyHandler) }
  }, [open])

  return (
    <div className="shrink-0">
      <ContextMeterTrigger ratio={ratio} label={pctLabel}
        ref={ref}
        type="button"
        style={{ anchorName: anchor } as CSSProperties}
        onClick={() => setOpen(v => !v)}
        title={`上下文 ${pctLabel} · ${exact ? '' : '~'}${formatTokens(used)} / ${formatTokens(total)}`}
        aria-label={`上下文占用 ${pctLabel}`}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
      />

      <AnimatedPopover open={open} direction={direction} ref={popRef} id={id} role="dialog" aria-label="上下文用量"
        style={{ positionAnchor: anchor, maxHeight, ...(direction === 'up' ? { bottom: 'anchor(top)' } : { top: 'anchor(bottom)' }), left: 'clamp(8px, anchor(left), calc(100vw - 240px))' } as CSSProperties}
        className={`theme-overlay fixed z-50 w-56 max-w-[calc(100vw_-_16px)] overflow-y-auto rounded-lg ${direction === 'up' ? 'mb-2' : 'mt-1.5'}`}>
          {/* Header with large percentage */}
          <div className="px-4 pt-4 pb-3">
            <div className="flex items-baseline justify-between">
              <span className={`text-2xl font-semibold tracking-tight tabular-nums ${pctColor}`}>{pctLabel}</span>
              <span className="text-[10px] tabular-nums text-text-muted">
                {exact ? '' : '~'}{formatTokens(used)} / {formatTokens(total)}
              </span>
            </div>
            {/* Progress bar */}
            <div className={`mt-2.5 h-1 overflow-hidden rounded-full bg-surface-overlay ${barGlow ? `shadow-[0_0_8px] ${barGlow}` : ''}`}>
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${barColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Compress action */}
          {onCompact && (
            <div className="border-t border-border-subtle px-4 py-3">
              <button
                onClick={() => { onCompact(); setOpen(false) }}
                disabled={!canCompact || compacting}
                className="group flex w-full items-center gap-2 rounded-lg border border-accent/20 bg-accent-wash px-3 py-2 text-[11px] font-medium text-accent transition-all hover:border-accent/30 hover:bg-accent-glow hover:shadow-[0_0_12px_var(--color-accent-wash)] disabled:pointer-events-none disabled:opacity-30"
              >
                {compacting ? (
                  <>
                    <Icon icon={iconLoading} className="shrink-0 animate-spin text-sm" />
                    <span>压缩中…</span>
                  </>
                ) : (
                  <>
                    <Icon icon={iconBrain} className="shrink-0 text-sm text-accent/70 transition-colors group-hover:text-accent" />
                    <span>压缩上下文</span>
                  </>
                )}
              </button>
              <p className="mt-2 px-0.5 text-[10px] leading-relaxed text-text-muted">
                保留最近 3 轮对话，压缩其余为摘要
              </p>
            </div>
          )}
        </AnimatedPopover>
    </div>
  )
}
