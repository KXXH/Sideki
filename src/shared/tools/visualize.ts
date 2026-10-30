import { tool } from 'ai'
import { z } from 'zod'
import { toolDescriptionInput } from './tool-description'
import { getActiveSessionId } from './bridge'
import type { ToolCallCtx } from './bridge'
import { canProbeInThisDocument, probeVisualization, requestProbeFromUi } from '../viz-probe'
import { validateHtmlArtifact, buildVfsPreviewLink, HTML_ARTIFACT_CAPABILITIES } from '../html-artifact'

export { validateHtmlArtifact as validateVisualizationHtml } from '../html-artifact'

export const VIZ_SNAPSHOT_DIR = '/viz'

const ALLOWED_EXTENSIONS = ['.html', '.htm', '.svg']

// Reason: the tool references a VFS file instead of accepting markup. This
// keeps the tool input and message state small, avoids a second copy of the
// HTML, and gives the rendered snapshot a stable path; the source markup still
// travels through the bash call that writes the file.
export function validateSourcePath(path: string): void {
  if (!path || !path.trim()) {
    throw new Error('visualize: path is required. Write self-contained HTML first (mkdir -p /viz && cat > /viz/<name>.html <<\'HTML\' ... HTML) and pass that path.')
  }
  if (!path.startsWith('/viz/')) {
    throw new Error(`visualize: path must start with /viz/ (got "${path}"). /viz is the persistent canvas directory; write the fragment there with bash, e.g. /viz/chart.html, then pass that path. Use /tmp only for working files, and /page only for navigation-scoped data.`)
  }
  if (path.split('/').includes('..')) {
    throw new Error(`visualize: path must not contain ".." segments (got "${path}"). Use a plain path under /viz/, e.g. /viz/chart.html.`)
  }
  const lower = path.toLowerCase()
  if (!ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    throw new Error(`visualize: path must end in .html, .htm or .svg (got "${path}"). Write the HTML to e.g. /viz/chart.html and pass that path.`)
  }
}

// Reason: FNV-1a 32-bit over UTF-16 code units — cheap, dependency-free, and
// stable across sessions so an unchanged fragment always snapshots to the same
// path (content hash doubles as a cache/version key).
export function fnv1a32(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

export function basenameWithoutExt(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

// Reason: an ASCII-only slug keeps the VFS path safe on every preview surface;
// non-Latin titles fall back to the source basename, then to "viz".
export function snapshotPathFor(title: string | undefined, sourcePath: string, content: string, network = false): string {
  const slug = slugify(title ?? '') || slugify(basenameWithoutExt(sourcePath)) || 'viz'
  return `${VIZ_SNAPSHOT_DIR}/${slug}-${fnv1a32(content)}${network ? '-online' : ''}.html`
}

export function makeVisualizeTool(ctx?: ToolCallCtx) {
  return tool({
    description: `Render a self-contained HTML artifact inline in the chat. The new-tab HTML viewer has the same capabilities; changing the viewing surface does not grant more access.

${HTML_ARTIFACT_CAPABILITIES}

Write the HTML fragment or complete document under /viz/ using a quoted heredoc, then call visualize({ path: '/viz/chart.html', title?: '...', network?: true }). The tool saves a content-and-network-mode snapshot. Use the returned previewPath as the Markdown link for a new-tab preview; its ?network=1|0 preserves the declared mode. /viz is the persistent artifact directory; /tmp and /page are working directories.

The returned render report is a check by a hidden sandbox in an available UI: ok means no uncaught execution error was reported, not that the layout/data is correct; error/timeout means fix the HTML and call again; unavailable means no UI could perform the check. New-tab viewing remains independent of the chat panel.

The shared theme variables are --seed-fg, --seed-muted, --seed-primary, --border-standard, --border-subtle, --card-bg, --inset-bg, --fill-1..3, --font-sans, --font-code, --viz-series-1..6. Load the canvas skill for authoring and responsive layout guidance.`,
    inputSchema: z.object({
      description: toolDescriptionInput,
      path: z.string().describe('VFS path of the self-contained HTML document or fragment under /viz/ (write it with bash first)'),
      title: z.string().max(120).optional().describe('Optional title; also seeds the snapshot filename'),
      network: z.boolean().optional().describe('Allow https:// resources and runtime network calls in the rendered frame. Default false: fully offline. Enable only when live data or a CDN library is required.'),
    }),
    execute: async ({ path, title, network }, { toolCallId }) => {
      const sessionId = ctx?.getSessionId?.() || getActiveSessionId()
      if (!sessionId) {
        throw new Error('visualize: no active session. The tool must run inside a chat session so its virtual filesystem is available.')
      }
      validateSourcePath(path)
      const approval = ctx?.getApproval?.(toolCallId)
      if (approval) {
        const granted = await chrome.runtime.sendMessage({ type: 'approval:claim', approval, toolName: 'visualize', args: { path, title, network } })
        if (!granted?.success) throw new Error(granted?.reason ?? granted?.error ?? '调用授权已失效')
      }

      let read: { success?: boolean; content?: string; error?: string } | undefined
      try {
        read = await chrome.runtime.sendMessage({ type: 'dev:cat', sessionId, path })
      } catch (e) {
        throw new Error(`visualize: could not read ${path} from the session filesystem (${e instanceof Error ? e.message : String(e)}). Check the path and call visualize again.`, { cause: e })
      }
      if (!read?.success || typeof read.content !== 'string') {
        throw new Error(`visualize: file "${path}" was not found in this session. Write the HTML with bash first (cat > ${path} <<'HTML' ... HTML), then call visualize again.`)
      }

      const content = read.content
      const networked = network === true
      validateHtmlArtifact(content, { network: networked })

      const snapshotPath = snapshotPathFor(title, path, content, networked)
      if (snapshotPath !== path) {
        let written: { success?: boolean; error?: string } | undefined
        try {
          written = await chrome.runtime.sendMessage({ type: 'vfs:write', sessionId, path: snapshotPath, content })
        } catch (e) {
          throw new Error(`visualize: failed to save the snapshot at ${snapshotPath} (${e instanceof Error ? e.message : String(e)}). Delete stale files under /viz/ and call visualize again.`, { cause: e })
        }
        if (!written?.success) {
          throw new Error(`visualize: failed to save the snapshot at ${snapshotPath} (${written?.error ?? 'unknown error'}). Delete stale files under /viz/ and call visualize again.`)
        }
      }

      // Reason: the visible frame mounts only after this tool returns, so a
      // same-turn check has to render its own hidden copy. The kernel has no
      // usable renderer and delegates to the side panel.
      const render = canProbeInThisDocument()
        ? await probeVisualization({ sessionId, path: snapshotPath, network: networked })
        : await requestProbeFromUi({ sessionId, path: snapshotPath, network: networked })

      const canvasId = toolCallId || `path:${snapshotPath}`
      return { path: snapshotPath, previewPath: buildVfsPreviewLink(snapshotPath, networked, canvasId), canvasId, title: title ?? basenameWithoutExt(path), network: networked, render }
    },
  })
}
