export const CANVAS_CONTEXT_LIMIT = 3
export const CANVAS_STATE_BYTES = 8192
export const canvasStorageKey = (sessionId: string) => `sidekick_canvas:${sessionId}`

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface CanvasBinding { sessionId: string; canvasId: string; path: string; title: string; sessionTitle?: string }
export interface WidgetState { modelContent: JsonValue; privateContent: JsonValue }
export interface CanvasSnapshot {
  canvasId: string
  title: string
  path: string
  modelRevision: number
  modelContent: JsonValue
}

export function latestCanvasSnapshots(snapshots: CanvasSnapshot[]): CanvasSnapshot[] {
  const latest = new Map<string, CanvasSnapshot>()
  for (const snapshot of snapshots) {
    const previous = latest.get(snapshot.canvasId)
    if (previous && previous.modelRevision > snapshot.modelRevision) continue
    latest.delete(snapshot.canvasId)
    latest.set(snapshot.canvasId, snapshot)
  }
  return [...latest.values()].slice(-CANVAS_CONTEXT_LIMIT)
}
export interface CanvasRecord extends CanvasBinding, WidgetState {
  revision: number
  modelRevision: number
  committedModelRevision: number
  order: number
}
interface CanvasDocument {
  clock: number
  owner?: string
  records: Record<string, CanvasRecord>
  claims: Record<string, CanvasSnapshot[]>
}
export interface CanvasPersistence {
  read(sessionId: string): Promise<CanvasDocument | undefined>
  write(sessionId: string, value: CanvasDocument): Promise<void>
  lock<T>(sessionId: string, work: () => Promise<T>): Promise<T>
}

function canonical(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 40) throw new Error('画布状态嵌套过深')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('画布状态必须是无循环的 JSON 数据')
  seen.add(value)
  let result: string
  if (Array.isArray(value)) result = `[${value.map(v => canonical(v, seen, depth + 1)).join(',')}]`
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('画布状态必须是普通 JSON 对象')
    result = `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], seen, depth + 1)}`).join(',')}}`
  }
  seen.delete(value)
  return result
}

export function validateWidgetPatch(value: unknown): Partial<WidgetState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画布状态必须是对象')
  const patch: Partial<WidgetState> = {}
  for (const key of Object.keys(value)) {
    if (key !== 'modelContent' && key !== 'privateContent') throw new Error(`未知画布状态字段：${key}`)
    const json = canonical((value as Record<string, unknown>)[key])
    if (new TextEncoder().encode(json).length > CANVAS_STATE_BYTES) throw new Error(`${key} 不能超过 8 KiB`)
    patch[key] = JSON.parse(json) as JsonValue
  }
  return patch
}

export function validateFollowUp(value: unknown): { prompt: string; title?: string } {
  const args = value as { prompt?: unknown; title?: unknown } | null
  if (!args || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000) throw new Error('消息需要包含 1–4000 字符的内容')
  if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 120)) throw new Error('标题不能超过 120 字符')
  return { prompt: args.prompt, ...(args.title === undefined ? {} : { title: args.title as string }) }
}

// Reason: all hosts use one serialized, durable state service; frames never choose their session.
export class CanvasStateStore {
  private readonly persistence: CanvasPersistence
  constructor(persistence: CanvasPersistence) { this.persistence = persistence }

  private run<T>(sessionId: string, work: (doc: CanvasDocument) => T | Promise<T>): Promise<T> {
    return this.persistence.lock(sessionId, async () => {
      const doc = await this.persistence.read(sessionId) ?? { clock: 0, records: {}, claims: {} }
      const result = await work(doc)
      await this.persistence.write(sessionId, doc)
      return structuredClone(result)
    })
  }

  open(binding: CanvasBinding): Promise<CanvasRecord> {
    return this.run(binding.sessionId, doc => {
      const previous = Object.hasOwn(doc.records, binding.canvasId) ? doc.records[binding.canvasId] : undefined
      if (previous && previous.path !== binding.path) throw new Error('画布来源不匹配')
      if (previous) return previous
      const record: CanvasRecord = { ...binding, revision: 0, modelRevision: 0, committedModelRevision: 0, order: 0, modelContent: null, privateContent: null }
      Object.defineProperty(doc.records, binding.canvasId, { value: record, enumerable: true, writable: true, configurable: true })
      return record
    })
  }

  set(binding: CanvasBinding, value: unknown): Promise<CanvasRecord> {
    const patch = validateWidgetPatch(value)
    return this.run(binding.sessionId, doc => {
      const record = Object.hasOwn(doc.records, binding.canvasId) ? doc.records[binding.canvasId] : undefined
      if (!record || record.path !== binding.path) throw new Error('画布尚未初始化或来源已失效')
      const modelChanged = 'modelContent' in patch && canonical(patch.modelContent) !== canonical(record.modelContent)
      const privateChanged = 'privateContent' in patch && canonical(patch.privateContent) !== canonical(record.privateContent)
      if (modelChanged || privateChanged) {
        Object.assign(record, patch)
        record.revision++
        if (modelChanged) { record.modelRevision++; record.order = ++doc.clock }
      }
      return record
    })
  }

  capture(sessionId: string, owner: string, claimId: string, forceId?: string, liveClaims?: string[]): Promise<CanvasSnapshot[]> {
    return this.run(sessionId, doc => {
      // Reason: a new runtime has no surviving queue; old reservations must not hide dirty state after a restart.
      if (doc.owner !== owner) { doc.owner = owner; doc.claims = {} }
      if (liveClaims) {
        // Reason: a lost RPC acknowledgement must not leave dirty state reserved by a message the kernel never accepted.
        const live = new Set([...liveClaims, claimId])
        for (const id of Object.keys(doc.claims)) if (!live.has(id)) delete doc.claims[id]
      }
      if (Object.hasOwn(doc.claims, claimId)) return doc.claims[claimId]
      const forced = forceId && Object.hasOwn(doc.records, forceId) ? doc.records[forceId] : undefined
      if (forceId && !forced) throw new Error('来源画布已失效')
      const recent = Object.values(doc.records).filter(r => r.order > 0 && r.canvasId !== forceId)
        .sort((a, b) => b.order - a.order).slice(0, CANVAS_CONTEXT_LIMIT - (forced ? 1 : 0))
      const reserved = Object.values(doc.claims).flat()
      const selected = [...(forced ? [forced] : []), ...recent].filter(r => r === forced || (
        r.modelRevision > r.committedModelRevision && !reserved.some(s => s.canvasId === r.canvasId && s.modelRevision === r.modelRevision)
      ))
      const snapshots = selected.map(({ canvasId, title, path, modelRevision, modelContent }) => ({ canvasId, title, path, modelRevision, modelContent }))
      Object.defineProperty(doc.claims, claimId, { value: snapshots, enumerable: true, configurable: true, writable: true })
      return snapshots
    })
  }

  release(sessionId: string, claimId: string): Promise<void> {
    return this.run(sessionId, doc => { delete doc.claims[claimId] })
  }

  commit(sessionId: string, snapshots: CanvasSnapshot[]): Promise<void> {
    return this.run(sessionId, doc => {
      for (const snapshot of snapshots) {
        if (!snapshot || typeof snapshot !== 'object') continue
        const r = Object.hasOwn(doc.records, snapshot.canvasId) ? doc.records[snapshot.canvasId] : undefined
        if (r && r.path === snapshot.path && Number.isSafeInteger(snapshot.modelRevision) && snapshot.modelRevision <= r.modelRevision) {
          r.committedModelRevision = Math.max(r.committedModelRevision, snapshot.modelRevision)
        }
      }
    })
  }
}
