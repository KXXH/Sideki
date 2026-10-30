import { describe, it, expect } from 'vitest'
import { readdirSync } from 'fs'
import { resolve } from 'path'

// Reason: microlighter compiles TextMate patterns with `new RegExp(p, 'dgm')` and has
// no try-catch around it (dist/highlight.js `exec`). A single pattern using
// oniguruma-only syntax would throw and abort the whole highlightAll call, which
// strips color from *every* block rather than degrading one. These grammars are
// third-party data, so pin the assumption that all of them compile under JS RegExp.

const GRAMMAR_DIR = resolve(__dirname, '../../node_modules/microlighter/dist/grammars')

interface Rule {
  match?: string
  begin?: string
  end?: string
  patterns?: Rule[]
  captures?: Record<string, unknown>
  repository?: Record<string, unknown>
}

function collectPatterns(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPatterns(item, out)
    return
  }
  if (!node || typeof node !== 'object') return

  const rule = node as Rule
  for (const key of ['match', 'begin', 'end'] as const) {
    if (typeof rule[key] === 'string') out.push(rule[key])
  }
  for (const value of Object.values(node)) collectPatterns(value, out)
}

function countIncludes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, i) => n + countIncludes(i), 0)
  if (!node || typeof node !== 'object') return 0

  const self = typeof (node as { include?: unknown }).include === 'string' ? 1 : 0
  return Object.values(node).reduce<number>((n, v) => n + countIncludes(v), self)
}

const grammarFiles = readdirSync(GRAMMAR_DIR).filter(f => f.endsWith('.js')).sort()

describe('microlighter bundled grammars', () => {
  it('ships the full language set', () => {
    expect(grammarFiles.length).toBe(37)
  })

  it.each(grammarFiles)('%s compiles every pattern under JS RegExp', async file => {
    const mod = await import(`${GRAMMAR_DIR}/${file}`)
    const patterns: string[] = []
    collectPatterns(mod.default, patterns)

    // Reason: composition-only grammars like tsx carry no patterns of their own and
    // pull everything in via `include`, so require one or the other rather than both.
    expect(patterns.length + countIncludes(mod.default)).toBeGreaterThan(0)

    const failures: { pattern: string; error: string }[] = []
    for (const pattern of patterns) {
      try {
        // Reason: same flags microlighter uses — `d` for indices, which some engines
        // reject in combination with certain constructs.
        new RegExp(pattern, 'dgm')
      } catch (err) {
        failures.push({ pattern, error: (err as Error).message })
      }
    }

    expect(failures).toEqual([])
  })
})
