export const MONITOR_MESSAGE_BYTES = 8192
export const MONITOR_CODE_LIMIT = 20_000
export const MONITOR_WAKE_INTERVAL = 60_000
export const MONITOR_EMIT_INTERVAL = 1000

// Reason: JSON.stringify silently drops functions and DOM properties; monitor events must preserve their meaning exactly.
export function serializeMonitorValue(value: unknown, maxBytes = 8192): string {
  const ancestors = new Set<object>()
  let nodes = 0
  const check = (item: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 32) throw new Error('monitor 消息过于复杂')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object') throw new Error('emit 只接受 JSON 值，不能包含 undefined、函数、BigInt 或非有限数字')
    if (ancestors.has(item)) throw new Error('emit 消息不能包含循环引用')
    const proto = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new Error('emit 只接受普通对象和数组，不能包含 DOM、Date 或其他实例')
    ancestors.add(item)
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) check(item[i], depth + 1)
    } else {
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') throw new Error('emit 消息不能包含 Symbol 属性')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('emit 消息只能包含可枚举的数据属性')
        check(descriptor.value, depth + 1)
      }
    }
    ancestors.delete(item)
  }
  check(value, 0)
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).length > maxBytes) throw new Error(`emit 消息超过 ${maxBytes} 字节`)
  return json
}
