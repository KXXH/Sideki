export const HTML_ARTIFACT_CAPABILITIES = `HTML artifacts have the same capabilities in the inline canvas and new-tab preview; opening a tab changes the viewport, not permissions or APIs.
Both accept self-contained complete HTML documents or fragments, inline DOM/CSS/JavaScript/SVG, local interactive controls, and the same host theme tokens/classes. Scripts run after the content is mounted: initialize directly instead of waiting for DOMContentLoaded/load or relying on a fresh browser navigation lifecycle. Keep all dependencies inline or use data:/blob: resources; relative paths, other VFS files and local modules are unavailable on both surfaces.
Offline is the default: no network requests or remote dependencies. Declare network: true in visualize, or add ?network=1 to the HTML VFS link for an independent new-tab preview, to allow HTTPS resources/fetch and WSS sockets. The preview URL is the only source of its network mode: missing, invalid or duplicated network values mean offline; network=0 is explicitly offline. Online mode still has an opaque origin, no inherited login identity, and normal CORS restrictions; authenticated services may fail. Use HTTPS CDN scripts/styles only in online mode.
Neither surface exposes Chrome APIs, Node.js, the host page DOM, the user's browser login context, or a callback to the agent. Nested documents (iframe/object/embed), external navigation, form submission, document.write, eval and Function compilation are unavailable. Use #fragment links for in-document navigation. Theme, permissions and resource rules remain the same when switching surfaces; responsive layout may change with viewport size.`

export interface HtmlArtifactOptions {
  network?: boolean
}

export function readHtmlPreviewNetwork(params: URLSearchParams): boolean {
  const values = params.getAll('network')
  return values.length === 1 && values[0] === '1'
}

export interface VfsPreviewLink {
  path: string
  network: boolean
}

export function parseVfsPreviewLink(href: string): VfsPreviewLink | null {
  const [target] = href.split('#', 1)
  const queryIndex = target.indexOf('?')
  const rawPath = queryIndex < 0 ? target : target.slice(0, queryIndex)
  try {
    const path = decodeURIComponent(rawPath)
    if (!/^\/(tmp|page|viz)\/.+/.test(path) || path.split('/').includes('..') || /[?#]/.test(path) || path.includes('\0')) return null
    const params = new URLSearchParams(queryIndex < 0 ? '' : target.slice(queryIndex + 1))
    return { path, network: readHtmlPreviewNetwork(params) }
  } catch {
    return null
  }
}

export function buildVfsPreviewLink(path: string, network = false): string {
  const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `${encodedPath}?network=${network ? '1' : '0'}`
}

export function buildHtmlPreviewUrl(baseUrl: string, sessionId: string, path: string, network?: boolean): string {
  const url = new URL(baseUrl)
  url.searchParams.set('session', sessionId)
  url.searchParams.set('file', path)
  if (network === undefined) url.searchParams.delete('network')
  else url.searchParams.set('network', network ? '1' : '0')
  return url.toString()
}

const BLOCKED_TAGS = new Set(['iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'applet', 'portal'])
const RESOURCE_ATTRIBUTES = new Set(['src', 'poster', 'href', 'xlink:href', 'background', 'lowsrc', 'dynsrc'])
const SUBMISSION_ATTRIBUTES = new Set(['action', 'formaction'])
const TAG_RE = /<!--[^]*?-->|<\s*(\/?)([a-z][\w:-]*)(?:(?:"[^"]*"|'[^']*'|[^'">]))*>/gi
const ATTRIBUTE_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function fail(message: string): never {
  throw new Error(`HTML preview: ${message}`)
}

function shown(value: string): string {
  return value.length > 100 ? `${value.slice(0, 100)}…` : value
}

function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|amp|quot|apos|colon|tab|newline);?/gi, (entity, numeric: string | undefined) => {
    if (numeric) {
      const code = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    switch (entity.toLowerCase().replace(/;$/, '')) {
      case '&amp': return '&'
      case '&quot': return '"'
      case '&apos': return "'"
      case '&colon': return ':'
      case '&tab': return '\t'
      case '&newline': return '\n'
      default: return entity
    }
  })
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>()
  const body = tag.replace(/^<\s*[a-z][\w:-]*/i, '').replace(/\/?>$/, '')
  const re = new RegExp(ATTRIBUTE_RE)
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    const name = match[1].toLowerCase()
    // Reason: HTML parsing keeps the first duplicate attribute, so validation follows the same value.
    if (!result.has(name)) result.set(name, decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''))
  }
  return result
}

function validateResource(value: string, label: string, network: boolean): void {
  const url = value.trim()
  if (!url || url.startsWith('#') || /^(?:data|blob):/i.test(url)) return
  if (network && /^https:\/\//i.test(url)) return
  if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
    fail(network
      ? `${label}="${shown(value)}" is not allowed. Networked HTML may only load https:// resources.`
      : `external resource URL ${label}="${shown(value)}" is not allowed offline. Inline the resource or use data:/blob:, or declare network: true for HTTPS resources.`)
  }
  fail(`${label}="${shown(value)}" is not supported. Relative and VFS resource URLs are unavailable in both canvas and new-tab preview; inline the resource, use data:/blob:, or use https:// with network: true.`)
}

function validateSrcset(value: string, label: string, network: boolean): void {
  // Reason: commas can be part of a data URL; a candidate URL ends at whitespace, not its first comma.
  let rest = value.trim()
  while (rest) {
    rest = rest.replace(/^[\s,]+/, '')
    if (!rest) return
    const token = rest.match(/^\S+/)?.[0] ?? ''
    if (!token) return
    const dataUrl = /^data:/i.test(token)
    const url = dataUrl ? token.replace(/,+$/, '') : token.split(',')[0]
    validateResource(url, label, network)
    if (!dataUrl && token.includes(',')) {
      rest = rest.slice(url.length + 1)
      continue
    }
    rest = rest.slice(token.length)
    const comma = rest.indexOf(',')
    if (comma < 0) return
    rest = rest.slice(comma + 1)
  }
}

function validateCss(css: string, network: boolean): void {
  // Reason: strings/comments must be consumed before URL tokens so literal examples do not become resource requests.
  const tokens = /\/\*[^]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)|@import\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi
  let match: RegExpExecArray | null
  while ((match = tokens.exec(css)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
    if (value === undefined) continue
    validateResource(value.trim(), 'CSS url()/@import', network)
  }
}

// Reason: this DOM-free preflight gives every authoring surface the same actionable errors.
// It is not a complete HTML/CSS security parser; the sandbox sanitizer and browser CSP enforce execution boundaries.
export function validateHtmlArtifact(html: string, options: HtmlArtifactOptions = {}): void {
  if (!html.trim()) fail('the file is empty. Write self-contained HTML before rendering it.')
  const network = options.network === true
  const tags = new RegExp(TAG_RE)
  let match: RegExpExecArray | null
  while ((match = tags.exec(html)) !== null) {
    if (!match[2] || match[1]) continue
    const tag = match[2].toLowerCase()
    if (BLOCKED_TAGS.has(tag)) {
      fail('<iframe>, <object>, <embed>, frames, <base> and embedded documents are not allowed. Draw the content inline.')
    }
    const attrs = attributes(match[0])
    if (tag === 'meta' && attrs.has('http-equiv')) fail('<meta http-equiv> is not allowed; the host controls CSP and navigation.')
    for (const name of SUBMISSION_ATTRIBUTES) {
      if (attrs.has(name)) fail('form submission is unavailable in both canvas and new-tab preview. Keep interactions local and remove action/formaction.')
    }
    if ((tag === 'a' || tag === 'area') && ['href', 'xlink:href'].some(name => {
      const value = attrs.get(name)
      return value !== undefined && value.trim() !== '' && !value.trim().startsWith('#')
    })) fail('external navigation and VFS links are unavailable inside rendered HTML. Only #fragment links are supported.')
    if (tag === 'script' && attrs.has('src')) {
      const src = attrs.get('src')!.trim()
      if (!network) fail('external scripts are not allowed offline. Inline the JavaScript, or declare network: true for an HTTPS script.')
      if (!/^https:\/\//i.test(src)) fail('script src must use https:// with network: true; relative/VFS, data: and blob: scripts are not supported.')
    }
    if (tag === 'link') {
      if (!network) fail('<link> elements are not allowed offline. Inline styles in <style>, or declare network: true for an HTTPS stylesheet.')
      const href = attrs.get('href')
      if (href !== undefined && !/^https:\/\//i.test(href.trim())) fail('link href must use https:// with network: true; relative/VFS stylesheets are not supported.')
    }
    for (const [name, value] of attrs) {
      if (RESOURCE_ATTRIBUTES.has(name)) validateResource(value, name, network)
      else if (name === 'srcset' || name === 'imagesrcset') validateSrcset(value, name, network)
      else if (name === 'style') validateCss(value, network)
    }
    if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'title') {
      const close = new RegExp(`<\\/\\s*${tag}\\s*>`, 'gi')
      close.lastIndex = tags.lastIndex
      const closing = close.exec(html)
      const end = closing?.index ?? html.length
      if (tag === 'style') validateCss(html.slice(tags.lastIndex, end), network)
      // Reason: script raw text may contain HTML/CSS-looking strings that the browser does not parse as markup.
      tags.lastIndex = closing ? close.lastIndex : html.length
    }
  }
}
