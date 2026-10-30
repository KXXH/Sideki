import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const bodyOf = (html: string) => html.slice(html.indexOf('</head>'))

describe('viz sandbox pages', () => {
  it('ships an offline page whose meta policy forbids network access', () => {
    const offline = read('src/viz/sandbox.html')
    const meta = offline.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)
    expect(meta?.[1]).toContain("default-src 'none'")
    expect(meta?.[1]).toContain("script-src 'unsafe-inline'")
    expect(meta?.[1]).not.toContain('https:')
  })

  it('ships an online page without the offline meta policy', () => {
    const online = read('src/viz/sandbox-online.html')
    // The renderer mentions the selector in its mode check; only a real meta element counts.
    expect(online).not.toMatch(/<meta\s+http-equiv="Content-Security-Policy"/i)
  })

  it('keeps both pages in sync with the template', () => {
    const template = read('src/viz/sandbox.src.html')
    const offline = read('src/viz/sandbox.html')
    const online = read('src/viz/sandbox-online.html')
    expect(template).toContain('<!-- @viz-csp -->')
    expect(bodyOf(offline)).toBe(bodyOf(online))
    expect(bodyOf(template)).toBe(bodyOf(online))
  })
})
