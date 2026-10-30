import { McpClientManager, probeMcpServer, authMcpServer } from '../shared/mcp-client'
import { loadConfig } from '../shared/storage'
import { requireConsent } from './tool-handlers'
import type { ExecutionApproval } from '../shared/approval-types'
import type { McpServerConfig } from '../shared/types'

const manager = new McpClientManager()

async function configuredServers(): Promise<McpServerConfig[]> {
  const config = await loadConfig()
  return config?.mcpServers?.filter(s => s.enabled) ?? []
}

// Reason: tool calls carry no server list of their own — reconnect from config
// when a call arrives after the SW was restarted (which kills the manager).
async function ensureConnected(): Promise<void> {
  await manager.ensureTools(await configuredServers())
}

export async function handleMcpMessage(
  type: string,
  message: Record<string, unknown>,
  tabId: number,
  authorization?: ExecutionApproval,
): Promise<unknown> {
  switch (type) {
    // Reason: one entry point for "give me the current MCP tools". The server
    // list is read here rather than taken from the caller: the decision to
    // reconnect (and therefore to re-list) belongs to whoever holds the
    // connections, and a caller-supplied list is one more copy that can
    // disagree with storage.
    case 'mcp:ensure':
      return await manager.ensureTools(await configuredServers())
    case 'mcp:probe':
      return await probeMcpServer(message.server as McpServerConfig)
    case 'mcp:auth':
      return await authMcpServer(message.server as McpServerConfig)
    case 'mcp:call-tool': {
      const toolName = message.qualifiedName as string
      const toolArgs = (message.args as Record<string, unknown>) ?? {}
      const summary = Object.keys(toolArgs).length > 0
        ? `${toolName}(${Object.keys(toolArgs).join(', ')})`
        : toolName
      const granted = authorization
        ? await requireConsent('mcp', summary, tabId, undefined, authorization)
        : await requireConsent('mcp', summary, tabId)
      if (!granted) {
        return { error: 'Action denied by user' }
      }
      await ensureConnected()
      if (authorization && !authorization.isActive()) return { error: '调用授权已失效' }
      return await manager.callTool(toolName, toolArgs)
    }
    default:
      return { error: `unknown mcp message: ${type}` }
  }
}
