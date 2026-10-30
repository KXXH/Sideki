import { describe, it, expect } from 'vitest'
import { buildReplWrapper } from '../../src/background/tool-handlers'

// Reason: the wrapper string is evaluated verbatim in the page, so replaying
// it through eval in-node exercises the real routing semantics — no browser
// needed to regression-guard the payload tiers.

interface WrapResult { s: number; r?: string; e?: string; logs?: string }

function runSync(code: string): WrapResult {
  return (0, eval)(buildReplWrapper(code)) as WrapResult
}
async function runAsync(code: string, timeoutMs = 5000): Promise<WrapResult> {
  return (0, eval)(buildReplWrapper(code, true, timeoutMs)) as Promise<WrapResult>
}

describe('buildReplWrapper async routing', () => {
  it('returns expression values', async () => {
    expect((await runAsync('42')).r).toBe('42')
    expect((await runAsync('{a:1}')).r).toBe('{"a":1}')
  })

  it('keeps completion values for statement forms', async () => {
    expect((await runAsync('42;')).r).toBe('42')
    expect((await runAsync('var a=1; a+1')).r).toBe('2')
  })

  it('resolves async IIFE results — with or without trailing semicolon', async () => {
    expect((await runAsync('(async()=>{return 42})()')).r).toBe('42')
    expect((await runAsync('(async()=>{return 42})();')).r).toBe('42')
  })

  it('supports top-level await expressions', async () => {
    expect((await runAsync('await 1')).r).toBe('1')
    expect((await runAsync('await Promise.resolve(7)')).r).toBe('7')
  })

  it('supports explicit return in async statement code', async () => {
    expect((await runAsync('return 42')).r).toBe('42')
    expect((await runAsync('var b=1; b = await new Promise(r=>setTimeout(()=>r(5),20)); return b+1')).r).toBe('6')
  })

  it('statement + top-level await without return yields undefined', async () => {
    // Documented boundary: completion values never survive function bodies,
    // so this form needs an explicit return (the AsyncFunction tier).
    expect((await runAsync('var b=1; await 1; b+1')).r).toBe('undefined')
  })

  it('console.log output wins over the result value', async () => {
    expect((await runAsync('console.log("hi"); 7')).r).toBe('hi')
  })

  it('string results are not double-encoded', async () => {
    expect((await runAsync('JSON.stringify({a:1})')).r).toBe('{"a":1}')
    expect((await runAsync('"hello"')).r).toBe('hello')
  })

  it('runtime errors fail once — lower tiers never re-execute', async () => {
    ;(globalThis as Record<string, unknown>).__cnt = 0
    const r = await runAsync('globalThis.__cnt++; null.x')
    expect(r.s).toBe(0)
    expect((globalThis as Record<string, unknown>).__cnt).toBe(1)
  })

  it('expression payload with a runtime SyntaxError executes exactly once', async () => {
    // JSON.parse throws SyntaxError at runtime, not parse time — the compile
    // probe must not mistake it for a parse signal and retry.
    ;(globalThis as Record<string, unknown>).__once = 0
    const r = await runAsync('globalThis.__once++, JSON.parse("x")')
    expect(r.s).toBe(0)
    expect((globalThis as Record<string, unknown>).__once).toBe(1)
  })

  it('statement payload with a runtime SyntaxError runs in eval + function tier', async () => {
    // Documented window: eval has no compile-only probe for program grammar,
    // so a runtime SyntaxError in statement form is retried once.
    ;(globalThis as Record<string, unknown>).__win = 0
    const r = await runAsync('globalThis.__win++; JSON.parse("x")')
    expect(r.s).toBe(0)
    expect((globalThis as Record<string, unknown>).__win).toBe(2)
  })

  it('enforces the async timeout', async () => {
    const r = await runAsync('await new Promise(r=>setTimeout(r,1000))', 50)
    expect(r.s).toBe(0)
    expect(r.e).toContain('Async timeout')
  })
})

describe('buildReplWrapper sync routing', () => {
  it('returns expression values and fixes {a:1} block parsing', () => {
    expect(runSync('42').r).toBe('42')
    expect(runSync('{a:1}').r).toBe('{"a":1}')
  })

  it('keeps completion values for statement forms', () => {
    expect(runSync('42;').r).toBe('42')
    expect(runSync('var a=1; a+1').r).toBe('2')
  })

  it('supports explicit return via the Function fallback', () => {
    expect(runSync('return 42').r).toBe('42')
  })

  it('string results are not double-encoded', () => {
    expect(runSync('JSON.stringify({a:1})').r).toBe('{"a":1}')
  })

  it('expression payload with a runtime SyntaxError executes exactly once', () => {
    ;(globalThis as Record<string, unknown>).__s1 = 0
    const r = runSync('globalThis.__s1++, JSON.parse("x")')
    expect(r.s).toBe(0)
    expect((globalThis as Record<string, unknown>).__s1).toBe(1)
  })
})
