import { useEffect, useState } from 'react'
import { advanceLabel, draw, PHASE_POOLS, type LabelState, type StatusPhase } from '../status-phase'

const ROTATE_MS = 5000

// Reason: the rotation clock is keyed on the phase, so a switch redraws from
// the new pool on the spot (SwapSlot crossfades the swap) and starts counting
// again — otherwise a label could flip one tick after the phase it belongs to.
export function usePhaseLabel(phase: StatusPhase): string {
  const [state, setState] = useState<LabelState>(() => ({ phase, label: PHASE_POOLS[phase][0] ?? '' }))

  // Reason: render-time adjustment (React's documented pattern) — the new
  // phase's wording has to land in the same commit as the phase itself.
  if (state.phase !== phase) setState(advanceLabel(state, phase))

  useEffect(() => {
    const pool = PHASE_POOLS[phase]
    if (pool.length < 2) return
    const id = setInterval(() => setState(s => ({ ...s, label: draw(pool, s.label) })), ROTATE_MS)
    return () => clearInterval(id)
  }, [phase])

  return state.label
}
