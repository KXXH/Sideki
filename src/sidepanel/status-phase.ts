// Reason: the status line is one linear turn phase, derived — never stored.
// Everything here is a pure function of signals the mirror already carries
// (preparing / status / which part kind the message is ending on), so both
// hosts and every render point agree on what the turn is doing.
//
// The kernel port itself is a separate axis (an environment state, like an
// MCP server's) and lives in the top-bar chip, not in this machine.

export type StatusPhase =
  | 'idle'
  | 'building'
  | 'requesting'
  | 'working'
  | 'writing'

// What the assistant message is currently ending on. Text is the only
// user-facing signal; tools and reasoning are internal work.
export type TrailingKind = 'none' | 'tool' | 'reasoning' | 'text'

export interface PhaseInput {
  status: string
  preparing: boolean
  // Reason: a send is in flight and the turn has not reached the SDK yet —
  // status still reads 'ready' for that whole stretch.
  dispatching: boolean
  trailing: TrailingKind
}

export function derivePhase({ status, preparing, dispatching, trailing }: PhaseInput): StatusPhase {
  if (preparing) return 'building'
  if (dispatching) return 'requesting'
  if (status === 'submitted') return 'requesting'
  // Reason: the streaming split is what keeps the label honest — once text is
  // flowing the message itself is the signal, so the slot stops speaking.
  if (status === 'streaming') return trailing === 'text' ? 'writing' : 'working'
  // Reason: 'error' lands here on purpose — the error bar owns that signal.
  return 'idle'
}

export interface LabelState {
  phase: StatusPhase
  label: string
}

export function draw(pool: readonly string[], prev: string): string {
  const others = pool.filter(l => l !== prev)
  const from = others.length > 0 ? others : pool
  return from[Math.floor(Math.random() * from.length)]
}

// Reason: runs at the phase boundary — a sentence must not outlive the phase
// that produced it. An empty pool means the phase has no words of its own (the
// streaming text is the signal), so the last sentence is kept.
export function advanceLabel(state: LabelState, phase: StatusPhase): LabelState {
  if (state.phase === phase) return state
  const pool = PHASE_POOLS[phase]
  if (pool.length === 0) return { phase, label: state.label }
  return { phase, label: draw(pool, state.label) }
}

// Reason: one pool per phase, switched at the phase boundary so a sentence can
// never outlive the phase that produced it. An empty pool means the phase has
// no words of its own and the slot keeps the previous sentence (frozen).
export const PHASE_POOLS: Record<StatusPhase, readonly string[]> = {
  idle: [],
  building: ['正在初始化 Agent...'],
  requesting: ['正在思考...'],
  working: [
    '正在拉通对齐...',
    '正在寻找抓手...',
    '正在沉淀方法论...',
    '正在赋能...',
    '正在打通链路...',
    '正在形成闭环...',
    '正在向上管理...',
    '正在对焦颗粒度...',
  ],
  writing: [],
}
