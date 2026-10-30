import { tool } from 'ai'
import { z } from 'zod'
import { toolDescriptionInput } from './tool-description'
import { sendToolMessage } from './bridge'
import type { ToolCallCtx } from './bridge'

// Reason: factory — bash carries the owning session's id so concurrent
// kernels always hit their own virtual filesystem.
export function makeBashTool(ctx?: ToolCallCtx) {
  return tool({
  description: `Virtual bash shell with persistent filesystem, browser automation, and debug commands.

Page commands:
- dom [--root=SEL] [--all] [--flat] — DOM snapshot. --flat for grep-friendly; long attribute values are clipped and end with "..." — read the full value with element-info or js
- page-content [--frame=SEL] — page HTML
- element-info "target" — element details (tag, text, attributes, position)
- find-element "text" / --selector="css" / --attr="name" "value" — search elements, outputs unique selectors
- locate "selector" [-q] [--highlight] — scroll into view + verify visibility. -q for piping
- js "code" [--frame=SEL] — execute JS (expressions + console.log captured)
- click "target" [--real] [--double] — --real for real mouse events
- type-text "target" "text" [--append] / scroll DIR [AMOUNT] / navigate "url"
- page-wait "target" [--timeout=N] / --duration=N / --idle [--timeout=N]
- screenshot [--target=SEL] — fails if the operating tab is in the background (visible-viewport capture photographs only the foreground tab)
- http-put URL [--type=MIME] [--method=POST] — byte-safe binary upload, body from stdin (e.g. cat /tmp/img.png | http-put URL --type=image/png); requires network lab. Use curl for text requests
- pdf <path> [--pages=1-20] — extract a PDF as Markdown with <!-- Page N --> markers per page (first 200 pages by default; redirect large output: pdf /tmp/x.pdf > /tmp/doc.md). Scanned PDFs have no text layer and fail — there is no OCR
- pdf open <path> [--page=N] — open the PDF in Sideki's annotation reader (new tab, for the user)
- pdf note list <path> [--page=N] [--author=ai|user] [--json] — list annotations (stored in <path>.notes.jsonl, shared with the user)
- pdf note add <path> --quote="..." --page=N [--note="..."] [--prefix="..."] [--suffix="..."] [--color=yellow|green|blue|pink] — add an annotation; --quote must be copied verbatim from that single page's pdf output (paraphrase or fabrication is rejected at write time), or omitted to read it from stdin: sed -n '120p' /tmp/doc.md | pdf note add --page=7. The quote must match exactly ONE place on the page — if it occurs several times (e.g. abstract and introduction share an opening), extend it past the differing words or pass --prefix/--suffix (verbatim text immediately before/after the quote)
- pdf note rm <path> <noteId>... — remove annotation(s); to modify one, rm it and add a new note (no in-place edit)
Pipe: find-element "Submit" | locate -q | click

Debug (Pro mode):
- debug elements "selector" — computed styles, box model, event listeners
- debug network start/stop/list/clear/headers/body — capture + inspect requests
- debug console start/stop/list/clear — console capture
- debug scripts [--filter] / debug source <id> [--col/--search/--beautify]
- debug inject "code" / debug perf — persistent JS injection, performance metrics

Chrome: chrome tabs/bookmarks/history/downloads/top-sites — use \`skill list\` for details.

Skills (use the useSkill tool to load full instructions):
- seo-audit — 检查页面 SEO 健康度
- accessibility — 无障碍检查
- performance — 页面性能分析
- chrome — Chrome 浏览器管理
Use \`skill list\` to see all available skills.

Memory (cross-session persistence):
- memory global "content" — set global memory (user prefs, max 1000 chars)
- memory site "content" — set site memory for current hostname
- memory add "content" — append a searchable note
- memory search "keyword" / memory list / memory remove <id>

Task tracking (for multi-step work):
- todo add "description" — add a task
- todo start/done/remove <id> — update task status
- todo list — show all tasks with progress

Unix: grep, sed, awk, jq, head, tail, sort, uniq, wc, find, cat, etc.
Dirs: /page/ (cleared on nav), /tmp/ (session scratch), /notes/ (session), /viz/ (persistent canvas artifacts), /skills/ (read-only), /memory/ (cross-session, read-only)`,
  inputSchema: z.object({
    description: toolDescriptionInput,
    command: z.string().describe('Bash command(s) to execute. Supports pipes, redirections, variables, loops.'),
    sessionId: z.string().optional().describe('Session ID for filesystem isolation (auto-filled by the system)'),
  }),
  execute: async ({ command, sessionId }, { abortSignal, toolCallId }) => {
    const result = await sendToolMessage('bash', { command, sessionId }, abortSignal, ctx, toolCallId)
    const stdout = (result.stdout as string) || ''
    const stderr = (result.stderr as string) || ''
    const exitCode = (result.exitCode as number) ?? 0

    if (exitCode !== 0) {
      const msg = stderr || `Command failed with exit code ${exitCode}`
      throw new Error(msg.trim())
    }
    // Reason: stderr may contain non-fatal warnings (e.g. skill validation) even on success.
    if (stderr) return (stdout || '(no output)') + '\n' + stderr.trim()
    return stdout || '(no output)'
  },
  })
}
