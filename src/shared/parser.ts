import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import type { PageContent } from './types'

interface RawPage {
  title: string
  url: string
  html: string
  siteRule?: boolean
  images?: string[]
}

import { SITE_RULES } from './site-rules'
export { SITE_RULES } from './site-rules'

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  // Reason: GFM plugin adds table, strikethrough, and task list support
  td.use(gfm)
  // Reason: ARIA role="heading" is used by some SPAs instead of native h1-h6
  td.addRule('ariaHeading', {
    filter: (node) => node.getAttribute?.('role') === 'heading',
    replacement: (content, node) => {
      const level = Number((node as HTMLElement).getAttribute('aria-level') || '2')
      return '\n' + '#'.repeat(level) + ' ' + content.trim() + '\n\n'
    },
  })
  // Reason: some editors use data-src or data-original for lazy-loaded images
  td.addRule('lazyImage', {
    filter: (node) => {
      if (node.nodeName !== 'IMG') return false
      const src = node.getAttribute('src') || ''
      return !src || src.startsWith('data:image/svg') || src === 'about:blank'
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const src = el.getAttribute('data-src')
        || el.getAttribute('data-original')
        || el.getAttribute('data-origin')
        || ''
      if (!src) return ''
      const alt = el.getAttribute('alt') || ''
      return `![${alt}](${src})`
    },
  })
  return td
}

function extractWithTurndown(doc: Document, selector: string, raw: RawPage): PageContent | null {
  const container = doc.querySelector(selector)
  if (!container) return null

  // Remove noise from inside the container before converting
  const noise = ['script', 'style', 'noscript', 'iframe']
  for (const sel of noise) {
    container.querySelectorAll(sel).forEach(el => el.remove())
  }

  const td = createTurndown()
  const markdown = td.turndown(container.innerHTML)
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!markdown) return null
  return { title: raw.title, url: raw.url, content: markdown }
}

export function parsePageContent(raw: RawPage): PageContent {
  const doc = new DOMParser().parseFromString(raw.html, 'text/html')

  // Reason: when siteRule is true, the HTML is already the container's innerHTML
  // extracted directly from the live DOM — just run Turndown on the whole thing
  if (raw.siteRule) {
    console.log(`[Parser] site rule pre-extracted, ${raw.html.length} chars HTML`)
    const td = createTurndown()
    const markdown = td.turndown(raw.html).replace(/\n{3,}/g, '\n\n').trim()
    console.log(`[Parser] Turndown output: ${markdown.length} chars`)
    console.log(`[Parser] first 500 chars:\n${markdown.slice(0, 500)}`)
    if (markdown) {
      return { title: raw.title, url: raw.url, content: markdown, images: raw.images }
    }
    console.warn(`[Parser] Turndown returned empty, falling back to Readability`)
  }

  // Try site-specific rules via DOMParser (fallback if service worker didn't pre-extract)
  const rule = SITE_RULES.find(r => r.match(raw.url))
  if (rule) {
    console.log(`[Parser] site rule matched for ${raw.url}, selector: "${rule.selector}"`)
    const result = extractWithTurndown(doc, rule.selector, raw)
    if (result) {
      console.log(`[Parser] Turndown output: ${result.content.length} chars`)
      console.log(`[Parser] first 500 chars:\n${result.content.slice(0, 500)}`)
      return result
    }
    console.warn(`[Parser] Turndown via DOMParser returned null, falling back to Readability`)
  } else if (!raw.siteRule) {
    console.log(`[Parser] no site rule for ${raw.url}, using Readability`)
  }

  // Readability for general pages
  const reader = new Readability(doc)
  const article = reader.parse()

  if (article?.textContent) {
    return {
      title: article.title || raw.title,
      url: raw.url,
      content: article.textContent.replace(/\n{3,}/g, '\n\n').trim(),
    }
  }

  // Reason: Readability fails on some pages (SPAs, minimal markup) — fall back to body text
  const clone = doc.cloneNode(true) as Document
  const noiseTags = ['script', 'style', 'nav', 'footer', 'aside', 'iframe', 'noscript']
  for (const sel of noiseTags) {
    clone.querySelectorAll(sel).forEach(el => el.remove())
  }
  const main = clone.querySelector('article') || clone.querySelector('main') || clone.body
  const text = main?.textContent?.replace(/\n{3,}/g, '\n\n').trim() || ''

  return { title: raw.title, url: raw.url, content: text }
}
