import { useState } from 'react'

const PRESETS = [200000, 400000, 1000000]
export default function ContextWindowPicker({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [custom, setCustom] = useState(false)
  const showCustom = custom || !PRESETS.includes(value)
  return <div className="model-context-picker">
    <div role="group" aria-label="上下文预算">
      {PRESETS.map(n => <button key={n} type="button" aria-pressed={!showCustom && value === n} onClick={() => { setCustom(false); onChange(n) }}>{n === 1000000 ? '1M' : `${n / 1000}K`}</button>)}
      <button type="button" aria-pressed={showCustom} onClick={() => setCustom(true)}>自定义</button>
    </div>
    {showCustom && <label className="model-context-custom">自定义 token 数<input type="number" aria-label="自定义上下文预算" value={value || ''} min="1" step="1" required onChange={e => onChange(Number(e.target.value))} /></label>}
  </div>
}
