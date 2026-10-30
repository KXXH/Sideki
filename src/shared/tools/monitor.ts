import { tool } from 'ai'
import { z } from 'zod'
import { MONITOR_CODE_LIMIT } from '../monitor'
import { getActiveSessionId, peekOperatingTabId } from './bridge'
import type { ToolCallCtx } from './bridge'

export function makeMonitorTool(ctx?: ToolCallCtx) {
  return tool({
    description: `Create, list or delete page monitors. A monitor is a synchronous JS installer function (emit) => { ...; return cleanup; } running in the bound page's MAIN world. By default it runs in the top document; optional frame selects one iframe, including cross-origin frames when Chrome permits injection. window/document refer to that frame. Target frame refresh, navigation or removal ends the monitor (removal detection may take about 30 seconds); no automatic rebinding or iframe CDP fallback. It can access window/document, subscribe to events, use MutationObserver or timers. The installer must return immediately (never async); return a synchronous cleanup function to release observers/timers/listeners on deletion. Subscribe first, then check the current condition. emit(value) sends JSON data to this conversation and wakes the agent when idle; unsupported/cyclic/oversized values produce one error event. Max message 8KB, events coalesce, at most one monitor wake per session per minute, bounded maxRuns. Return value of emit is not an acknowledgement. Treat callbacks' errors yourself with try/catch and emit. Default lifetime 10 minutes and 5 wakes. Page refresh/navigation ends the monitor; SPA route changes do not. MAIN world has no chrome extension API or CDP; fetch/XHR wrapping cannot capture all network activity. Monitors share the scheduled-task panel and completion notifications. When finished, delete the monitor. Example code: (emit) => { const check = () => { if (document.querySelector('#export:not([disabled])')) { emit({ready:true}); observer.disconnect(); } }; const observer = new MutationObserver(check); observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true}); check(); return () => observer.disconnect(); }`,
    inputSchema: z.object({
      action: z.enum(['create', 'list', 'delete']),
      taskId: z.string().optional(),
      title: z.string().min(1).max(80).optional(),
      instruction: z.string().min(1).max(4000).optional().describe('What the agent should do when this monitor emits'),
      frame: z.string().trim().min(1).max(1000).optional().describe('Target iframe: CSS selector in the top document, or numeric frameId (e.g. 7 or #7) for nested frames. Omit for the top document.'),
      code: z.string().min(1).max(MONITOR_CODE_LIMIT).optional().describe('Synchronous function expression accepting emit; optionally returns cleanup'),
      timeoutSeconds: z.number().int().min(30).max(3600).optional(),
      maxRuns: z.number().int().min(1).max(20).optional(),
    }),
    execute: async (args) => chrome.runtime.sendMessage({
      type: 'monitor:command', ...args,
      sessionId: ctx?.getSessionId?.() || getActiveSessionId(),
      tabId: args.action === 'create' ? await peekOperatingTabId(ctx) : undefined,
    }),
  })
}
