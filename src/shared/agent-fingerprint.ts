import type { ApiConfig, McpServerConfig } from './types'

// Reason: one definition of "what counts as an MCP edit" — the service worker
// keys its socket reuse on it, the agents key their rebuild on it. Two copies
// drift: an id-set-only version silently ignored url and name edits, so a
// renamed server kept answering to its old qualified tool names.
export function mcpServerFingerprint(servers?: McpServerConfig[]): string {
  return (servers ?? [])
    .filter(s => s.enabled)
    .map(s => `${s.id}|${s.url}|${s.name}|${s.auth.type}`)
    .join(',')
}

// Reason: everything an agent build bakes in from config — the provider stack
// and the MCP tool table. Derived from persisted config alone: a socket
// reconnect, a slow server or a changed remote tool set must not invalidate a
// build, or the prompt cache gets thrown away for nothing.
// Both hosts (offscreen kernel and panel-hosted hook) must use this one
// function, otherwise "what counts as a change" diverges between them.
export function agentFingerprint(config: ApiConfig): string {
  // Reason: these settings are captured by the prompt, request transformer,
  // retry fetch and stop condition; edits must take effect on the next turn.
  const behavior = JSON.stringify({
    apiProtocol: config.apiProtocol ?? 'chat-completions',
    systemPrompt: config.systemPrompt,
    contextWindow: config.contextWindow,
    maxToolRounds: config.maxToolRounds,
    modelParams: config.modelParams,
    disabledSkills: config.disabledSkills,
    backendCompat: config.labBackendCompat !== false,
  })
  return `${config.endpoint}|${config.model}|${config.apiKey}|${config.reasoningEffort}|${config.supportsImages}|${behavior}|${mcpServerFingerprint(config.mcpServers)}`
}
