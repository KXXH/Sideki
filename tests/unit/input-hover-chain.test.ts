import { describe, it, expect } from 'vitest'
import { diffHoverChain, chainChanged } from '../../src/shared/input/hover-chain'

// Reason: hit-test chains are ordered innermost → outermost, matching
// document.elementsFromPoint. The spec's enter/leave ordering is the part that
// is easy to get backwards, so it is pinned here with plain strings — no DOM
// needed, which is the point of keeping the diff generic.

describe('diffHoverChain', () => {
  it('reports nothing when the chain is unchanged', () => {
    const chain = ['btn', 'form', 'main', 'body']
    const d = diffHoverChain(chain, chain)
    expect(d.left).toEqual([])
    expect(d.entered).toEqual([])
    expect(d.common).toEqual(chain)
  })

  it('leaves innermost-first and enters outermost-first', () => {
    // moving from a button inside a form to a link inside a nav
    const prev = ['btn', 'form', 'main', 'body']
    const next = ['link', 'nav', 'body']
    const d = diffHoverChain(prev, next)
    expect(d.left).toEqual(['btn', 'form', 'main'])
    expect(d.entered).toEqual(['nav', 'link'])
    expect(d.common).toEqual(['body'])
  })

  it('treats a descent into a child as pure enter', () => {
    const d = diffHoverChain(['card', 'body'], ['label', 'card', 'body'])
    expect(d.left).toEqual([])
    expect(d.entered).toEqual(['label'])
    expect(d.common).toEqual(['card', 'body'])
  })

  it('treats an ascent to the parent as pure leave', () => {
    const d = diffHoverChain(['label', 'card', 'body'], ['card', 'body'])
    expect(d.left).toEqual(['label'])
    expect(d.entered).toEqual([])
  })

  it('handles entering the document from nowhere', () => {
    const d = diffHoverChain([], ['btn', 'body'])
    expect(d.left).toEqual([])
    expect(d.entered).toEqual(['body', 'btn'])
    expect(d.common).toEqual([])
  })

  it('handles leaving the document entirely', () => {
    const d = diffHoverChain(['btn', 'body'], [])
    expect(d.left).toEqual(['btn', 'body'])
    expect(d.entered).toEqual([])
  })

  it('shares no ancestors across disjoint chains', () => {
    const d = diffHoverChain(['a'], ['b'])
    expect(d.left).toEqual(['a'])
    expect(d.entered).toEqual(['b'])
    expect(d.common).toEqual([])
  })

  it('honours a custom equality so identity is not required', () => {
    const prev = [{ id: 1 }, { id: 2 }]
    const next = [{ id: 2 }]
    const d = diffHoverChain(prev, next, (a, b) => a.id === b.id)
    expect(d.left).toEqual([{ id: 1 }])
    expect(d.entered).toEqual([])
    expect(d.common).toEqual([{ id: 2 }])
  })
})

describe('chainChanged', () => {
  it('is false for identical chains', () => {
    expect(chainChanged(['a', 'b'], ['a', 'b'])).toBe(false)
  })

  it('is true when depth differs', () => {
    expect(chainChanged(['a', 'b'], ['a'])).toBe(true)
  })

  it('is true when the innermost target differs at equal depth', () => {
    expect(chainChanged(['a', 'c'], ['b', 'c'])).toBe(true)
  })
})
