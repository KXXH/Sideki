import { loadConfig, loadSessionIndex, SESSION_INDEX_KEY } from '../shared/storage'
import { TASKS_KEY, isTaskDue, finishTask } from '../shared/scheduled-task'
import type { MonitorEvent, ScheduledTask, TimerWake } from '../shared/scheduled-task'
import { MONITOR_CODE_LIMIT, MONITOR_EMIT_INTERVAL, MONITOR_MESSAGE_BYTES, MONITOR_WAKE_INTERVAL, serializeMonitorValue } from '../shared/monitor'
import { operatingTabOf, ownerOf, snapshotTurnTabs, restoreTurnTabs } from './tab-locks'
import { installPageMonitor, isMonitorDocumentCurrent, stopPageMonitor } from './monitor-page'

const ALARM = 'session-schedules'
const BOOT_KEY = 'schedule_browser_session'
let serial: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = serial.then(fn, fn)
  serial = next.catch(() => {})
  return next
}
const active = (task: ScheduledTask) => ['scheduled', 'waiting', 'running'].includes(task.status)
async function read(): Promise<ScheduledTask[]> {
  return (await chrome.storage.local.get(TASKS_KEY))[TASKS_KEY] ?? []
}
async function save(tasks: ScheduledTask[]): Promise<void> {
  await chrome.storage.local.set({ [TASKS_KEY]: tasks })
  if (tasks.some(active)) {
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 })
  } else await chrome.alarms.clear(ALARM)
}
function publicTask(task: ScheduledTask) {
  if (!task.monitor) return task
  const { token: _token, ...monitor } = task.monitor
  void _token
  return { ...task, monitor }
}
async function stopMonitor(task: ScheduledTask): Promise<void> {
  if (!task.monitor) return
  task.monitor.listening = false
  task.monitor.pending = undefined
  await stopPageMonitor(task)
}

export function captureScheduledTab(sessionId: string): void {
  const tabId = operatingTabOf(sessionId)
  const tabStack = snapshotTurnTabs(sessionId)
  if (tabId == null) return
  void exclusive(async () => {
    const tasks = await read()
    const task = tasks.find(t => t.sessionId === sessionId && t.status === 'running' && t.kind !== 'monitor')
    if (!task) return
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab) {
      task.tabStack = tabStack
      task.tabId = tabId
      task.pageTitle = tab.title ?? ''
      task.pageUrl = tab.url ?? ''
      await save(tasks)
    }
  })
}

async function command(m: Record<string, unknown>) {
  const sessionId = String(m.sessionId ?? '')
  if (!sessionId) throw new Error('缺少会话')
  const tasks = await read()
  const isMonitor = m.type === 'monitor:command'
  if (m.action === 'list') return { success: true, tasks: tasks.filter(t => t.sessionId === sessionId && (!isMonitor || t.kind === 'monitor')).map(publicTask) }
  if (m.action === 'create') {
    const config = await loadConfig()
    if (config?.labKernelHost === 'panel') throw new Error('自动任务需要启用后台内核：设置 → 开发者 → 兼容性与故障排查')
    const session = (await loadSessionIndex()).find(s => s.id === sessionId)
    if (!session) throw new Error('会话不存在')
    if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 80 || typeof m.instruction !== 'string' || !m.instruction.trim() || m.instruction.length > 4000) throw new Error('请提供任务名称和执行指令')
    if (tasks.filter(t => t.sessionId === sessionId && !['completed', 'cancelled'].includes(t.status)).length >= 10) throw new Error('每个会话最多 10 个未结束的任务')
    const tabId = operatingTabOf(sessionId) ?? (typeof m.tabId === 'number' ? m.tabId : null)
    if (tabId == null) throw new Error('没有可绑定的页面')
    if (ownerOf(tabId) && ownerOf(tabId) !== sessionId) throw new Error('目标页面正被其他会话使用')
    const tab = await chrome.tabs.get(tabId)
    const now = Date.now()
    const task: ScheduledTask = {
      id: crypto.randomUUID(), sessionId, title: m.title.trim(), instruction: m.instruction.trim(),
      tabId, tabStack: snapshotTurnTabs(sessionId).length ? snapshotTurnTabs(sessionId) : [tabId], pageTitle: tab.title ?? '', pageUrl: tab.url ?? '',
      nextRunAt: now, maxRuns: 1, runs: 0, status: 'scheduled', createdAt: now,
    }
    if (isMonitor) {
      const timeout = m.timeoutSeconds == null ? 600 : Number(m.timeoutSeconds)
      const maxRuns = m.maxRuns == null ? 5 : Number(m.maxRuns)
      if (typeof m.code !== 'string' || !m.code.trim() || m.code.length > MONITOR_CODE_LIMIT) throw new Error('请提供不超过 20000 字符的同步 monitor 函数')
      if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) throw new Error('监听时长必须为 30–3600 秒')
      if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 20) throw new Error('监听唤醒上限必须为 1–20 次')
      if (m.frame !== undefined && (typeof m.frame !== 'string' || !m.frame.trim() || m.frame.length > 1000)) throw new Error('frame 必须是不超过 1000 字符的 iframe 选择器或 frameId')
      task.kind = 'monitor'
      task.maxRuns = maxRuns
      task.tabStack = [tabId]
      task.monitor = { frame: typeof m.frame === 'string' ? m.frame.trim() : undefined, code: m.code, token: crypto.randomUUID(), documentId: '', expiresAt: now + timeout * 1000, listening: true, received: 0, coalesced: 0 }
      await installPageMonitor(task, session.mode === 'pro')
    } else {
      const delay = Number(m.delaySeconds)
      const interval = m.intervalSeconds == null ? undefined : Number(m.intervalSeconds)
      const maxRuns = interval ? Number(m.maxRuns) : 1
      if (!Number.isInteger(delay) || delay < 30 || delay > 86400) throw new Error('延迟必须为 30–86400 秒')
      if (interval !== undefined && (!Number.isInteger(interval) || interval < 30 || interval > 86400)) throw new Error('间隔必须为 30–86400 秒')
      if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) throw new Error('重复任务需要指定 1–100 次执行上限')
      task.nextRunAt = now + delay * 1000
      task.intervalMs = interval ? interval * 1000 : undefined
      task.maxRuns = maxRuns
    }
    tasks.push(task)
    try { await save(tasks) } catch (error) { await stopMonitor(task); throw error }
    return { success: true, task: publicTask(task) }
  }
  const task = tasks.find(t => t.id === m.taskId && t.sessionId === sessionId && (!isMonitor || t.kind === 'monitor'))
  if (!task) throw new Error('任务不存在')
  if (['completed', 'cancelled'].includes(task.status)) {
    if (m.action === 'delete' && task.kind === 'monitor') return { success: true, task: publicTask(task) }
    throw new Error('任务已结束')
  }
  if (m.action === 'cancel' || m.action === 'delete' || m.action === 'pause') {
    task.status = m.action === 'pause' ? 'paused' : 'cancelled'
    task.reason = '已停止后续唤醒；正在执行的回复可用停止按钮中止'
    await stopMonitor(task)
  } else if (m.action === 'resume') {
    if (task.status !== 'paused') throw new Error('只能恢复暂停的任务')
    if (task.runs >= task.maxRuns) throw new Error('任务已达到执行次数上限')
    if (task.requiresRebind) throw new Error('页面绑定已失效，请重新创建任务')
    await chrome.tabs.get(task.tabId)
    if (task.monitor) {
      if (task.monitor.expiresAt <= Date.now()) throw new Error('监听已到期，请重新创建')
      if (!await isMonitorDocumentCurrent(task)) throw new Error('页面已刷新，请重新创建监听')
      const session = (await loadSessionIndex()).find(s => s.id === sessionId)
      task.monitor.token = crypto.randomUUID()
      task.monitor.listening = true
      task.monitor.errorReported = false
      await installPageMonitor(task, session?.mode === 'pro')
    }
    task.status = 'scheduled'
    task.nextRunAt = task.monitor ? Math.max(Date.now(), task.nextRunAt) : Date.now() + (task.intervalMs ?? 30_000)
    task.reason = undefined
  } else throw new Error('未知操作')
  await save(tasks)
  return { success: true, task: publicTask(task) }
}

export function registerScheduledTasks(ensureHost: () => Promise<{ success: boolean; error?: string }>): void {
  // Reason: session storage survives SW eviction, but not browser restart; old tab IDs must never be rebound after a restart.
  const ready = exclusive(async () => {
    const boot = await chrome.storage.session.get(BOOT_KEY)
    const tasks = await read()
    if (!boot[BOOT_KEY]) {
      for (const task of tasks) if (!['completed', 'cancelled'].includes(task.status)) {
        task.status = 'paused'
        task.requiresRebind = true
        if (task.monitor) { task.monitor.listening = false; task.monitor.pending = undefined }
        task.reason = '浏览器已重启，请重新创建任务绑定页面'
      }
      await chrome.storage.session.set({ [BOOT_KEY]: true })
    }
    await save(tasks)
  })

  let draining = false
  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      await ready
      // Reason: boot outside the serialization gate; host recovery calls back into this scheduler.
      if (!(await read()).some(t => isTaskDue(t, Date.now()))) return
      if ((await loadConfig())?.labKernelHost === 'panel') {
        await exclusive(async () => {
          const tasks = await read()
          for (const task of tasks) if (active(task)) { task.status = 'paused'; task.reason = '请启用后台运行模式后恢复'; await stopMonitor(task) }
          await save(tasks)
        })
        return
      }
      if (!(await ensureHost()).success) return
      await exclusive(async () => {
        const tasks = await read()
        const sessions = await loadSessionIndex()
        for (const task of tasks) {
          if (!isTaskDue(task, Date.now())) continue
          if (!sessions.some(s => s.id === task.sessionId)) { task.status = 'cancelled'; await stopMonitor(task); continue }
          if (tasks.some(t => t.sessionId === task.sessionId && t.status === 'running')) {
            task.status = 'waiting'; task.reason = '等待当前会话空闲'; continue
          }
          const tab = await chrome.tabs.get(task.tabId).catch(() => null)
          if (!tab) { task.status = 'paused'; task.reason = '目标页面已关闭'; await stopMonitor(task); continue }
          if (task.monitor) {
            const lastWake = Math.max(0, ...tasks.filter(t => t.sessionId === task.sessionId).map(t => t.monitor?.lastWakeAt ?? 0))
            task.nextRunAt = Math.max(task.nextRunAt, lastWake + MONITOR_WAKE_INTERVAL)
            if (task.nextRunAt > Date.now()) { task.status = 'waiting'; task.reason = '等待唤醒间隔'; continue }
            if (!await isMonitorDocumentCurrent(task)) {
              task.status = 'paused'; task.requiresRebind = true; task.reason = '页面已刷新，请重新创建监听'; await stopMonitor(task); continue
            }
          }
          if ((task.tabStack ?? [task.tabId]).some(id => { const owner = ownerOf(id); return owner != null && owner !== task.sessionId })) {
            task.status = 'waiting'; task.reason = '等待其他会话释放目标页面'; continue
          }
          task.status = 'running'
          task.occurrenceId = crypto.randomUUID()
          if (task.monitor) { task.monitor.current = task.monitor.pending; task.monitor.pending = undefined }
          await save(tasks)
          const wake: TimerWake = {
            kind: task.kind, event: task.monitor?.current,
            taskId: task.id, occurrenceId: task.occurrenceId, title: task.title,
            scheduledAt: task.monitor?.current?.at ?? task.nextRunAt, startedAt: Date.now(), tabId: task.tabId,
            pageTitle: tab.title ?? '', pageUrl: tab.url ?? '',
          }
          const response = await chrome.runtime.sendMessage({ type: 'schedule:wake', sessionId: task.sessionId, instruction: task.instruction, wake }).catch(() => null)
          if (!response?.accepted) {
            task.status = 'waiting'; task.reason = response?.reason ?? '等待后台运行就绪'
            if (task.monitor) { task.monitor.pending ??= task.monitor.current; task.monitor.current = undefined }
          } else {
            task.reason = undefined
            if (task.monitor) {
              task.monitor.lastWakeAt = Date.now()
              task.nextRunAt = Date.now() + MONITOR_WAKE_INTERVAL
              if (task.runs + 1 >= task.maxRuns || task.monitor.current?.error) await stopMonitor(task)
            }
          }
        }
        await save(tasks)
      })
    } catch (error) { console.warn('[schedule]', error) }
    finally { draining = false }
  }

  async function receiveEvent(m: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
    if (sender.id !== chrome.runtime.id || sender.frameId == null || !sender.documentId || sender.tab?.id == null || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return { success: false }
    const tasks = await read()
    const task = tasks.find(t => t.monitor?.token === m.token && t.tabId === sender.tab!.id && t.monitor?.documentId === sender.documentId && (t.monitor?.frameId ?? 0) === sender.frameId)
    const monitor = task?.monitor
    const now = Date.now()
    if (!task || !monitor || !active(task) || !monitor.listening || monitor.expiresAt <= now || task.runs >= task.maxRuns) return { success: false }
    if (monitor.lastReceivedAt && now - monitor.lastReceivedAt < MONITOR_EMIT_INTERVAL) return { success: false }
    const event: MonitorEvent = { id: crypto.randomUUID(), at: now }
    try {
      if (typeof m.error === 'string') throw new Error(m.error.slice(0, 500))
      if (typeof m.json !== 'string' || m.json.length > MONITOR_MESSAGE_BYTES) throw new Error('emit 消息无效或超过 8KB')
      event.data = JSON.parse(m.json)
      serializeMonitorValue(event.data, MONITOR_MESSAGE_BYTES)
    } catch (error) {
      if (monitor.errorReported) return { success: false }
      monitor.errorReported = true
      event.error = String(error instanceof Error ? error.message : error).slice(0, 500)
      monitor.listening = false
      await stopPageMonitor(task)
    }
    monitor.lastReceivedAt = now
    monitor.received++
    if (monitor.pending) monitor.coalesced++
    monitor.pending = event
    if (task.status !== 'running') { task.status = 'waiting'; task.reason = '等待会话空闲后处理页面事件' }
    await save(tasks)
    return { success: true }
  }

  chrome.runtime.onMessage.addListener((m, sender, respond) => {
    if (!['schedule:command', 'monitor:command', 'monitor:event', 'schedule:acquire', 'schedule:finish', 'schedule:host-start'].includes(m.type)) return undefined
    // Reason: extension pages opened as tabs also have sender.tab; trust the extension URL, not the absence of a tab.
    const extensionSender = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))
    if (m.type !== 'monitor:event' && !extensionSender) { respond({ success: false, error: '无效的任务消息来源' }); return undefined }
    void ready.then(() => exclusive(async () => {
      if (m.type === 'monitor:event') return receiveEvent(m, sender)
      if (m.type === 'schedule:command' || m.type === 'monitor:command') return command(m)
      const tasks = await read()
      if (m.type === 'schedule:host-start') {
        for (const task of tasks) if (task.status === 'running') {
          task.status = 'paused'; task.reason = '后台运行中断，请检查执行结果后恢复'; await stopMonitor(task)
        }
      } else {
        const task = tasks.find(t => t.id === m.taskId && t.sessionId === m.sessionId && t.occurrenceId === m.occurrenceId)
        if (!task || task.status !== 'running') throw new Error('任务已暂停、取消或失效')
        if (m.type === 'schedule:acquire') {
          if (task.monitor && !await isMonitorDocumentCurrent(task)) throw new Error('监听页面已刷新')
          const tab = await chrome.tabs.get(task.tabId)
          await restoreTurnTabs(task.sessionId, task.tabStack ?? [task.tabId])
          return { success: true, tabId: task.tabId, title: tab.title ?? '', url: tab.url ?? '' }
        }
        const top = operatingTabOf(task.sessionId)
        if (top != null && !task.monitor) {
          task.tabId = top
          task.tabStack = snapshotTurnTabs(task.sessionId)
          const tab = await chrome.tabs.get(top).catch(() => null)
          if (tab) { task.pageTitle = tab.title ?? ''; task.pageUrl = tab.url ?? '' }
        }
        Object.assign(task, finishTask(task, Date.now(), m.error))
        if (task.monitor && !active(task)) await stopMonitor(task)
      }
      await save(tasks)
      return { success: true }
    })).then(result => {
      respond(result)
      if (m.type === 'monitor:event' && result.success) void drain()
    }).catch(error => respond({ success: false, error: String(error instanceof Error ? error.message : error) }))
    return true
  })

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== ALARM) return
    void ready.then(() => exclusive(async () => {
      const tasks = await read()
      let changed = false
      for (const task of tasks) if (task.monitor && active(task) && task.monitor.listening) {
        // Reason: removed frames have no navigation event; check document identity even for quiet monitors.
        if (!await isMonitorDocumentCurrent(task)) {
          task.status = 'paused'; task.requiresRebind = true; task.reason = '目标文档已刷新或 iframe 已移除，请重新创建监听'
          await stopMonitor(task)
          changed = true
          continue
        }
        if (task.monitor.expiresAt > Date.now()) continue
        task.monitor.listening = false
        await stopPageMonitor(task)
        if (task.status !== 'running' && !task.monitor.pending) { task.status = 'completed'; task.reason = '监听已到期' }
        changed = true
      }
      if (changed) await save(tasks)
    })).then(drain).catch(error => console.warn('[schedule]', error))
  })

  const invalidateTab = (tabId: number, reason: string, documentId?: string, frameId = 0) => {
    void ready.then(() => exclusive(async () => {
      const tasks = await read()
      let changed = false
      for (const task of tasks) if (task.tabId === tabId && active(task) && (!documentId || (task.monitor && (frameId === 0 || (task.monitor.frameId ?? 0) === frameId) && task.monitor.documentId !== documentId))) {
        task.status = 'paused'; task.reason = reason
        if (task.monitor) { task.requiresRebind = true; await stopMonitor(task) }
        changed = true
      }
      if (changed) await save(tasks)
    })).catch(error => console.warn('[schedule]', error))
  }
  chrome.tabs.onRemoved.addListener(tabId => invalidateTab(tabId, '目标页面已关闭'))
  chrome.webNavigation.onCommitted.addListener(details => {
    invalidateTab(details.tabId, details.frameId === 0 ? '页面已刷新，请重新创建监听' : '目标 iframe 已刷新，请重新创建监听', details.documentId, details.frameId)
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SESSION_INDEX_KEY]) return
    const ids = new Set((changes[SESSION_INDEX_KEY].newValue ?? []).map((s: { id: string }) => s.id))
    void ready.then(() => exclusive(async () => {
      const tasks = await read()
      for (const task of tasks) if (!ids.has(task.sessionId)) await stopMonitor(task)
      const kept = tasks.filter(t => ids.has(t.sessionId))
      if (kept.length !== tasks.length) await save(kept)
    })).catch(error => console.warn('[schedule]', error))
  })
}
