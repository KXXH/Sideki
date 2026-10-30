import { tool } from 'ai'
import { z } from 'zod'
import { toolDescriptionInput, withoutToolDescription } from './tool-description'
import { getActiveSessionId, peekOperatingTabId } from './bridge'
import type { ToolCallCtx } from './bridge'

export function makeScheduleTool(ctx?: ToolCallCtx) {
  return tool({
    description: 'Create, list, pause, resume or cancel session-local scheduled tasks when the user requests delayed or repeated work. Tasks wake this conversation on the bound tab, with the same permissions. Minimum delay/interval 30 seconds; approximate timing; no execution during device sleep. Repeating tasks wait their interval AFTER completion, require maxRuns, and never overlap. Browser restart pauses tasks. Use cancel when the goal is achieved. Available with offscreen kernel hosting.',
    inputSchema: z.object({
      description: toolDescriptionInput,
      action: z.enum(['create', 'list', 'pause', 'resume', 'cancel']),
      taskId: z.string().optional(),
      title: z.string().min(1).max(80).optional(),
      instruction: z.string().min(1).max(4000).optional(),
      delaySeconds: z.number().int().min(30).max(86400).optional(),
      intervalSeconds: z.number().int().min(30).max(86400).optional(),
      maxRuns: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args, { toolCallId }) => chrome.runtime.sendMessage({
      type: 'schedule:command', ...withoutToolDescription(args),
      sessionId: ctx?.getSessionId?.() || getActiveSessionId(),
      approval: ctx?.getApproval?.(toolCallId),
      tabId: await peekOperatingTabId(ctx),
    }),
  })
}
