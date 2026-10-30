import { makeDomTools } from './dom-tools'
import { makePageTools } from './page-tools'
import { makeBashTool } from './bash-tool'
import { makeVisualizeTool } from './visualize'
import { makeScheduleTool } from './schedule'
import { makeMonitorTool } from './monitor'
import { useSkillTool } from './use-skill'
import type { ToolCallCtx } from './bridge'

// Reason: per-agent tool sets — each kernel's agent gets tools bound to its
// own session/tab context. The no-ctx variant keeps panel-mode behavior
// (module-level session id + chrome.tabs resolution) unchanged.
export function createAgentTools(ctx?: ToolCallCtx) {
  const dom = makeDomTools(ctx)
  const page = makePageTools(ctx)
  return {
    click: dom.clickTool,
    hover: dom.hoverTool,
    type: dom.typeTool,
    select: dom.selectTool,
    keypress: dom.keypressTool,
    scroll: page.scrollTool,
    screenshot: page.screenshotTool,
    wait: page.waitTool,
    navigate: page.navigateTool,
    getPageContent: page.getPageContentTool,
    bash: makeBashTool(ctx),
    visualize: makeVisualizeTool(ctx),
    useSkill: useSkillTool,
    schedule: makeScheduleTool(ctx),
    monitor: makeMonitorTool(ctx),
  }
}

export const agentTools = createAgentTools()
