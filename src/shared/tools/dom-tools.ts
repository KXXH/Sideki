import { tool } from 'ai'
import { z } from 'zod'
import { sendToolMessage } from './bridge'
import type { ToolCallCtx } from './bridge'

const targetDesc = 'Target element: [N] index from dom snapshot (e.g. "[3]"), CSS selector (e.g. "#id", ".class"), visible text (e.g. "Submit"), or aria-label. Prefer [N] index after running dom for reliable targeting.'

function navSuffix(result: Record<string, unknown>): string {
  return result.navigatedTo ? ` → navigated to: ${result.navigatedTo}` : ''
}

// Reason: the handlers report what the action actually did, but each tool builds
// its own result string — without this the fields exist and the model never sees
// them. Occlusion comes first: "a banner took the event" tells the model what to
// do next, while "no observable change" only tells it to guess.
function outcomeSuffix(result: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof result.occludedBy === 'string') {
    parts.push(`the point was covered by ${result.occludedBy}, which received the event instead of the target`)
  }
  if (typeof result.observed === 'string') parts.push(result.observed)
  return parts.length ? ` [${parts.join('; ')}]` : ''
}

// Reason: factories — each agent gets tools bound to its own session/tab
// context so concurrent kernels never cross-wire (module-level tool
// singletons remain the no-ctx panel variant via tools/index.ts).
export function makeDomTools(ctx?: ToolCallCtx) {
  const clickTool = tool({
    description: 'Click on an element on the page. Use real=true for links that open new tabs/popups (simulates a real mouse click via debugger).',
    inputSchema: z.object({
      target: z.string().describe(targetDesc),
      doubleClick: z.boolean().optional().default(false).describe('Whether to double-click'),
      real: z.boolean().optional().default(false).describe('Use real mouse event via debugger (needed for popup links, bypasses popup blocker)'),
    }),
    execute: async ({ target, doubleClick, real }, { abortSignal }) => {
      const result = await sendToolMessage('click', { target, doubleClick, real }, abortSignal, ctx)
      if (!result.success) return `Error: ${result.error}`
      return `Clicked ${doubleClick ? '(double) ' : ''}${real ? '(real) ' : ''}element: ${target}${navSuffix(result)}${outcomeSuffix(result)}`
    },
  })

  const hoverTool = tool({
    description: 'Hover over an element to trigger hover effects, tooltips, or dropdown menus',
    inputSchema: z.object({
      target: z.string().describe(targetDesc),
    }),
    execute: async ({ target }, { abortSignal }) => {
      const result = await sendToolMessage('hover', { target }, abortSignal, ctx)
      if (!result.success) return `Error: ${result.error}`
      return `Hovered over element: ${target}${outcomeSuffix(result)}`
    },
  })

  const typeTool = tool({
    description: 'Type text into an input field, textarea, or contenteditable element',
    inputSchema: z.object({
      target: z.string().describe(targetDesc),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().default(true).describe('Clear existing content first'),
    }),
    execute: async ({ target, text, clear }, { abortSignal }) => {
      const result = await sendToolMessage('type', { target, text, clear }, abortSignal, ctx)
      if (!result.success) return `Error: ${result.error}`
      return `Typed "${text.length > 50 ? text.slice(0, 50) + '...' : text}" into ${target}${navSuffix(result)}${outcomeSuffix(result)}`
    },
  })

  const selectTool = tool({
    description: 'Select an option from a <select> dropdown element',
    inputSchema: z.object({
      target: z.string().describe(targetDesc),
      value: z.string().describe('The option value to select'),
    }),
    execute: async ({ target, value }, { abortSignal }) => {
      const result = await sendToolMessage('select', { target, value }, abortSignal, ctx)
      if (!result.success) return `Error: ${result.error}`
      return `Selected "${value}" in ${target}${navSuffix(result)}`
    },
  })

  const keypressTool = tool({
    description: 'Dispatch a keyboard event on the page or a specific element. Key names: Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace, Delete, etc.',
    inputSchema: z.object({
      key: z.string().describe('Key name (e.g. "Enter", "Escape", "Tab", "ArrowDown")'),
      target: z.string().optional().describe('Target element (defaults to page body). ' + targetDesc),
      ctrlKey: z.boolean().optional().default(false),
      shiftKey: z.boolean().optional().default(false),
      altKey: z.boolean().optional().default(false),
      metaKey: z.boolean().optional().default(false),
    }),
    execute: async ({ key, target, ctrlKey, shiftKey, altKey, metaKey }, { abortSignal }) => {
      const result = await sendToolMessage('keypress', {
        key, target, ctrlKey, shiftKey, altKey, metaKey,
      }, abortSignal, ctx)
      if (!result.success) return `Error: ${result.error}`
      const mods = [ctrlKey && 'Ctrl', shiftKey && 'Shift', altKey && 'Alt', metaKey && 'Meta']
        .filter(Boolean).join('+')
      return `Pressed ${mods ? mods + '+' : ''}${key}${target ? ` on ${target}` : ''}${outcomeSuffix(result)}`
    },
  })

  return { clickTool, hoverTool, typeTool, selectTool, keypressTool }
}
