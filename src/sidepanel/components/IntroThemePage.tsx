import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '@iconify/react'
import chatIcon from '@iconify-icons/lucide/message-circle'
import settingsIcon from '@iconify-icons/lucide/settings'
import arrowUpIcon from '@iconify-icons/lucide/arrow-up'
import { iconPlus } from '../../shared/icons'
import { resolveThemePreset, resolveThemeProperties, type ThemeMode } from '../../shared/themes'
import ChatComposer from './ChatComposer'
import { ModelSwitcherTrigger } from './ModelSwitcher'
import { ContextMeterTrigger } from './ContextMeter'

const ROWS = [
  ['swiss', 'klein', 'tundra', 'hermes'],
  ['dusk', 'memphis', 'muji', 'graphite'],
  ['bauhaus', 'luckin', 'acid', 'mono', 'ink'],
]
const ENGLISH: Record<string, string> = { swiss: 'SWISS RED', klein: 'KLEIN BLUE', tundra: 'TUNDRA', hermes: 'HERMÈS ORANGE', dusk: 'DUSK', memphis: 'MEMPHIS', muji: 'MUJI', graphite: 'GRAPHITE', bauhaus: 'BAUHAUS', luckin: 'LUCKIN BLUE', acid: 'ACID', mono: 'MONO', ink: 'INK', indigo: 'INDIGO' }

function ThemeCard({ id, selected, mode, onSelect }: { id: string; selected: string; mode: ThemeMode; onSelect: (id: string) => void }) {
  const preset = resolveThemePreset(id)
  return <button type="button" className="intro-theme-card" data-theme-id={id} style={resolveThemeProperties(id, mode) as CSSProperties}
    aria-label={`预览${preset.label}${id === 'swiss' ? '，推荐配色' : ''}`} aria-pressed={selected === id} onClick={() => onSelect(id)}>
    <span className="intro-theme-mini" aria-hidden="true"><span className="intro-theme-mini-accent" /><span className="intro-theme-mini-bubble" /><span className="intro-theme-mini-line" /><span className="intro-theme-mini-line short" /><span className="intro-theme-mini-input"><span /></span></span>
    <span className="intro-theme-card-label">{preset.label}<span aria-hidden="true" /></span>
    {id === 'swiss' && <span className="intro-theme-recommended">推荐</span>}
  </button>
}

function ThemeRow({ ids, index, active, reducedMotion, selected, mode, onSelect }: {
  ids: string[]; index: number; active: boolean; reducedMotion: boolean; selected: string; mode: ThemeMode; onSelect: (id: string) => void
}) {
  const reel = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ id: number; x: number; y: number; left: number; active: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const element = reel.current
    if (!element || !active) return
    let frame = 0, previous = 0, carry = 0
    const tick = (time: number) => {
      const width = (element.firstElementChild as HTMLElement).offsetWidth + 10
      const dt = previous ? Math.min(time - previous, 50) : 0
      previous = time
      if (width > 10 && !document.hidden && !reducedMotion && !gesture.current?.active) {
        carry += dt * [.012, .016, .01][index]
        const step = Math.floor(carry)
        carry -= step
        element.scrollLeft += index === 1 ? -step : step
        if (element.scrollLeft >= width) element.scrollLeft -= width
        else if (element.scrollLeft < 1 && index === 1) element.scrollLeft += width
      }
      frame = requestAnimationFrame(tick)
    }
    const width = (element.firstElementChild as HTMLElement).offsetWidth + 10
    if (!element.dataset.positioned && width > 10) {
      element.scrollLeft = index === 1 ? width - 58 : index === 2 ? 83 : 0
      element.dataset.positioned = 'true'
    }
    if (reducedMotion) return
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active, reducedMotion, index])

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.id !== event.pointerId) return
    if (current.active) {
      suppressClick.current = true
      event.preventDefault()
      event.stopPropagation()
      setDragging(false)
      if (event.currentTarget.hasPointerCapture(current.id)) event.currentTarget.releasePointerCapture(current.id)
    } else if (event.type !== 'pointercancel' && !(event.target as HTMLElement).closest('button')) {
      // Reason: inert loop copies have no keyboard stops; pointer hit testing still lets users choose their visible cards.
      for (const card of event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-theme-id]')) {
        const rect = card.getBoundingClientRect()
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
          onSelect(card.dataset.themeId!)
          break
        }
      }
    }
    gesture.current = null
  }
  return <div ref={reel} className="intro-theme-row" data-dragging={dragging || undefined} aria-label={`配色墙第 ${index + 1} 行`}
    onPointerDown={event => {
      if (event.button !== 0) return
      suppressClick.current = false
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, active: false }
    }}
    onPointerMove={event => {
      const current = gesture.current
      if (!current || current.id !== event.pointerId) return
      const dx = event.clientX - current.x, dy = event.clientY - current.y
      if (!current.active) {
        if (Math.abs(dx) < 6) return
        if (Math.abs(dy) > Math.abs(dx)) { gesture.current = null; return }
        current.active = true
        setDragging(true)
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      event.preventDefault()
      const width = (event.currentTarget.firstElementChild as HTMLElement).offsetWidth + 10
      if (width > 10) event.currentTarget.scrollLeft = ((current.left - dx) % width + width) % width
    }}
    onPointerUpCapture={finish} onPointerCancelCapture={finish}
    onLostPointerCapture={() => { gesture.current = null; setDragging(false) }}
    onPointerLeave={() => { if (!gesture.current?.active) gesture.current = null }}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } }}>
    {[false, true].map(copy => <div className="intro-theme-group" key={String(copy)} inert={copy} aria-hidden={copy || undefined}>
      {ids.map(id => <ThemeCard key={id} id={id} selected={selected} mode={mode} onSelect={onSelect} />)}
    </div>)}
  </div>
}

export default function IntroThemePage({ active, selected, mode, reducedMotion, onSelect }: { active: boolean; selected: string; mode: ThemeMode; reducedMotion: boolean; onSelect: (id: string) => void }) {
  return <>
    <div className="intro-theme-wall" aria-label="可横向拖拽的三行配色墙">{ROWS.map((ids, index) => <ThemeRow key={index} ids={ids} index={index} active={active} reducedMotion={reducedMotion} selected={selected} mode={mode} onSelect={onSelect} />)}</div>
    <div className="intro-theme-selected" aria-live="polite"><span><i aria-hidden="true" />{resolveThemePreset(selected).label}<small>预览中</small></span><span>{ENGLISH[selected]}</span></div>
    <div className="intro-theme-preview" aria-label="配色聊天预览">
      <header><span><Icon icon={chatIcon} />Chat</span><span>Pro</span><span>Dev</span><Icon icon={settingsIcon} /></header>
      <div className="intro-theme-conversation"><p className="update-intro-user">帮我把这篇文章理清楚。</p><p>当然。先抓重点，再展开聊。</p></div>
      <div className="intro-theme-composer"><div inert>
        <ChatComposer input={{ value: '', readOnly: true, placeholder: '继续问问这个页面…', 'aria-label': '配色预览输入框' }}
          attachmentControl={<span className="intro-theme-plus"><Icon icon={iconPlus} /></span>}
          modelControls={<><ModelSwitcherTrigger label="自选模型" open={false} /><ContextMeterTrigger ratio={.28} label="28%" /></>}
          actions={<span className="intro-theme-send"><Icon icon={arrowUpIcon} /></span>} />
      </div></div>
    </div>
  </>
}
