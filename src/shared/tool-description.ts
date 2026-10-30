export interface DescribedToolCall {
  state: string
  input?: unknown
  rawInput?: unknown
}

export interface ToolActivity {
  id: string
  description: string
  phase: 'preparing' | 'executing'
}

const DESCRIBED_TOOLS = new Set(['click', 'hover', 'type', 'select', 'keypress', 'scroll', 'screenshot', 'wait', 'navigate', 'getPageContent', 'bash', 'visualize', 'useSkill', 'schedule', 'monitor'])

export function supportsToolDescription(name: string): boolean {
  return DESCRIBED_TOOLS.has(name)
}

export function cleanToolDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || null
}

// Reason: a partial-JSON parser repairs an unfinished string, so input alone
// cannot tell whether the model has finished its description. Scan only the
// top-level field in the original stream, honoring escaped quotes and nesting.
export function streamedDescription(raw: string): string | null {
  let depth = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '{' || ch === '[') { depth++; continue }
    if (ch === '}' || ch === ']') { depth--; continue }
    if (ch !== '"') continue
    const start = i
    for (i++; i < raw.length; i++) {
      if (raw[i] === '\\') { i++; continue }
      if (raw[i] === '"') break
    }
    if (i >= raw.length) return null
    if (depth !== 1) continue
    let key: unknown
    try { key = JSON.parse(raw.slice(start, i + 1)) } catch { return null }
    if (key !== 'description') continue
    let pos = i + 1
    while (/\s/.test(raw[pos] ?? '') && pos < raw.length) pos++
    if (raw[pos++] !== ':') continue
    while (/\s/.test(raw[pos] ?? '') && pos < raw.length) pos++
    if (raw[pos] !== '"') return null
    const valueStart = pos++
    for (; pos < raw.length; pos++) {
      if (raw[pos] === '\\') { pos++; continue }
      if (raw[pos] !== '"') continue
      try { return cleanToolDescription(JSON.parse(raw.slice(valueStart, pos + 1))) } catch { return null }
    }
    return null
  }
  return null
}

export function toolDescription(call: DescribedToolCall): string | null {
  if (call.state === 'input-streaming') {
    return typeof call.rawInput === 'string' ? streamedDescription(call.rawInput) : null
  }
  if (!call.input || typeof call.input !== 'object') return null
  return cleanToolDescription((call.input as Record<string, unknown>).description)
}
