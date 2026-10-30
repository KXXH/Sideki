import { describe, expect, it } from 'vitest'
import {
  buildHtmlPreviewUrl,
  buildVfsPreviewLink,
  parseVfsPreviewLink,
  readHtmlPreviewNetwork,
  validateHtmlArtifact,
} from '../../src/shared/html-artifact'

describe('HTML artifact capability contract', () => {
  it('accepts complete documents and fragments under the same contract', () => {
    for (const html of [
      '<!doctype html><html lang="zh"><head><meta charset="UTF-8"><title>Report</title><style>p{color:var(--seed-fg)}</style></head><body><p>Hello</p><script>console.log("ok")</script></body></html>',
      '<style>.x{color:var(--seed-fg)}</style><div class="x">Hello</div><script>console.log("ok")</script>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="p"/></defs><use xlink:href="#p"/></svg>',
    ]) expect(() => validateHtmlArtifact(html)).not.toThrow()
  })

  it('accepts local controls, fragment navigation and embedded data resources', () => {
    expect(() => validateHtmlArtifact([
      '<form><input><button type="button">Update</button></form>',
      '<a href="#details">Details</a><div id="details"></div>',
      '<img src="data:image/png;base64,AAA"><img src="blob:chrome-extension://example/id">',
      '<video src="data:video/mp4;base64,AAA"></video>',
      '<style>.x {background:url("data:image/svg+xml;base64,AAA");mask:url(#shape)}</style>',
    ].join('\n'))).not.toThrow()
  })

  it.each(['iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'portal'])(
    'rejects embedded document or origin-changing tag %s in both modes', tag => {
      for (const network of [false, true]) expect(() => validateHtmlArtifact(`<${tag}></${tag}>`, { network })).toThrow(/embedded documents/)
    },
  )

  it('rejects meta http-equiv, submissions and outward links in both modes', () => {
    const cases = [
      '<meta http-equiv="refresh" content="0;url=https://example.com">',
      '<meta HTTP-EQUIV="Content-Security-Policy" content="default-src *">',
      '<form action="https://example.com"><button>Send</button></form>',
      '<button formaction="">Send</button>',
      '<a href="https://example.com">Go</a>',
      '<a href="/viz/another.html">Go</a>',
      '<area href="javascript:alert(1)">',
    ]
    for (const network of [false, true]) for (const html of cases) {
      expect(() => validateHtmlArtifact(html, { network }), html).toThrow()
    }
  })

  it('rejects relative and VFS resources on every surface', () => {
    const cases = [
      '<img src="./image.png">', '<img src="/tmp/image.png">', '<img src="/viz/image.png">',
      '<script src="./app.js"></script>', '<link rel="stylesheet" href="styles.css">',
      '<style>.a{background:url(/page/image.png)}</style>',
      '<div style="background:url(../image.png)"></div>',
      '<style>@import "./styles.css";</style>',
      '<source srcset="https://example.com/ok.png 1x, ./bad.png 2x">',
    ]
    for (const network of [false, true]) for (const html of cases) {
      expect(() => validateHtmlArtifact(html, { network }), html).toThrow()
    }
  })

  it('keeps offline content off the network and accepts HTTPS only when enabled', () => {
    for (const html of [
      '<img src="https://example.com/a.png">',
      '<script src="https://example.com/app.js"></script>',
      '<link rel="stylesheet" href="https://example.com/style.css">',
      '<style>.a{background:url(https://example.com/a.png)}@import "https://example.com/style.css";</style>',
      '<img srcset="https://example.com/a.png 1x, https://example.com/b.png 2x">',
    ]) {
      expect(() => validateHtmlArtifact(html), html).toThrow()
      expect(() => validateHtmlArtifact(html, { network: true }), html).not.toThrow()
    }
    for (const url of ['http://example.com/x', '//example.com/x', 'chrome-extension://abc/file', 'javascript:alert(1)']) {
      expect(() => validateHtmlArtifact(`<img src="${url}">`, { network: true })).toThrow()
    }
  })

  it('checks every resource, including resources after a valid first script or stylesheet', () => {
    for (const html of [
      '<script src="https://example.com/ok.js"></script><script src="http://example.com/bad.js"></script>',
      '<link rel="stylesheet" href="https://example.com/ok.css"><link rel="stylesheet" href="/tmp/bad.css">',
      '<img src="data:image/png;base64,AAA"><img src="/tmp/bad.png">',
      '<img srcset="data:image/png;base64,AAA 1x, ./bad.png 2x">',
    ]) expect(() => validateHtmlArtifact(html, { network: true }), html).toThrow()
  })

  it('does not mistake script text, comments, CSS strings or data attributes for resource markup', () => {
    const html = [
      '<!-- <iframe src="https://example.com"> -->',
      '<script>const sample = \'<iframe src="https://example.com">\'; const css = "url(https://example.com)"; fetch("https://example.com");</script>',
      '<style>/* url(https://example.com/comment.png) */ .a::after{content:"url(https://example.com/text.png)"}</style>',
      '<div data-src="https://example.com/not-a-resource" data-href="/tmp/file"></div>',
      '<textarea><iframe src="/tmp/example.html"></textarea>',
      '<title>Example <object> tag</title>',
    ].join('\n')
    expect(() => validateHtmlArtifact(html)).not.toThrow()
  })

  it('handles quoted greater-than characters, unquoted attributes and encoded URL schemes', () => {
    expect(() => validateHtmlArtifact('<img alt=">" src=/tmp/image.png>')).toThrow(/Relative and VFS/)
    expect(() => validateHtmlArtifact('<img src="https&#58;//example.com/x">')).toThrow(/external resource/)
    expect(() => validateHtmlArtifact('<img src="https&#58;//example.com/x">', { network: true })).not.toThrow()
    expect(() => validateHtmlArtifact('<a href="&#x6a;avascript:alert(1)">Go</a>', { network: true })).toThrow(/navigation/)
  })

  it('rejects empty HTML and does not add an independent file size limit', () => {
    expect(() => validateHtmlArtifact(' \n\t')).toThrow(/empty/)
    expect(() => validateHtmlArtifact(`<div>${'a'.repeat(300_000)}</div>`)).not.toThrow()
  })
})

describe('HTML artifact preview URLs', () => {
  it.each([
    ['network=1', true], ['network=0', false], ['', false], ['network=', false],
    ['network=true', false], ['network=01', false], ['network=2', false],
    ['network=1&network=0', false], ['network=1&network=1', false],
  ])('uses only the explicit unambiguous URL opt-in (%s)', (query, expected) => {
    expect(readHtmlPreviewNetwork(new URLSearchParams(query))).toBe(expected)
  })

  it('separates VFS identity from query and fragments and decodes encoded filenames once', () => {
    expect(parseVfsPreviewLink('/viz/report.html?network=1')).toEqual({ path: '/viz/report.html', network: true })
    expect(parseVfsPreviewLink('/viz/report.html?network=true#section')).toEqual({ path: '/viz/report.html', network: false })
    expect(parseVfsPreviewLink('/viz/report.html#section?network=1')).toEqual({ path: '/viz/report.html', network: false })
    const href = buildVfsPreviewLink('/viz/营收 & 利润.html', true)
    expect(parseVfsPreviewLink(href)).toEqual({ path: '/viz/营收 & 利润.html', network: true })
    expect(parseVfsPreviewLink('/tmp/data%2520file.html?network=1')?.path).toBe('/tmp/data%20file.html')
  })

  it.each(['/notes/report.html?network=1', 'https://example.com/viz/report.html', '/viz/../notes/a.html', '/viz/%2e%2e/notes/a.html', '/viz/%00.html', '/viz/bad%file.html'])(
    'rejects non-VFS, traversal and malformed links (%s)', href => {
      expect(parseVfsPreviewLink(href)).toBeNull()
    },
  )

  it('encodes session and file identity and preserves the explicit offline or online mode', () => {
    for (const network of [true, false]) {
      const url = new URL(buildHtmlPreviewUrl('chrome-extension://id/src/preview/index.html', 'session & /', '/viz/营收 #1.html', network))
      expect(url.searchParams.get('session')).toBe('session & /')
      expect(url.searchParams.get('file')).toBe('/viz/营收 #1.html')
      expect(url.searchParams.get('network')).toBe(network ? '1' : '0')
    }
  })

  it('does not inherit a network grant from a reusable base URL', () => {
    const url = new URL(buildHtmlPreviewUrl('chrome-extension://id/src/preview/index.html?network=1&other=keep', 's', '/tmp/a.html'))
    expect(url.searchParams.has('network')).toBe(false)
    expect(url.searchParams.get('other')).toBe('keep')
  })
})
