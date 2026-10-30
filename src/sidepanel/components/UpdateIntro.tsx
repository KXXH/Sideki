import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { Icon } from '@iconify/react'
import arrowIcon from '@iconify-icons/lucide/arrow-right'
import arrowLeftIcon from '@iconify-icons/lucide/arrow-left'
import chatIcon from '@iconify-icons/lucide/message-circle'
import { iconClose, iconPlus, iconChevronDown } from '../../shared/icons'
import Header from './Header'
import ChatComposer from './ChatComposer'
import ComposerActions from './ComposerActions'
import QueueStrip from './QueueStrip'
import { TodoStripContent, type TodoItem } from './TodoStrip'
import { ModelSwitcherTrigger } from './ModelSwitcher'
import { ContextMeterTrigger } from './ContextMeter'
import { ScheduledTaskButton, ScheduledTaskRow, TimerWakeEvent } from './ScheduledTaskStrip'
import AnimatedPopover from './AnimatedPopover'
import type { QueuedMessage } from '../hooks/useSidekickChat'
import type { ScheduledTask } from '../../shared/scheduled-task'
import IntroThemePage from './IntroThemePage'
import ModelServiceForm from './ModelServiceForm'
import { addServiceModel, updateServiceModel, configProfiles } from '../../shared/model-services'
import type { IntroKind } from '../hooks/use-update-intro'
import { DEFAULT_CONFIG } from '../default-config'
import { loadConfig, saveConfig } from '../../shared/storage'
import { applyTheme, DEFAULT_THEME_ID, getResolvedThemeMode, normalizeThemeId, resolveThemePreset, resolveThemeProperties, THEME_CHANGE_EVENT } from '../../shared/themes'
import './update-intro.css'

const TODOS: TodoItem[] = [
  { id: 1, text: '检查页面结构', status: 'completed' },
  { id: 2, text: '检查按钮间距与对齐', status: 'in_progress' },
  { id: 3, text: '复查移动端布局', status: 'pending' },
]
const INITIAL_QUEUE: QueuedMessage[] = [
  { id: 'example-queue-1', text: '看看窄屏下的布局。' },
  { id: 'example-queue-2', text: '再核对一下按钮间距。' },
]
const EXAMPLE_TIME = new Date('2026-10-26T14:35:00+08:00').getTime()
const baseTask = { sessionId: 'update-example', instruction: '复查页面布局，把结果留在这段会话中。', tabId: 0, pageTitle: '示例页面', pageUrl: 'about:blank', createdAt: EXAMPLE_TIME, nextRunAt: EXAMPLE_TIME, maxRuns: 5, runs: 0, status: 'scheduled' as const }
const EXAMPLE_TASKS: ScheduledTask[] = [
  { ...baseTask, id: 'example-timer', title: '五分钟后复查布局', intervalMs: 300_000 },
  { ...baseTask, id: 'example-trigger', kind: 'monitor', title: '出现新错误时提醒我', monitor: { token: '', code: '', documentId: '', expiresAt: EXAMPLE_TIME + 3600_000, listening: true, received: 0, coalesced: 0 } },
]

type IntroPage = 'chat' | 'themes' | 'connect' | 'canvas'

type Popup = 'tasks' | 'model' | 'context' | null

function Doodles({ figure, active, canvas = false }: { figure: RefObject<HTMLDivElement | null>; active: boolean; canvas?: boolean }) {
  const [paths, setPaths] = useState<string[]>([])
  useEffect(() => {
    const element = figure.current
    if (!element || !active) return
    const draw = () => {
      const base = element.getBoundingClientRect()
      if (!base.width) return
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect()
        return { x: rect.left - base.left, y: rect.top - base.top, w: rect.width, h: rect.height }
      }
      const next: string[] = []
      for (const key of canvas ? ['canvas'] : ['tasks', 'model', 'action']) {
        const target = element.querySelector(`[data-intro-target="${key}"]`)
        const label = element.querySelector(`[data-intro-label="${key}"]`)
        if (!target || !label) continue
        const t = box(target), n = box(label)
        if (!t.w || !t.h) continue
        const cx = t.x + t.w / 2, cy = t.y + t.h / 2, rx = t.w / 2 + 5, ry = t.h / 2 + 5
        next.push(`M ${cx-rx} ${cy+2} C ${cx-rx-4} ${cy-ry-5},${cx+rx+2} ${cy-ry-2},${cx+rx} ${cy-1} C ${cx+rx+3} ${cy+ry+5},${cx-rx-3} ${cy+ry+2},${cx-rx} ${cy+2}`)
        const sx = key === 'tasks' ? n.x + n.w + 6 : n.x + n.w * (canvas ? .8 : .55)
        const sy = key === 'tasks' ? n.y + n.h * .6 : n.y - 7
        const ex = canvas ? cx + rx * .84 : cx
        const ey = canvas ? cy + ry * .62 + 8 : key === 'tasks' ? cy - ry - 4 : cy + ry + 4
        const mx = canvas ? ex - 14 : key === 'tasks' ? Math.min(sx + 65, base.width - 12) : sx + 14
        const my = canvas ? ey + 38 : key === 'tasks' ? sy + 2 : ey + 18
        next.push(canvas
          ? `M ${sx} ${sy} C ${sx + (ex - sx) * .42} ${sy - 12},${mx} ${my},${ex} ${ey}`
          : `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`)
        const a = Math.atan2(ey - my, ex - mx), len = canvas ? 8 : 5
        next.push(`M ${ex-Math.cos(a-.55)*len} ${ey-Math.sin(a-.55)*len} L ${ex} ${ey} L ${ex-Math.cos(a+.55)*len} ${ey-Math.sin(a+.55)*len}`)
      }
      setPaths(previous => previous.join('') === next.join('') ? previous : next)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    element.querySelectorAll('[data-intro-target], [data-intro-label]').forEach(target => observer.observe(target))
    window.addEventListener('resize', draw)
    return () => { observer.disconnect(); window.removeEventListener('resize', draw) }
  }, [figure, active, canvas])
  return <svg className="update-intro-doodles" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths.map((d, index) => <path key={index} d={d} />)}</g></svg>
}

function CanvasExample({ active }: { active: boolean }) {
  const scene = useRef<HTMLDivElement>(null)
  const peopleId = useId()
  const [people, setPeople] = useState(2)
  const taxi = 120 / people
  const cheaper = taxi < 35 ? '打车' : '地铁'

  return <>
    <div ref={scene} className="update-intro-canvas-scene" aria-label="画布内嵌在聊天中的交互示例">
      <div className="update-intro-canvas-chat">
        <header className="update-intro-canvas-session"><Icon icon={chatIcon} /><span>出行方案对比</span><Icon icon={iconChevronDown} /></header>
        <div className="update-intro-canvas-conversation"><p className="update-intro-user">做个能调整人数的出行费用对比。</p><p>调整人数，就能比较每人的费用。</p></div>
        <section className="update-intro-canvas-sheet" aria-label="可交互的费用对比画布">
          <header><h2>怎么去机场更合适？</h2><span>交互示例</span></header>
          <p className="update-intro-canvas-basis">示例费用：地铁 ¥35 / 人 · 打车 ¥120 / 次</p>
          <div className="update-intro-chart" role="img" aria-label={`每人费用：地铁 35 元，打车 ${taxi} 元`}>
            <p>每人费用</p>
            <div className="update-intro-chart-row"><span>地铁</span><div className="update-intro-chart-track"><span style={{ width: `${35 / 120 * 100}%` }} /></div><span>¥35</span></div>
            <div className="update-intro-chart-row"><span>打车</span><div className="update-intro-chart-track"><span className="update-intro-chart-taxi" style={{ width: `${taxi / 120 * 100}%` }} /></div><span>¥{taxi}</span></div>
            <div className="update-intro-chart-axis"><span>0</span><span>60</span><span>120 元</span></div>
          </div>
          <div className="update-intro-people" data-intro-target="canvas">
            <label htmlFor={peopleId}>同行人数<output htmlFor={peopleId}>{people} 人</output></label>
            <input id={peopleId} type="range" min="1" max="4" step="1" value={people} aria-label="调整同行人数" onChange={event => setPeople(Number(event.target.value))} />
            <div><span>1 人</span><span>4 人</span></div>
          </div>
          <p className="update-intro-canvas-result" role="status">{people} 人同行，{cheaper}每人少花 ¥{Math.abs(taxi - 35)}。</p>
        </section>
      </div>
      <div className="update-intro-note update-intro-note-canvas" data-intro-label="canvas"><strong>图表也能直接操作</strong><span>不用离开这段对话</span></div>
      <Doodles figure={scene} canvas active={active} />
    </div>
    <p className="update-intro-canvas-followup">想换一种看法？接着聊就好。<br />“把耗时也加进来。” “再加一种方案。”</p>
  </>
}

function UpdateIntroDialog({ onClose, devMode, kind }: { onClose: () => void; devMode: boolean; kind: IntroKind }) {
  const onboarding = kind === 'onboarding'
  const connectionForm = useRef<HTMLFormElement>(null)
  const connectionTitle = useRef<HTMLHeadingElement>(null)
  const connectionTitleId = useId()
  const [connectedModel, setConnectedModel] = useState('')
  const [connectionBusy, setConnectionBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const figure = useRef<HTMLDivElement>(null)
  const taskButton = useRef<HTMLButtonElement>(null)
  const modelButton = useRef<HTMLButtonElement>(null)
  const contextButton = useRef<HTMLButtonElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const chatTitle = useRef<HTMLHeadingElement>(null)
  const themeTitle = useRef<HTMLHeadingElement>(null)
  const canvasTitle = useRef<HTMLHeadingElement>(null)
  const previousPage = useRef<IntroPage>('chat')
  const present = useIsPresent()
  const reducedMotion = useReducedMotion()
  const themeTitleId = useId(), themeChoiceId = useId()
  const titleId = useId(), canvasTitleId = useId(), popupId = useId()
  const [page, setPage] = useState<IntroPage>('chat')
  const [popup, setPopup] = useState<Popup>(null)
  const [draft, setDraft] = useState('再看看移动端的按钮间距。')
  const [queue, setQueue] = useState(INITIAL_QUEUE)
  const [tasks, setTasks] = useState(EXAMPLE_TASKS)
  const [running, setRunning] = useState(true)
  const [model, setModel] = useState('自选模型')
  const [feedback, setFeedback] = useState('进度和结果留在原会话，随时回来接着看。')
  const [mode, setMode] = useState<'chat' | 'settings' | 'dev'>('chat')
  const [pro, setPro] = useState(false)

  const [originalTheme, setOriginalTheme] = useState(DEFAULT_THEME_ID)
  const [newTheme, setNewTheme] = useState('swiss')
  const [useOriginal, setUseOriginal] = useState(false)
  const [themeReady, setThemeReady] = useState(false)
  const [themeMode, setThemeMode] = useState(getResolvedThemeMode)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const selectedTheme = useOriginal ? originalTheme : newTheme
  const previewMode = themeMode === 'light' ? 'light' : 'dark'
  const pages: IntroPage[] = onboarding ? ['chat', 'themes', 'connect', 'canvas'] : ['chat', 'themes', 'canvas']
  const pageNumber = pages.indexOf(page) + 1
  const busy = saving || connectionBusy

  useEffect(() => {
    let active = true
    loadConfig().then(config => {
      if (active) { setOriginalTheme(normalizeThemeId(config?.accentColor)); setThemeReady(true) }
    }).catch(() => { if (active) setSaveError('无法读取原来的配色，请关闭后重试。') })
    const changed = () => setThemeMode(getResolvedThemeMode())
    window.addEventListener(THEME_CHANGE_EVENT, changed)
    return () => { active = false; window.removeEventListener(THEME_CHANGE_EVENT, changed) }
  }, [])

  const finish = async () => {
    if (saving || !themeReady) return
    setSaving(true)
    setSaveError('')
    try {
      if (!useOriginal && selectedTheme !== originalTheme) {
        const latest = await loadConfig()
        await saveConfig({ ...(latest ?? DEFAULT_CONFIG), accentColor: selectedTheme })
        applyTheme(selectedTheme)
      }
      onClose()
    } catch {
      setSaveError('配色保存失败，请重试。')
    } finally { setSaving(false) }
  }

  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element?.showModal()
    closeButton.current?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (page === previousPage.current) return
    previousPage.current = page
    if (scroll.current) scroll.current.scrollTop = 0
    const heading = page === 'chat' ? chatTitle : page === 'themes' ? themeTitle : page === 'connect' ? connectionTitle : canvasTitle
    heading.current?.focus({ preventScroll: true })
  }, [page])

  const changePage = (next: IntroPage) => {
    setPopup(null)
    setPage(next)
  }

  const toggle = (next: Exclude<Popup, null>) => setPopup(current => current === next ? null : next)
  const closePopup = () => {
    const trigger = popup === 'tasks' ? taskButton : popup === 'model' ? modelButton : contextButton
    setPopup(null)
    trigger.current?.focus()
  }
  const enqueue = () => {
    if (!draft.trim()) return
    setQueue(items => [...items, { id: `example-queue-${crypto.randomUUID()}`, text: draft.trim() }])
    setDraft('')
    setFeedback(running ? '已加入示例队列。草稿清空后，同一按钮变为停止。' : '这是示例消息，实际聊天内容不会被发送。')
  }
  const liveTasks = tasks.filter(task => ['scheduled', 'waiting', 'running'].includes(task.status))

  return <motion.dialog ref={dialog} aria-labelledby={page === 'chat' ? titleId : page === 'themes' ? themeTitleId : page === 'connect' ? connectionTitleId : canvasTitleId} className="update-intro" data-page={page} style={resolveThemeProperties(page === 'chat' ? originalTheme : selectedTheme, previewMode) as CSSProperties} data-closing={!present || undefined} inert={!present}
    initial={{ opacity: 0, y: reducedMotion ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : -6 }} transition={{ duration: reducedMotion ? 0 : .2 }}
    onCancel={event => { event.preventDefault(); if (popup) closePopup(); else if (!busy) onClose() }}
    onClick={event => { if (popup && !(event.target as Element).closest('[data-intro-popup], [data-popup-trigger]')) setPopup(null) }}>
    <div ref={scroll} className="update-intro-scroll">
      <div className="update-intro-content">
        <header className="update-intro-top"><span className="update-intro-brand">Sideki<span>.</span></span><span className="update-intro-edition">{onboarding ? '开始之前' : '这次更新'}</span><span className="update-intro-page-count" aria-live="polite" aria-label={`第 ${pageNumber} 页，共 ${pages.length} 页`}>{String(pageNumber).padStart(2, '0')} / {String(pages.length).padStart(2, '0')}</span><button type="button" ref={closeButton} onClick={onClose} disabled={busy} aria-label={onboarding ? '关闭新手引导' : '关闭更新介绍'} className="update-intro-close"><Icon icon={iconClose} className="text-sm" /></button></header>
        <section className="update-intro-page" hidden={page !== 'chat'} aria-labelledby={titleId}>
        <h1 ref={chatTitle} tabIndex={-1} id={titleId}>{onboarding ? <>你好，<br /><span>我是 Sideki。</span></> : <>换了新装，<br /><span>也更顺手了。</span></>}</h1>
        <p className="update-intro-lead">{onboarding ? <>读懂页面，帮你做事。<br />从眼前这个页面开始，把事情交给我。</> : <>切换会话或收起侧栏，Sideki 也会继续工作。<br />保持浏览器和目标页面打开，完成后会通知你。</>}</p>
        <div ref={figure} className="update-intro-figure" aria-label="聊天界面的三个交互改动点">
          <div className="update-intro-note update-intro-note-tasks" data-intro-label="tasks"><strong>交代一次，持续跟进</strong><span>到时间，或页面有变化时</span></div>
          <div className="update-intro-chat" inert>
            <Header activeView={mode} onViewChange={next => { setMode(next); if (next === 'settings') setFeedback('这是界面示例，你的实际设置不会改变。') }} proMode={pro} onProModeChange={setPro} devMode={devMode} />
            <header className="update-intro-session"><span>页面布局检查<Icon icon={iconChevronDown} className="text-[10px] text-text-muted" /></span>{liveTasks.length > 0 && <span data-popup-trigger data-intro-target="tasks"><ScheduledTaskButton ref={taskButton} count={liveTasks.length} expanded={popup === 'tasks'} aria-label="示例自动任务" aria-expanded={popup === 'tasks'} aria-controls={popupId} onClick={() => toggle('tasks')} /></span>}<Icon icon={iconPlus} className="ml-1 text-sm text-text-muted" /></header>
            <AnimatedPopover open={popup === 'tasks'} portaled={false} id={popupId} role="region" aria-label="示例自动任务面板" data-intro-popup className="update-intro-task-popup theme-overlay !bg-surface-raised">
              <header><span>自动任务</span><span>{liveTasks.length} 项活跃</span><button type="button" onClick={closePopup} aria-label="收起示例自动任务"><Icon icon={iconClose} /></button></header>
              <div className="divide-y divide-border-muted px-3">{tasks.map(task => <ScheduledTaskRow key={task.id} task={task} pending={false} onAction={async (item, action) => { setTasks(items => items.map(t => t.id === item.id ? { ...t, status: action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'scheduled' } : t)); setFeedback('仅修改示例任务，不影响真实自动任务。') }} />)}</div>
              <p>进度和结果，都会回到这段会话。</p>
            </AnimatedPopover>
            <div className="update-intro-messages"><div className="update-intro-user">稍后复查，有新错误告诉我。</div><p>已安排，你可以先忙别的，完成后通知你。</p><TimerWakeEvent wake={{ taskId: 'example-timer', occurrenceId: 'example-wake', title: '复查页面布局', scheduledAt: EXAMPLE_TIME, startedAt: EXAMPLE_TIME, tabId: 0, pageTitle: '示例页面', pageUrl: 'about:blank' }} /><div className="update-intro-working"><span />{running ? '正在检查页面布局…' : '已停止示例回复'}</div></div>
            <div className="px-2"><TodoStripContent todos={TODOS} /></div>
            <div className="update-intro-shelf glass-shelf relative z-[1] px-2 pb-2 pt-2">
              <QueueStrip queue={queue} onRemove={id => setQueue(items => items.filter(item => item.id !== id))} onRecall={id => { const item = queue.find(entry => entry.id === id); if (!item) return; setQueue(items => [...items.filter(entry => entry.id !== id), ...(draft.trim() ? [{ id: `example-queue-${crypto.randomUUID()}`, text: draft }] : [])]); setDraft(item.text) }} />
              <ChatComposer input={{ value: draft, 'aria-label': '示例消息草稿', onChange: event => setDraft(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); enqueue() } } }}
                attachmentControl={<button type="button" aria-label="示例附件入口" className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-overlay hover:text-accent" onClick={() => setFeedback('附件入口仍在输入框左下角，保持你熟悉的用法。')}><Icon icon={iconPlus} className="text-base" /></button>}
                modelControls={<div className="flex min-w-0 items-center gap-1" data-popup-trigger data-intro-target="model"><ModelSwitcherTrigger ref={modelButton} label={model} open={popup === 'model'} aria-label={`示例模型：${model}`} aria-expanded={popup === 'model'} onClick={() => toggle('model')} /><ContextMeterTrigger ref={contextButton} ratio={.28} label="28%" aria-label="示例上下文占用 28%" aria-expanded={popup === 'context'} onClick={() => toggle('context')} /></div>}
                actions={<span data-intro-target="action"><ComposerActions running={running} stopping={false} sending={false} hasDraft={!!draft.trim()} onSend={enqueue} onStop={() => { setRunning(false); setFeedback('已停止示例回复。你可以继续输入，体验主按钮的变化。') }} /></span>} />
              <AnimatedPopover open={popup === 'model' || popup === 'context'} portaled={false} direction="up" data-intro-popup role="region" aria-label={popup === 'model' ? '示例模型选择' : '示例上下文用量'} className="update-intro-controls-popup theme-overlay !bg-surface-raised">
                {popup === 'model' ? <><p>模型选择示例</p>{['自选模型', '日常助手', '代码助手'].map(name => <button key={name} type="button" aria-pressed={model === name} onClick={() => { setModel(name); setPopup(null); modelButton.current?.focus(); setFeedback('模型仅在此示例中切换，你的配置保持原样。') }}>{name}</button>)}</> : <><p>上下文用量</p><strong>28%</strong><span>28k / 100k · 示例数据</span></>}
              </AnimatedPopover>
            </div>
          </div>
          <div className="update-intro-note update-intro-note-model" data-intro-label="model"><strong>模型与上下文</strong><span>{onboarding ? '查看用量，随时切换' : '一起挪到手边'}</span></div>
          <div className="update-intro-note update-intro-note-action" data-intro-label="action"><strong>有内容，就排队</strong><span>清空后，点这里停止</span></div>
          <Doodles figure={figure} active={page === 'chat'} />
        </div>
        <p className="update-intro-feedback" role="status">{feedback}</p>
        </section>
        <section className="update-intro-page update-intro-theme-page" hidden={page !== 'themes'} aria-labelledby={themeTitleId}>
          <div className="intro-theme-kicker">A FRESH PALETTE</div>
          <h1 ref={themeTitle} tabIndex={-1} id={themeTitleId}>新界面，<br /><span>也有你的颜色。</span></h1>
          <p className="update-intro-lead">{onboarding ? <>从<span className="intro-theme-swiss">瑞士红</span>开始，挑一款你喜欢的。</> : <>十三种新配色，这次先试试<span className="intro-theme-swiss">瑞士红</span>。</>}</p>
          <IntroThemePage active={page === 'themes' && present} selected={selectedTheme} mode={previewMode} reducedMotion={!!reducedMotion} onSelect={id => { setNewTheme(id); setUseOriginal(false) }} />
        </section>
        {onboarding && <section className="update-intro-page update-intro-connect" hidden={page !== 'connect'} aria-labelledby={connectionTitleId}>
          <h1 ref={connectionTitle} tabIndex={-1} id={connectionTitleId}>选个模型，<br /><span>就能开始了。</span></h1>
          <p className="update-intro-lead">选服务商、粘贴 Key，连接你的 AI 助手。</p>
          <ModelServiceForm formRef={connectionForm} hideSubmit onBusyChange={setConnectionBusy} onSave={async profile => {
            const latest = await loadConfig() ?? DEFAULT_CONFIG
            const next = configProfiles(latest).some(p => p.id === profile.id) ? updateServiceModel(latest, profile) : addServiceModel(latest, profile, true)
            await saveConfig(next)
            setConnectedModel(profile.name)
            setPage('canvas')
          }} />
        </section>}
        <section className="update-intro-page" hidden={page !== 'canvas'} aria-labelledby={canvasTitleId}>
          <h1 ref={canvasTitle} tabIndex={-1} id={canvasTitleId}>让答案，<br /><span>在画布里动起来。</span></h1>
          <p className="update-intro-lead">图表、原型与交互演示，直接出现在聊天里。</p>
          {onboarding && <p className="update-intro-connected">{connectedModel ? `${connectedModel} · 已连接` : '模型尚未连接，可稍后在设置中完成。'}</p>}
          <CanvasExample active={page === 'canvas'} />
        </section>
      </div>
    </div>
    <footer className="update-intro-footer">
      {page === 'themes' && !onboarding && <fieldset className="intro-theme-choices" disabled={!themeReady || saving}>
        <legend>这次更新，配色怎么用？</legend>
        <label><input type="radio" name={themeChoiceId} checked={!useOriginal} onChange={() => setUseOriginal(false)} /><span>试试新配色</span><small>{resolveThemePreset(newTheme).label}</small></label>
        <label><input type="radio" name={themeChoiceId} checked={useOriginal} onChange={() => setUseOriginal(true)} /><span>使用我原来的配色</span><small>{resolveThemePreset(originalTheme).label}</small></label>
      </fieldset>}
      {saveError && <p className="intro-theme-error" role="alert">{saveError}</p>}
      <div className="update-intro-navigation">
        {page !== 'chat' && <button type="button" className="update-intro-back" disabled={busy} onClick={() => changePage(pages[pageNumber - 2])}><Icon icon={arrowLeftIcon} />上一页</button>}
        <button type="button" className="update-intro-next" disabled={busy || (page !== 'chat' && !themeReady)} onClick={() => page === 'connect' ? connectionForm.current?.requestSubmit() : page === 'canvas' ? void finish() : changePage(pages[pageNumber])}>{busy ? connectionBusy ? '正在验证…' : '保存中…' : page === 'chat' ? onboarding ? '挑一个喜欢的颜色' : '接下来，看看新配色' : page === 'themes' ? onboarding ? '继续，连接模型' : '继续' : page === 'connect' ? '验证并继续' : '开始使用'}<Icon icon={arrowIcon} className="text-sm" /></button>
      </div>
      {page === 'connect' && <button type="button" className="update-intro-skip" disabled={busy} onClick={() => changePage('canvas')}>稍后配置，先看看</button>}
    </footer>
  </motion.dialog>
}

export default function UpdateIntro({ open, onClose, devMode = false, kind = 'update' }: { open: boolean; onClose: () => void; devMode?: boolean; kind?: IntroKind }) {
  return createPortal(<AnimatePresence>{open && <UpdateIntroDialog key={kind} kind={kind} onClose={onClose} devMode={devMode} />}</AnimatePresence>, document.body)
}
