import { tool } from 'ai'
import { z } from 'zod'
import { toolDescriptionInput } from './tool-description'
import { sendToolMessage } from './bridge'
import type { ToolCallCtx } from './bridge'
import { parsePageContent } from '../parser'

const targetDesc = 'Target element: CSS selector (e.g. "#id", ".class"), visible text (e.g. "Submit", "Sign up"), or aria-label. If ambiguous, the tool returns matching candidates for you to refine.'

// Reason: factories — each agent gets tools bound to its own session/tab
// context so concurrent kernels never cross-wire.
export function makePageTools(ctx?: ToolCallCtx) {
  const scrollTool = tool({
    description: 'Scroll the page or a specific element in a given direction',
    inputSchema: z.object({
      description: toolDescriptionInput,
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
      amount: z.number().optional().default(500).describe('Pixels to scroll'),
      target: z.string().optional().describe('Element to scroll (defaults to page). ' + targetDesc),
    }),
    execute: async ({ direction, amount, target }, { abortSignal, toolCallId }) => {
      const result = await sendToolMessage('scroll', { direction, amount, target }, abortSignal, ctx, toolCallId)
      if (!result.success) return `Error: ${result.error}`
      return `Scrolled ${direction} ${amount}px${target ? ` on ${target}` : ''}`
    },
  })

  const screenshotTool = tool({
    description: 'Capture a screenshot of the current visible viewport. Only the foreground tab can be photographed — if the operating tab has been switched to the background, the call fails instead of capturing the wrong page. Optionally scroll a specific element into view first.',
    inputSchema: z.object({
      description: toolDescriptionInput,
      target: z.string().optional().describe('If provided, this element is scrolled into view before capture. ' + targetDesc),
    }),
    execute: async ({ target }, { abortSignal, toolCallId }) => {
      const result = await sendToolMessage('screenshot', { target }, abortSignal, ctx, toolCallId)
      if (!result.success) return `Error: ${result.error}`
      return JSON.stringify({ message: result.message ?? 'Screenshot captured', dataUrl: result.dataUrl ?? '' })
    },
  })

  const waitTool = tool({
    description: 'Wait for an element to appear on the page, or wait for a fixed duration',
    inputSchema: z.object({
      description: toolDescriptionInput,
      target: z.string().optional().describe('Element to wait for. ' + targetDesc),
      timeout: z.number().optional().default(5000).describe('Max wait time in ms'),
      duration: z.number().optional().describe('If set, simply wait this many ms instead of waiting for an element'),
    }),
    execute: async ({ target, timeout, duration }, { abortSignal, toolCallId }) => {
      const result = await sendToolMessage('wait', { target, timeout, duration }, abortSignal, ctx, toolCallId)
      if (!result.success) return `Error: ${result.error}`
      if (duration) return `Waited ${duration}ms`
      return `Element ${target} found`
    },
  })

  const navigateTool = tool({
    description: 'Navigate the current tab to a URL. Use this instead of window.location in executeJS.',
    inputSchema: z.object({
      description: toolDescriptionInput,
      url: z.string().describe('URL to navigate to'),
    }),
    execute: async ({ url }, { abortSignal, toolCallId }) => {
      const result = await sendToolMessage('navigate', { url }, abortSignal, ctx, toolCallId)
      if (!result.success) return `Error: ${result.error}`
      // Reason: navigate reports success as soon as the navigation starts, and
      // carries a message when the load did not finish — the frame is then still
      // pending, which is exactly what makes a following wait fail.
      return typeof result.message === 'string' ? result.message : `Navigated to ${url}`
    },
  })

  const getPageContentTool = tool({
    description: 'Get the current page content (title, URL, text). Use this after navigation or when you need to read the updated page. Content comes from the frame holding the main document; any other content-bearing frames are listed so you can read one by passing its id as `frame`.',
    inputSchema: z.object({
      description: toolDescriptionInput,
      frame: z.string().optional().describe('Read one specific frame instead of the main one: a numeric frameId from the frame listing, or a CSS selector matching an iframe element'),
    }),
    execute: async ({ frame }, { abortSignal, toolCallId }) => {
      const result = await sendToolMessage('getPageContent', frame ? { frame } : {}, abortSignal, ctx, toolCallId)
      if (!result.success) return `Error: ${result.error}`
      const parsed = parsePageContent({
        title: result.title as string,
        url: result.url as string,
        html: result.html as string,
      })
      const truncated = parsed.content.length > 8000
        ? parsed.content.slice(0, 8000) + '\n\n[Content truncated]'
        : parsed.content
      // Reason: frame provenance and the sibling-frame listing let the model drill
      // into a nested document instead of silently getting only the winning frame.
      const note = result.frameNote as string | undefined
      return `Page: ${parsed.title}\nURL: ${parsed.url}\n\n${truncated}${note ? `\n\n${note}` : ''}`
    },
  })

  return { scrollTool, screenshotTool, waitTool, navigateTool, getPageContentTool }
}
