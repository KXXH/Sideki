export const TASKS_KEY = 'sidekick_scheduled_tasks'
export const TASK_INTRO_KEY = 'sidekick_schedule_intro_v1'

export interface TimerWake {
  kind?: 'timer' | 'monitor'
  event?: MonitorEvent
  taskId: string
  occurrenceId: string
  title: string
  scheduledAt: number
  startedAt: number
  tabId: number
  pageTitle: string
  pageUrl: string
}

export interface MonitorEvent {
  id: string
  at: number
  data?: unknown
  error?: string
}

export interface PageMonitor {
  frame?: string
  frameId?: number
  code: string
  token: string
  documentId: string
  expiresAt: number
  listening: boolean
  pending?: MonitorEvent
  current?: MonitorEvent
  lastReceivedAt?: number
  lastWakeAt?: number
  errorReported?: boolean
  received: number
  coalesced: number
}

export interface ScheduledTask {
  kind?: 'timer' | 'monitor'
  monitor?: PageMonitor
  id: string
  sessionId: string
  title: string
  instruction: string
  tabId: number
  pageTitle: string
  pageUrl: string
  tabStack?: number[]
  requiresRebind?: boolean
  nextRunAt: number
  intervalMs?: number
  maxRuns: number
  runs: number
  status: 'scheduled' | 'waiting' | 'running' | 'paused' | 'completed' | 'cancelled'
  reason?: string
  occurrenceId?: string
  createdAt: number
}

export function isTaskDue(task: ScheduledTask, now: number): boolean {
  return (task.status === 'scheduled' || task.status === 'waiting') && task.nextRunAt <= now
    && (task.kind !== 'monitor' || !!task.monitor?.pending)
}

export function finishTask(task: ScheduledTask, now: number, error?: string): ScheduledTask {
  if (task.status !== 'running') return task
  const runs = task.runs + 1
  if (error) return { ...task, runs, status: 'paused', reason: error }
  if (task.kind === 'monitor') {
    const monitor = task.monitor!
    if (monitor.current?.error) return { ...task, runs, status: 'paused', reason: `监听已停止：${monitor.current.error}` }
    if (runs >= task.maxRuns || (!monitor.listening && !monitor.pending)) return { ...task, runs, status: 'completed', reason: undefined }
    return { ...task, runs, monitor: { ...monitor, current: undefined }, status: monitor.pending ? 'waiting' : 'scheduled', reason: undefined, occurrenceId: undefined }
  }
  if (!task.intervalMs || runs >= task.maxRuns) return { ...task, runs, status: 'completed', reason: undefined }
  return { ...task, runs, status: 'scheduled', nextRunAt: now + task.intervalMs, reason: undefined, occurrenceId: undefined }
}
