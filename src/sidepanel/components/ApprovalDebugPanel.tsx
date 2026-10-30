import { useEffect, useRef, useState } from 'react'
import type { ApprovalDebugRecord, ApprovalDebugSnapshot } from '../../shared/approval-debug'
import { PERMISSION_MODE_LABELS } from '../../shared/permission-mode'
import { sessionSnapshotRef } from '../hooks/useSidekickChat'

interface Props { sessionId: string; refreshKey?: number }
type Tab = 'context' | 'trajectory' | 'output'
const controlClass = 'rounded-md border border-border-muted px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-surface-raised disabled:opacity-40'

function pretty(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
  }
  return JSON.stringify(value, null, 2) ?? '暂无数据'
}

function hasPayload(value: unknown): boolean { return Array.isArray(value) ? value.length > 0 : value != null }

function Payload({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return <details open={open} className="rounded-md border border-border-muted bg-surface-raised/40">
    <summary className="cursor-pointer px-2.5 py-2 text-[11px] text-text-secondary">{title}</summary>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t border-border-muted px-2.5 py-2 font-mono text-[10px] leading-relaxed text-text-secondary select-text">{pretty(value)}</pre>
  </details>
}

function outcome(record: ApprovalDebugRecord): string {
  if (record.error) return '运行异常'
  const decision = record.backendDecision?.decision ?? record.modelDecision?.decision
  if (decision === 'deny') return '拒绝'
  if (decision === 'allow') return '通过'
  if (decision === 'manual') return '人工确认路径'
  return record.finishedAt ? '已结束' : '运行中'
}

const routes: Record<ApprovalDebugRecord['route'], string> = {
  manual: '人工确认路径，未启动审批 Agent',
  'full-allow': '全部允许，未启动审批 Agent',
  rule: '读取规则放行，未启动审批 Agent',
  model: '独立审批 Agent',
  'setup-failure': '审批准备失败',
}

function Trajectory({ record }: { record: ApprovalDebugRecord }) {
  const steps = record.steps ?? []
  if (!steps.length) return <div className="space-y-2">
    <p className="text-[11px] text-text-muted">{record.route === 'model' ? '等待第一轮模型调用…' : routes[record.route]}</p>
    {record.investigations.map(item => <div key={item.id} className="space-y-1 border-l border-border-muted pl-3">
      <Payload title={`调用只读 Bash · ${item.command}`} value={item.command} open />
      <Payload title="工具返回" value={item.error ?? item.result ?? '等待返回…'} open />
    </div>)}
  </div>
  return <ol className="space-y-4">
    {record.investigations.filter(item => !item.finishedAt).map(item => <li key={item.id} className="space-y-1 border-l-2 border-accent/30 pl-3">
      <p role="status" className="text-[11px] text-text-muted">正在执行只读 Bash</p>
      <Payload title="工具调用参数" value={{ command: item.command }} open />
    </li>)}
    {steps.map(step => <li key={step.stepNumber} className="border-l-2 border-accent/30 pl-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2 text-[11px]">
        <span className="font-medium text-text-primary">第 {step.stepNumber + 1} 轮模型调用</span>
        <span className="text-[10px] tabular-nums text-text-muted">{step.finishedAt ? `${((step.finishedAt - step.startedAt) / 1000).toFixed(2)} s` : '生成中'}</span>
        {step.finishReason && <span className="text-[10px] text-text-muted">{step.finishReason}</span>}
      </div>
      <div className="space-y-1.5">
        {step.model && <p className="break-all font-mono text-[10px] text-text-muted">{step.model.provider} · {step.model.model}</p>}
        <Payload title="本轮实际输入上下文 · 推理项不展开" value={step.messages} />
        {step.system != null && <Payload title="本轮系统指令" value={step.system} />}
        {step.text && <Payload title="模型输出" value={step.text} open />}
        {hasPayload(step.toolCalls) && <Payload title="模型发出的工具调用" value={step.toolCalls} open />}
        {hasPayload(step.toolResults) && <Payload title="工具返回给模型的内容" value={step.toolResults} open />}
        {step.usage && <Payload title="本轮用量" value={step.usage} />}
        {step.error && <p role="alert" className="text-[11px] text-error">{step.error}</p>}
      </div>
    </li>)}
  </ol>
}

export default function ApprovalDebugPanel({ sessionId, refreshKey = 0 }: Props) {
  const [snapshot, setSnapshot] = useState<ApprovalDebugSnapshot | null>(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('trajectory')
  const [refresh, setRefresh] = useState(0)
  const [command, setCommand] = useState('')
  const [testing, setTesting] = useState(false)
  const [observedAt, setObservedAt] = useState(0)
  const scope = useRef(sessionId)
  useEffect(() => { scope.current = sessionId; return () => { scope.current = '' } }, [sessionId])

  const connection = () => {
    const current = sessionSnapshotRef.current?.()
    if (!current || current.sessionId !== sessionId) throw new Error('请先在 Chat 中打开所选会话，再查看该会话的审批 Agent。')
    if (!current.getApprovalDebug) throw new Error('审批 Agent inspector 尚未连接，请重新加载扩展。')
    return current
  }

  useEffect(() => {
    let live = true
    let reading = false
    async function load() {
      if (reading) return
      reading = true
      try {
        const current = sessionSnapshotRef.current?.()
        if (!current || current.sessionId !== sessionId) throw new Error('请先在 Chat 中打开所选会话，再查看该会话的审批 Agent。')
        if (!current.getApprovalDebug) throw new Error('审批 Agent inspector 尚未连接，请重新加载扩展。')
        const data = await current.getApprovalDebug()
        if (data.sessionId !== sessionId || sessionSnapshotRef.current?.().sessionId !== sessionId) throw new Error('会话已切换，请重新选择会话。')
        if (live) { setSnapshot(data); setObservedAt(Date.now()); setError('') }
      } catch (cause) {
        if (live) { setSnapshot(null); setError(cause instanceof Error ? cause.message : String(cause)) }
      } finally { reading = false }
    }
    void load()
    const timer = setInterval(() => { void load() }, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [sessionId, refreshKey, refresh])

  async function clear() {
    setFeedback('')
    try {
      const current = connection()
      if (!current.clearApprovalDebug) throw new Error('当前连接不支持清空记录')
      await current.clearApprovalDebug()
      if (scope.current === sessionId) { setSelectedId(null); setRefresh(value => value + 1); setFeedback('已清空调试记录，不影响任务执行') }
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function test() {
    if (!command.trim() || testing) return
    setTesting(true); setFeedback('')
    try {
      const current = connection()
      if (!current.testApproval) throw new Error('当前连接不支持审批测试')
      await current.testApproval(command.trim())
      if (scope.current === sessionId) { setSelectedId(null); setTab('trajectory'); setRefresh(value => value + 1); setFeedback('测试完成，待测命令未执行') }
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : String(cause)) }
    finally { setTesting(false) }
  }

  const records = snapshot?.records ?? []
  const selected = records.find(record => record.id === selectedId) ?? records.at(-1)

  async function copy() {
    if (!selected || !snapshot) return
    try {
      await navigator.clipboard.writeText(pretty({ instructions: snapshot.instructions, ...selected }))
      setFeedback('已复制本次 Agent 上下文与工作轨迹')
    } catch { setFeedback('复制失败，请展开内容后手动复制') }
  }

  return <section aria-label="审批 Agent inspector" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 select-text">
    <div className="flex items-center gap-2">
      <h2 className="text-xs font-medium text-text-primary">审批 Agent</h2>
      {snapshot && <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-text-muted">{PERMISSION_MODE_LABELS[snapshot.permissionMode]}</span>}
      <button type="button" onClick={() => setRefresh(value => value + 1)} className={`${controlClass} ml-auto`}>刷新</button>
      <button type="button" disabled={!records.length} onClick={() => { void clear() }} className={controlClass}>清空</button>
    </div>
    {error && <p role="alert" className="text-[11px] text-error">{error}</p>}
    {snapshot && <>
      <p className="text-[10px] leading-relaxed text-text-muted">{snapshot.model.model || '未配置模型'} · {snapshot.model.protocol} · low 思考 · {snapshot.state.status === 'reviewing' ? '正在审批' : '空闲'}<br />独立查看每次审批的实际输入、模型轮次和工具返回。记录仅保存在内存中，宿主重启后清空。</p>
      {snapshot.model.endpoint && <p className="break-all font-mono text-[10px] text-text-muted">{snapshot.model.endpoint}</p>}
      <label className="block text-[10px] text-text-muted">选择一次调用
        <select aria-label="审批 Agent 运行记录" value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)} disabled={!records.length}
          className="mt-1 w-full rounded-md border border-border-muted bg-surface-raised px-2 py-1.5 text-[11px] text-text-secondary outline-none focus:border-accent">
          {!records.length && <option value="">暂无记录</option>}
          {[...records].reverse().map(record => <option key={record.id} value={record.id}>{new Date(record.startedAt).toLocaleTimeString()} · {record.toolName} · {record.diagnostic ? '仅测试 · ' : ''}{outcome(record)}</option>)}
        </select>
      </label>
      {!selected && <p className="rounded-md border border-border-muted p-3 text-[11px] leading-relaxed text-text-muted">尚未触发审批 Agent。切到 Chat，选择「自动审批」后发起任务；普通读取可能按规则直接放行。也可以在下方仅测试审批。</p>}
      {selected && <>
        {selected.truncated && <p role="status" className="text-[10px] text-warning">本次轨迹超过调试内存预算，部分内容已标记截断。</p>}
        <div className="space-y-1 text-[10px] text-text-muted">
          <p>{routes[selected.route]}{selected.diagnostic ? ' · 仅测试，不执行命令' : ''}</p>
          <p className="tabular-nums">{outcome(selected)} · {((selected.elapsedMs ?? Math.max(0, observedAt - selected.startedAt)) / 1000).toFixed(2)} s · {selected.usage ? `${selected.usage.partial ? '≥ ' : ''}${selected.usage.inputTokens ?? '—'} 输入 / ${selected.usage.outputTokens ?? '—'} 输出 tokens` : '用量尚不可用'}</p>
          <p className="break-all font-mono">toolCallId: {selected.toolCallId}</p>
        </div>
        <div className="flex items-center gap-1 border-b border-border-muted pb-1" role="tablist" aria-label="审批 Agent 详情">
          {([['context', '上下文'], ['trajectory', '工作轨迹'], ['output', '最终输出']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`rounded px-2 py-1.5 text-[11px] transition-colors ${tab === value ? 'bg-accent-wash text-accent' : 'text-text-muted hover:bg-surface-raised'}`}>{label}</button>)}
          <button type="button" onClick={() => { void copy() }} className={`${controlClass} ml-auto`}>复制本次</button>
        </div>
        <div role="tabpanel" aria-label={tab === 'context' ? '上下文' : tab === 'trajectory' ? '工作轨迹' : '最终输出'} className="space-y-2">
          {tab === 'context' && <>
            <Payload title="固定审批指令 · system" value={snapshot.instructions} open />
            <Payload title="初始输入 · 用户消息、历史调用和待审批操作" value={selected.context ?? '此调用没有启动审批模型'} open />
            <Payload title="审批 Agent 工具声明" value={selected.steps?.[0]?.tools ?? '尚未进入模型调用'} />
            <Payload title="待审批工具参数" value={selected.args} />
            <Payload title="执行环境" value={selected.environment} />
          </>}
          {tab === 'trajectory' && <Trajectory record={selected} />}
          {tab === 'output' && <>
            <Payload title="审批模型最终判定" value={selected.modelDecision ?? '没有模型判定'} open />
            <Payload title="后台应用的判定" value={selected.backendDecision ?? '等待判定…'} open />
            <Payload title="执行阶段 · finished 仅表示工具调用结束" value={selected.execution} />
            {selected.error && <p role="alert" className="text-[11px] text-error">{selected.error}</p>}
          </>}
        </div>
      </>}
      <details className="border-t border-border-muted pt-2">
        <summary className="cursor-pointer py-1 text-[11px] text-text-secondary">仅测试审批 Agent</summary>
        <p className="my-2 text-[10px] leading-relaxed text-text-muted">使用本会话的用户上下文和当前模型，强制运行自动审批。会调用模型，但不会执行待测 Bash 命令，也不会改变权限模式。</p>
        <textarea aria-label="待审批 Bash 命令" value={command} onChange={event => setCommand(event.target.value)} rows={3} maxLength={12_000} placeholder="例如：bash /tmp/task.sh"
          className="w-full resize-y rounded-md border border-border-muted bg-surface-raised p-2 font-mono text-[11px] text-text-primary outline-none focus:border-accent" />
        <button type="button" disabled={!command.trim() || testing} onClick={() => { void test() }} className={`${controlClass} mt-2`}>{testing ? '审批 Agent 运行中…' : '仅审批，不执行'}</button>
      </details>
      <p className="text-[9px] text-text-muted">保留最近 {snapshot.limits.maxRecords} 条，受内存预算限制 · 当前 {(snapshot.limits.currentChars / 1024).toFixed(1)} Ki 字符</p>
    </>}
    {feedback && <p role="status" className="text-[11px] text-text-secondary">{feedback}</p>}
  </section>
}
