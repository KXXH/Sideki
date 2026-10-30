import { describe, expect, it } from 'vitest'
import { parsePageSpec } from '../../src/background/shell-commands'
import { MAX_PAGES_PER_CALL } from '../../src/background/pdf-engine'

function pagesOf(spec: string): number[] {
  const r = parsePageSpec(spec)
  if ('error' in r) throw new Error(`expected pages, got error: ${r.error}`)
  return r.pages
}

function errorOf(spec: string): string {
  const r = parsePageSpec(spec)
  if (!('error' in r)) throw new Error(`expected an error, got pages: ${r.pages}`)
  return r.error
}

describe('parsePageSpec', () => {
  it('parses a single page', () => {
    expect(pagesOf('3')).toEqual([3])
  })

  it('parses a range inclusively', () => {
    expect(pagesOf('2-5')).toEqual([2, 3, 4, 5])
  })

  it('parses a mixed list, deduplicating and sorting', () => {
    expect(pagesOf('10,1-3,2')).toEqual([1, 2, 3, 10])
  })

  it('tolerates surrounding whitespace', () => {
    expect(pagesOf(' 1 , 4-5 ')).toEqual([1, 4, 5])
  })

  it('treats a single-page range as that page', () => {
    expect(pagesOf('7-7')).toEqual([7])
  })

  // Reason: the engine throws on page 0 (pages are 1-indexed) — reject it here
  // so the model gets an actionable message instead of a raw panic.
  it('rejects page 0', () => {
    expect(errorOf('0')).toMatch(/1-indexed/)
    expect(errorOf('0-4')).toMatch(/1-indexed/)
  })

  it('rejects a reversed range', () => {
    expect(errorOf('9-2')).toMatch(/end is before start/)
  })

  it('rejects malformed segments', () => {
    expect(errorOf('abc')).toMatch(/invalid --pages segment/)
    expect(errorOf('1--3')).toMatch(/invalid --pages segment/)
    expect(errorOf('')).toMatch(/invalid --pages segment/)
    expect(errorOf('-5')).toMatch(/invalid --pages segment/)
  })

  // Reason: the cap bounds how long a synchronous WASM parse blocks the service
  // worker, so an explicit range must not be a way around it.
  it('rejects more pages than the per-call cap', () => {
    expect(pagesOf(`1-${MAX_PAGES_PER_CALL}`)).toHaveLength(MAX_PAGES_PER_CALL)
    expect(errorOf(`1-${MAX_PAGES_PER_CALL + 1}`)).toMatch(/at most/)
  })

  it('counts distinct pages against the cap, not raw segments', () => {
    expect(pagesOf(`1-${MAX_PAGES_PER_CALL},1-10`)).toHaveLength(MAX_PAGES_PER_CALL)
  })
})
