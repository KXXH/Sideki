import { Icon } from '@iconify/react'
import clockIcon from '@iconify-icons/lucide/clock-3'
import eyeIcon from '@iconify-icons/lucide/eye'
import pauseIcon from '@iconify-icons/lucide/pause'
import playIcon from '@iconify-icons/lucide/play'
import closeIcon from '@iconify-icons/lucide/x'
import helpIcon from '@iconify-icons/lucide/help-circle'
import chevronIcon from '@iconify-icons/lucide/chevron-down'
import linkIcon from '@iconify-icons/lucide/link'
import { useEffect, useId, useRef, useState, type ComponentPropsWithRef } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import AnimatedPopover from './AnimatedPopover'
import AppDialog, { DialogAction } from './AppDialog'
import { TASKS_KEY, TASK_INTRO_KEY } from '../../shared/scheduled-task'
import type { ScheduledTask, TimerWake } from '../../shared/scheduled-task'

const time = (value: number) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const labels: Record<ScheduledTask['status'], string> = {
  scheduled: '等待唤醒', waiting: '等待执行', running: '正在执行', paused: '已暂停', completed: '已完成', cancelled: '已取消',
}
const isActive = (task: ScheduledTask) => ['scheduled', 'waiting', 'running'].includes(task.status)

export function ScheduledTaskButton({ count, expanded = false, ...props }: ComponentPropsWithRef<'button'> & { count: number; expanded?: boolean }) {
  return <button {...props} type="button" className={`flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-md px-1 text-[10px] tabular-nums transition-colors ${expanded ? 'bg-surface-overlay text-text-secondary' : 'text-text-muted hover:bg-surface-overlay hover:text-text-secondary'}`}>
    <Icon icon={clockIcon} className="h-3.5 w-3.5" />
    {count > 1 && <span className="rounded bg-surface-overlay px-1 text-[10px] text-text-muted">{count}</span>}
  </button>
}

function TaskDetails({ open, id, children }: { open: boolean; id: string; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion()
  return <AnimatePresence initial={false}>{open && <motion.div id={id} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.16 }} className="overflow-hidden">{children}</motion.div>}</AnimatePresence>
}

export function TimerWakeEvent({ wake }: { wake: TimerWake }) {
  const monitor = wake.kind === 'monitor'
  const label = monitor ? '页面唤醒' : '定时唤醒'
  return (
    <div aria-label={`${label}：${wake.title}`} className="my-3 flex min-h-6 items-center gap-1.5 text-[11px] text-text-secondary">
      <Icon icon={monitor ? eyeIcon : clockIcon} className="h-3 w-3 shrink-0 text-text-muted" />
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="text-text-muted" aria-hidden="true">·</span>
      <span className="min-w-0 truncate" title={wake.title}>{wake.title}</span>
      <time className="shrink-0 text-[10px] tabular-nums text-text-muted" dateTime={new Date(wake.startedAt).toISOString()}>{new Date(wake.startedAt).toLocaleTimeString('zh-CN')}</time>
      <span aria-hidden="true" className="h-px min-w-2 flex-1 bg-border-subtle" />
    </div>
  )
}

export function ScheduledTaskRow({ task, pending, onAction }: { task: ScheduledTask; pending: boolean; onAction: (task: ScheduledTask, action: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const ended = task.status === 'completed' || task.status === 'cancelled'
  const monitor = task.monitor
  const status = monitor && task.status === 'scheduled' ? '监听中' : labels[task.status]
  const buttonClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30'
  return <div className="py-2.5">
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={detailsId} aria-label={`${expanded ? '收起' : '展开'}任务详情：${task.title}`} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span className="min-w-0 truncate text-xs font-medium text-text-primary" title={task.title}>{task.title}</span>
        <Icon icon={chevronIcon} className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <span className="shrink-0 text-[10px] text-text-muted">{status}</span>
      {!ended && <div className="flex shrink-0">
        <button type="button" className={buttonClass} title={task.requiresRebind ? task.reason : task.status === 'paused' ? '恢复任务' : '暂停任务'} aria-label={task.status === 'paused' ? '恢复任务' : '暂停任务'} disabled={pending || task.requiresRebind} onClick={() => void onAction(task, task.status === 'paused' ? 'resume' : 'pause')}><Icon icon={task.status === 'paused' ? playIcon : pauseIcon} className="h-3.5 w-3.5" /></button>
        <button type="button" className={buttonClass} title="取消任务" aria-label="取消任务" disabled={pending} onClick={() => void onAction(task, 'cancel')}><Icon icon={closeIcon} className="h-3.5 w-3.5" /></button>
      </div>}
    </div>
    <TaskDetails open={expanded} id={detailsId}>
      <div className="pt-2">
        <p className="whitespace-pre-wrap break-words text-[11px] text-text-secondary">{task.instruction}</p>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md bg-surface px-2 py-1.5 text-[10px] text-text-muted" title={task.pageUrl}><Icon icon={linkIcon} className="h-3 w-3 shrink-0" /><span className="truncate">{task.pageTitle || task.pageUrl}</span></div>
        <p className="mt-1 text-[10px] tabular-nums text-text-muted">{monitor ? '页面监听 · 已唤醒' : '定时任务 · 已执行'} {task.runs} / {task.maxRuns} 次{monitor ? ` · 到期 ${time(monitor.expiresAt)}` : task.status === 'scheduled' ? ` · 下次 ${time(task.nextRunAt)}` : ''}</p>
        {monitor && <details className="mt-2 text-[10px] text-text-muted"><summary className="cursor-pointer">监听代码</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-2 font-mono">{monitor.code}</pre></details>}
        {monitor && monitor.coalesced > 0 && <p className="mt-1 text-[10px] text-text-muted">已合并 {monitor.coalesced} 条事件</p>}
        {task.reason && <p className="mt-1 text-[10px] leading-relaxed text-text-secondary">{task.reason}</p>}
      </div>
    </TaskDetails>
  </div>
}

function ScheduleIntro({ open, task, proMode, onClose }: { open: boolean; task?: ScheduledTask; proMode: boolean; onClose: () => void }) {
  return (
    <AppDialog open={open} title="Agent 可以稍后继续这段会话" proMode={proMode} onClose={onClose} footer={<DialogAction variant="primary" onClick={onClose}>知道了</DialogAction>}>
        <p className="text-xs leading-relaxed text-text-secondary">约定时间到达或页面监听触发后，Agent 会继续执行任务，结果留在当前会话中。</p>
        {task && <div className="my-4 rounded-xl border border-accent/25 bg-accent/5 p-3 text-xs"><p className="font-medium">{task.title}</p><p className="mt-1 truncate text-text-secondary">绑定：{task.pageTitle || task.pageUrl}</p></div>}
        <dl className="mt-4 space-y-4 text-xs leading-relaxed">
          <div><dt className="font-medium">沿用会话，绑定页面</dt><dd className="mt-1 text-text-secondary">使用本会话的上下文。切换标签页或会话不会改变任务的目标；任务自己的页面导航会延续到下一次检查。等待期间不占用页面。</dd></div>
          <div><dt className="font-medium">操作权限与当前模式一致</dt><dd className="mt-1 text-text-secondary">Chat 模式需要确认的操作仍会等待确认；Pro 模式可以直接执行。点击“知道了”不会授予额外权限。</dd></div>
          <div><dt className="font-medium">到期后尽快执行</dt><dd className="mt-1 text-text-secondary">定时任务最短 30 秒，重复间隔从上次完成后计时。页面监听在条件满足时触发，同一会话每分钟最多唤醒一次，连续事件会合并。两种任务都有执行次数上限；会话忙碌时等待，休眠时不执行。</dd></div>
          <div><dt className="font-medium">后台运行，随时取消</dt><dd className="mt-1 text-text-secondary">后台模式下关闭侧面板仍可运行。关闭目标页会暂停，删除会话会取消。页面监听在刷新或导航后失效，需要重新创建。浏览器重启后任务暂停，需重新创建以绑定页面。暂停或取消会停止后续唤醒；正在执行的回复可用停止按钮中止。</dd></div>
        </dl>
    </AppDialog>
  )
}

export default function ScheduledTaskStrip({ sessionId, proMode }: { sessionId: string; proMode: boolean }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [intro, setIntro] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [cancelledExpanded, setCancelledExpanded] = useState(false)
  const [keepAnchor, setKeepAnchor] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const popupId = useId()
  const cancelledId = useId()
  useEffect(() => {
    if (!expanded) return
    popupRef.current?.focus()
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setExpanded(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setExpanded(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [expanded])
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const data = await chrome.storage.local.get([TASKS_KEY, TASK_INTRO_KEY])
      if (!alive) return
      const own = ((data[TASKS_KEY] ?? []) as ScheduledTask[]).filter(t => t.sessionId === sessionId)
      setTasks(own)
      if (own.some(isActive) && !data[TASK_INTRO_KEY] && document.visibilityState === 'visible') setIntro(true)
    }
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes[TASKS_KEY] || changes[TASK_INTRO_KEY])) void refresh().catch(() => {})
    }
    void refresh().catch(() => {})
    chrome.storage.onChanged.addListener(listener)
    document.addEventListener('visibilitychange', refresh)
    return () => { alive = false; chrome.storage.onChanged.removeListener(listener); document.removeEventListener('visibilitychange', refresh) }
  }, [sessionId])
  const act = async (task: ScheduledTask, action: string) => {
    setPending(task.id); setError('')
    try {
      const result = await chrome.runtime.sendMessage({ type: 'schedule:command', sessionId, taskId: task.id, action })
      if (!result?.success) setError(result?.error ?? '操作失败')
    } catch (e) { setError(String(e)) }
    finally { setPending(null) }
  }
  const closeIntro = () => {
    setIntro(false)
    void chrome.storage.local.set({ [TASK_INTRO_KEY]: true })
  }
  const live = tasks.filter(isActive)
  // Reason: paused tasks still need a reachable menu for recovery or cancellation.
  const manageable = tasks.some(task => !['completed', 'cancelled'].includes(task.status))
  const cancelled = tasks.filter(task => task.status === 'cancelled')
  const visible = tasks.filter(task => task.status !== 'cancelled')
  const next = live.find(t => t.status === 'running')
    ?? live.filter(t => t.status === 'scheduled' || t.status === 'waiting').sort((a, b) => a.nextRunAt - b.nextRunAt)[0]
    ?? live[0]
  const summary = !next ? '无活跃任务' : next.status === 'scheduled'
    ? next.monitor ? '监听中' : new Date(next.nextRunAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : labels[next.status]
  const buttonClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30'
  return (
    <>
      {/* Reason: retain the invisible anchor through the exit animation when the last active task is paused or finishes. */}
      {(manageable || expanded || keepAnchor) && <span style={{ anchorName: '--schedule-trigger' } as React.CSSProperties} className="inline-flex h-6 shrink-0">
      {manageable && <ScheduledTaskButton count={live.length} expanded={expanded} ref={triggerRef} onClick={() => { setKeepAnchor(true); if (!expanded) setCancelledExpanded(false); setExpanded(value => !value) }} aria-label={`本会话自动任务：${live.length} 个，${summary}`} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={popupId} title={`${live.length} 个活跃自动任务 · ${summary}`} />}
      </span>}
      <AnimatedPopover open={expanded} onExitComplete={() => setKeepAnchor(false)} ref={popupRef} id={popupId} role="dialog" aria-label="本会话的自动任务" tabIndex={-1} style={{ positionAnchor: '--schedule-trigger', top: 'anchor(bottom)' } as React.CSSProperties} className={`${proMode ? 'pro-mode ' : ''}theme-overlay fixed left-[var(--chat-gutter)] right-[var(--chat-gutter)] z-50 ml-auto mt-2 max-w-sm overflow-hidden rounded-xl !bg-surface-raised text-text-primary outline-none`}>
        <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2">
          <span className="flex-1 text-xs font-medium">本会话的自动任务</span>
          <span className="text-[10px] text-text-muted">{live.length} 个待执行</span>
          <button className={buttonClass} aria-label="收起自动任务" onClick={() => { setExpanded(false); triggerRef.current?.focus() }}><Icon icon={closeIcon} className="h-3.5 w-3.5" /></button>
        </div>
        <div className="max-h-[min(60vh,400px)] divide-y divide-border-muted overflow-y-auto px-3">
        {visible.map(task => <ScheduledTaskRow key={task.id} task={task} pending={pending === task.id} onAction={act} />)}
        {cancelled.length > 0 && <div>
          <button type="button" aria-expanded={cancelledExpanded} aria-controls={cancelledId} onClick={() => setCancelledExpanded(value => !value)} className="flex w-full items-center gap-1.5 py-2.5 text-left text-[11px] text-text-muted transition-colors hover:text-text-secondary">
            <span className="flex-1">已取消 <span className="tabular-nums">{cancelled.length}</span></span>
            <Icon icon={chevronIcon} className={`h-3 w-3 shrink-0 transition-transform ${cancelledExpanded ? 'rotate-180' : ''}`} />
          </button>
          <TaskDetails open={cancelledExpanded} id={cancelledId}>
            <div className="divide-y divide-border-muted">{cancelled.map(task => <ScheduledTaskRow key={task.id} task={task} pending={pending === task.id} onAction={act} />)}</div>
          </TaskDetails>
        </div>}
        </div>
        {error && <p role="alert" className="px-3 py-2 text-[11px] text-error">{error}</p>}
        <div className="flex items-center gap-2 border-t border-border-muted px-3 py-2 text-[10px] text-text-muted"><span className="flex-1">关闭侧面板仍可后台运行；休眠时不执行。</span><button className={buttonClass} title="了解自动任务" aria-label="了解自动任务" onClick={() => setIntro(true)}><Icon icon={helpIcon} className="h-3.5 w-3.5" /></button></div>
      </AnimatedPopover>
      <ScheduleIntro open={intro} task={tasks.at(-1)} proMode={proMode} onClose={closeIntro} />
    </>
  )
}
