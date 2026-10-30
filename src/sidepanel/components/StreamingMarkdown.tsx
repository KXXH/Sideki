import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, type ReactNode, type HTMLAttributes, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import { Streamdown, useIsCodeFenceIncomplete, type AnimateOptions, type Components } from 'streamdown'
import { createMathPlugin } from '@streamdown/math'
import { cjk } from '@streamdown/cjk'
import 'katex/dist/katex.min.css'
import 'streamdown/styles.css'
import { Icon } from '@iconify/react'
import { iconCopy, iconCheck } from '../../shared/icons'
import { requestHighlight } from '../code-highlight'
import type { ApiConfig } from '../../shared/types'
import { buildHtmlPreviewUrl, parseVfsPreviewLink } from '../../shared/html-artifact'

const mathDefault = createMathPlugin({ singleDollarTextMath: false })
const mathSingleDollar = createMathPlugin({ singleDollarTextMath: true })

// Reason: tokens can end inside English words or unspaced CJK text. Fade new
// characters as they arrive; staggered words build a second playback queue that
// can keep animating old paragraphs long after newer text has been rendered.
const streamingAnimation: AnimateOptions = {
  animation: 'fadeIn',
  duration: 180,
  easing: 'ease-out',
  sep: 'char',
  stagger: 0,
  maxBacklogMs: 0,
}

interface Props {
  content: string
  isStreaming: boolean
  sessionId?: string
}

// Reason: custom components let every markdown element use the Sidekick
// design tokens (surface layers, accent wash/glow, border grades) instead
// of generic prose styles. The content should feel native to the interface.

function Heading({ level, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; children: ReactNode }) {
  if (level === 1) return (
    <h1 className="mt-4 mb-3.5 text-[1.5em] font-semibold leading-[1.45] tracking-normal text-text-primary">
      {children}
    </h1>
  )
  if (level === 2) return (
    <h2 className="mt-7 mb-2 text-[1.3em] font-semibold leading-[1.45] tracking-normal text-text-primary">
      {children}
    </h2>
  )
  if (level === 3) return (
    <h3 className="mt-6 mb-1.5 text-[1.15em] font-semibold leading-[1.5] tracking-normal text-text-primary">
      {children}
    </h3>
  )
  if (level === 4) return (
    <h4 className="mt-5 mb-1.25 text-[1em] font-semibold leading-[1.5] tracking-normal text-text-primary">
      {children}
    </h4>
  )
  if (level === 5) return (
    <h5 className="mt-3.5 mb-1.25 text-[1em] font-medium leading-[1.5] tracking-normal text-text-primary">
      {children}
    </h5>
  )
  return (
    <h6 className="mt-3 mb-1.25 text-[1em] font-medium leading-[1.5] tracking-normal text-text-secondary">
      {children}
    </h6>
  )
}

function CodeBlock({ children, className }: HTMLAttributes<HTMLElement>) {
  const [copied, setCopied] = useState(false)
  const lang = className?.replace('language-', '') || ''
  const code = String(children).replace(/\n$/, '')
  const incomplete = useIsCodeFenceIncomplete()
  const wrapRef = useRef<HTMLDivElement>(null)

  // Reason: highlighting a half-streamed fence produces wrong scopes, and the
  // ranges would be invalidated by the next token anyway.
  useEffect(() => {
    if (incomplete || !lang || !wrapRef.current) return
    requestHighlight(wrapRef.current)
  }, [incomplete, lang, code])

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div ref={wrapRef} className="my-2.5 overflow-hidden rounded-lg border border-white/[0.06]">
      <div className="flex items-center justify-between bg-surface-overlay/70 backdrop-blur-[var(--theme-blur)] backdrop-saturate-[1.4] px-3 py-1">
        <span className="font-mono text-[10px] text-text-muted">{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-surface-raised/60 hover:text-text-secondary"
        >
          <Icon icon={copied ? iconCheck : iconCopy} className="text-xs" />
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-surface-raised/50 p-3">
        {/* Reason: microlighter needs the language-* class to pick a grammar, and it
            skips any <code> whose firstChild is not a lone text node — so this must
            stay a single string child. */}
        <code className={`language-${lang} font-mono text-xs leading-relaxed text-text-secondary`}>{code}</code>
      </pre>
    </div>
  )
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-sm bg-accent-wash px-1.5 py-0.5 font-mono text-[11.5px] text-accent">
      {children}
    </code>
  )
}

function TableWrapper({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showFade, setShowFade] = useState(false)

  const syncFade = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setShowFade(
      el.scrollWidth > el.clientWidth + 1
      && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    )
  }, [])

  // Reason: column widths change while a table streams, so the overflow state
  // must be re-measured after every render, not just on mount.
  useLayoutEffect(syncFade, [children, syncFade])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(syncFade)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    el.addEventListener('scroll', syncFade, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', syncFade)
    }
  }, [syncFade])

  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-white/[0.06]">
      <div
        ref={scrollRef}
        className="overflow-x-auto overscroll-x-contain"
        style={showFade ? {
          maskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent)',
        } : undefined}
      >
        <table className="min-w-full text-[12px]">{children}</table>
      </div>
    </div>
  )
}

function Blockquote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="my-2.5 border-l-2 border-text-primary bg-surface-overlay px-3 py-2 text-text-secondary [&>p]:my-0 [&>p+p]:mt-2">
      {children}
    </blockquote>
  )
}

type MarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }

function MarkdownLink({ href, children, node, className, onClick, ...props }: MarkdownLinkProps) {
  void node
  const isAnchor = !!href && href.startsWith('#')
  const handleAnchorClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (!href) return
    let id = href.slice(1)
    try { id = decodeURIComponent(id) } catch { /* keep raw id */ }
    if (!id) return
    const container = event.currentTarget.closest('.markdown-content')
    const target = container?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (target.tabIndex >= 0) target.focus({ preventScroll: true })
  }
  return (
    <a
      {...props}
      href={href}
      target={isAnchor ? undefined : '_blank'}
      rel={isAnchor ? undefined : 'noopener noreferrer'}
      onClick={isAnchor ? handleAnchorClick : onClick}
      className={['text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent', className].filter(Boolean).join(' ')}
    >
      {children}
    </a>
  )
}

const components: Components = {
  h1: ({ children }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children, id, className }) => className?.includes('sr-only')
    ? <h2 id={id} className="sr-only">{children}</h2>
    : <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  h5: ({ children }) => <Heading level={5}>{children}</Heading>,
  h6: ({ children }) => <Heading level={6}>{children}</Heading>,
  p: ({ children }) => <p className="my-1.5 leading-[1.7]">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 space-y-0.5 pl-0 list-none">{children}</ul>,
  // Reason: native start must reach both the semantic list and our custom
  // counter. Each nested list owns its reset so its siblings can resume theirs.
  ol: ({ children, start }) => (
    <ol start={start} style={{ counterReset: `item ${(start ?? 1) - 1}` }} className="my-1.5 space-y-0.5 pl-0 list-none">{children}</ol>
  ),
  // Reason: the marker is a fixed column shared by ul and ol, so nested lists
  // and numbered lists all start their text on the same vertical line. Task
  // items own the checkbox marker instead and hide this column in CSS.
  li: ({ children, id }) => (
    <li id={id} className="flex items-start gap-1.5 leading-[1.65] [&_p]:my-0">
      <span aria-hidden className="sk-md-list-marker shrink-0" />
      <span className="min-w-0 flex-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{children}</span>
    </li>
  ),
  code: ({ children, className }) => <CodeBlock className={className}>{children}</CodeBlock>,
  inlineCode: ({ children }) => <InlineCode>{children}</InlineCode>,
  blockquote: ({ children }) => <Blockquote>{children}</Blockquote>,
  table: ({ children }) => <TableWrapper>{children}</TableWrapper>,
  thead: ({ children }) => <thead className="bg-surface-raised">{children}</thead>,
  th: ({ children }) => (
    <th className="min-w-[72px] whitespace-nowrap border-b border-border-subtle px-3 py-1.5 text-left text-[11px] font-semibold text-text-muted">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="min-w-[72px] border-b border-border-muted/50 px-3 py-1.5 text-text-secondary">
      {children}
    </td>
  ),
  tr: ({ children, ...props }) => {
    const isEven = props.node?.position ? props.node.position.start.line % 2 === 0 : false
    return <tr className={isEven ? 'bg-surface-raised/30' : ''}>{children}</tr>
  },
  a: (props) => <MarkdownLink {...props} />,
  hr: () => <hr className="my-4 border-none h-px bg-border-muted" />,
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
  em: ({ children }) => <em className="text-text-secondary">{children}</em>,
}

const PREVIEW_EXTS = new Set(['.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'])

function VfsLink({ path, sessionId, children }: { path: string; sessionId: string; children: ReactNode }) {
  const target = parseVfsPreviewLink(path)
  if (!target) return <span>{children}</span>
  const filePath = target.path
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const canPreview = PREVIEW_EXTS.has(ext)

  const handleClick = async () => {
    if (canPreview) {
      const url = buildHtmlPreviewUrl(chrome.runtime.getURL('src/preview/index.html'), sessionId, filePath, target.network)
      chrome.tabs.create({ url })
      return
    }
    // Reason: opening a preview tab navigates the active page, which clears /page/.
    // Non-visual files download directly via dev:cat to avoid that.
    const resp = await chrome.runtime.sendMessage({
      type: 'dev:cat', sessionId, path: filePath,
    }) as { success: boolean; content?: string } | undefined
    if (!resp?.success || resp.content == null) return
    const blob = new Blob([resp.content], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filePath.split('/').pop() || 'file'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent-wash/50 px-1.5 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent-wash hover:border-accent/50"
    >
      <span className="text-[10px]">{canPreview ? '↗' : '↓'}</span>
      {children}
    </button>
  )
}

export default function StreamingMarkdown({ content, isStreaming, sessionId }: Props) {
  const [singleDollar, setSingleDollar] = useState(false)
  useEffect(() => {
    chrome.storage.local.get('sidekick_config').then(r => {
      const cfg = r.sidekick_config as ApiConfig | undefined
      if (cfg?.labSingleDollarMath) setSingleDollar(true)
    })
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.sidekick_config?.newValue) {
        setSingleDollar(!!(changes.sidekick_config.newValue as ApiConfig).labSingleDollarMath)
      }
    }
    chrome.storage.local.onChanged.addListener(onChange)
    return () => chrome.storage.local.onChanged.removeListener(onChange)
  }, [])

  const math = singleDollar ? mathSingleDollar : mathDefault

  const mergedComponents = useMemo<Components>(() => {
    if (!sessionId) return components
    return {
      ...components,
      a: (props) => {
        if (props.href && parseVfsPreviewLink(props.href)) {
          return <VfsLink path={props.href} sessionId={sessionId}>{props.children}</VfsLink>
        }
        return <MarkdownLink {...props} />
      },
    }
  }, [sessionId])

  return (
    <div className="markdown-content overflow-hidden px-0 py-3 select-text" style={{ fontFamily: 'var(--font-content)', fontSize: 'var(--font-content-size)' }}>
      <Streamdown animated={streamingAnimation} isAnimating={isStreaming} plugins={{ math, cjk }} components={mergedComponents}>{content}</Streamdown>
    </div>
  )
}
