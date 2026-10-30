import {
  createMCPClient,
  auth,
  UnauthorizedError,
  type MCPClient,
  type OAuthClientProvider,
  type OAuthClientMetadata,
  type OAuthTokens,
  type OAuthClientInformation,
  type OAuthAuthorizationServerInformation,
} from '@ai-sdk/mcp'
import type { McpServerConfig } from './types'
import { mcpServerFingerprint } from './agent-fingerprint'

export interface McpToolMeta {
  serverId: string
  serverName: string
  name: string
  qualifiedName: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOKEN_PREFIX = 'mcp_tokens_'
const CLIENT_PREFIX = 'mcp_client_'
const AS_PREFIX = 'mcp_as_'
export const MCP_INITIALIZATION_TIMEOUT_MS = 10_000

class McpAuthRequiredError extends Error {
  constructor() { super('需要授权，请在设置中登录此 MCP 服务') }
}

async function withMcpDeadline<T>(controller: AbortController, work: () => Promise<T>, timeout = MCP_INITIALIZATION_TIMEOUT_MS): Promise<T> {
  const deadline = AbortSignal.timeout(timeout)
  const onTimeout = () => controller.abort(new Error(`MCP 初始化超时（${timeout / 1000} 秒）`))
  deadline.addEventListener('abort', onTimeout, { once: true })
  let onAbort = () => {}
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      }),
      work(),
    ])
  } catch (error) {
    controller.abort(error)
    throw error
  } finally {
    deadline.removeEventListener('abort', onTimeout)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

// Reason: Chrome extensions use launchWebAuthFlow instead of page redirects.
// After the user authorizes, the callback URL (with the auth code) is returned
// directly — no server-side callback route needed.
class ChromeOAuthProvider implements OAuthClientProvider {
  authorizationCode: string | undefined
  interactive: boolean
  private _codeVerifier = ''
  private _state = ''
  private _tokens: OAuthTokens | undefined
  private _clientInfo: OAuthClientInformation | undefined
  private _asInfo: OAuthAuthorizationServerInformation | undefined
  private serverId: string

  constructor(serverId: string, interactive: boolean) {
    this.serverId = serverId
    this.interactive = interactive
  }

  get redirectUrl(): string {
    return `https://${chrome.runtime.id}.chromiumapp.org/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Sidekick',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    // Reason: background initialization must fail fast when refreshed credentials
    // are insufficient; browser authorization belongs to an explicit user action.
    if (!this.interactive) throw new McpAuthRequiredError()
    const callbackUrl = await chrome.identity.launchWebAuthFlow({
      url: url.toString(),
      interactive: this.interactive,
    })
    if (callbackUrl) {
      this.authorizationCode = new URL(callbackUrl).searchParams.get('code') ?? undefined
    }
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this._tokens) return this._tokens
    const key = TOKEN_PREFIX + this.serverId
    const result = await chrome.storage.local.get(key)
    this._tokens = result[key] ?? undefined
    return this._tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._tokens = tokens
    await chrome.storage.local.set({ [TOKEN_PREFIX + this.serverId]: tokens })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    return this._codeVerifier
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this._clientInfo) return this._clientInfo
    const key = CLIENT_PREFIX + this.serverId
    const result = await chrome.storage.local.get(key)
    this._clientInfo = result[key] ?? undefined
    return this._clientInfo
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    this._clientInfo = info
    await chrome.storage.local.set({ [CLIENT_PREFIX + this.serverId]: info })
  }

  async authorizationServerInformation(): Promise<OAuthAuthorizationServerInformation | undefined> {
    if (this._asInfo) return this._asInfo
    const key = AS_PREFIX + this.serverId
    const result = await chrome.storage.local.get(key)
    this._asInfo = result[key] ?? undefined
    return this._asInfo
  }

  async saveAuthorizationServerInformation(info: OAuthAuthorizationServerInformation): Promise<void> {
    this._asInfo = info
    await chrome.storage.local.set({ [AS_PREFIX + this.serverId]: info })
  }

  state(): string { return this._state }
  async saveState(state: string): Promise<void> { this._state = state }
  async storedState(): Promise<string | undefined> { return this._state || undefined }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    const keysToRemove: string[] = []
    if (scope === 'all' || scope === 'tokens') {
      this._tokens = undefined
      keysToRemove.push(TOKEN_PREFIX + this.serverId)
    }
    if (scope === 'all' || scope === 'client') {
      this._clientInfo = undefined
      keysToRemove.push(CLIENT_PREFIX + this.serverId)
    }
    if (scope === 'all' || scope === 'verifier') {
      this._codeVerifier = ''
    }
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove)
    }
  }
}

// Reason: Chrome extensions lose the `this` binding when the SDK destructures
// `globalThis.fetch` internally — calling the unbound reference throws
// "Illegal invocation". A bound wrapper fixes both transport and auth calls.
async function connectMcpServer(server: McpServerConfig, interactive: boolean, signal: AbortSignal): Promise<MCPClient> {
  if (!interactive && server.auth.type === 'oauth') {
    const key = TOKEN_PREFIX + server.id
    const stored = await chrome.storage.local.get(key)
    signal.throwIfAborted()
    if (!stored[key]?.access_token && !stored[key]?.refresh_token) throw new McpAuthRequiredError()
  }
  // Reason: the same lifetime signal must reach OAuth discovery/token fetches,
  // transport POSTs and SSE; racing only the caller leaves the SW inflight stuck.
  const boundFetch: typeof fetch = (input, init) => {
    signal.throwIfAborted()
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    return fetch(input, { ...init, signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal })
  }
  let provider: ChromeOAuthProvider | undefined

  const buildTransport = () => {
    if (server.auth.type === 'oauth') {
      provider = new ChromeOAuthProvider(server.id, interactive)
      return { type: 'http' as const, url: server.url, authProvider: provider, fetch: boundFetch }
    }
    return { type: 'http' as const, url: server.url, fetch: boundFetch }
  }

  try {
    const client = await createMCPClient({ transport: buildTransport() })
    if (signal.aborted) { void client.close().catch(() => {}); signal.throwIfAborted() }
    return client
  } catch (e) {
    // Reason: OAuth flow — first attempt triggers launchWebAuthFlow via
    // redirectToAuthorization. SDK returns 'REDIRECT' → throws UnauthorizedError.
    // But by now the user has authorized and we have the code. Complete the
    // token exchange, then reconnect.
    if (e instanceof UnauthorizedError && provider?.authorizationCode) {
      await auth(provider, {
        serverUrl: server.url,
        authorizationCode: provider.authorizationCode,
        fetchFn: boundFetch,
      })
      const client = await createMCPClient({ transport: buildTransport() })
      if (signal.aborted) { void client.close().catch(() => {}); signal.throwIfAborted() }
      return client
    }
    throw e
  }
}

export type McpProbeStatus = 'connected' | 'needs_auth' | 'error'

export interface McpProbeResult {
  status: McpProbeStatus
  toolCount: number
  error?: string
}

// Reason: non-interactive probe — for OAuth servers, checks whether tokens
// already exist in storage before attempting a network call. Avoids triggering
// any browser popup. Used by auto-probe on Settings mount and by connectAll.
export async function probeMcpServer(server: McpServerConfig): Promise<McpProbeResult> {
  return inspectMcpServer(server, false)
}

// Reason: the explicit authorization path permits a user-facing OAuth window;
// automatic probes and agent preparation must never wait on one.
export async function authMcpServer(server: McpServerConfig): Promise<McpProbeResult> {
  return inspectMcpServer(server, true)
}

async function inspectMcpServer(server: McpServerConfig, interactive: boolean): Promise<McpProbeResult> {
  const controller = new AbortController()
  let client: MCPClient | undefined
  try {
    return await withMcpDeadline(controller, async () => {
      client = await connectMcpServer(server, interactive, controller.signal)
      controller.signal.throwIfAborted()
      const tools = await client.tools()
      controller.signal.throwIfAborted()
      return { status: 'connected' as const, toolCount: Object.keys(tools).length }
    }, interactive ? 120_000 : MCP_INITIALIZATION_TIMEOUT_MS)
  } catch (e) {
    if (e instanceof McpAuthRequiredError || e instanceof UnauthorizedError) {
      return { status: 'needs_auth', toolCount: 0 }
    }
    return { status: 'error', toolCount: 0, error: e instanceof Error ? e.message : String(e) }
  } finally {
    // Reason: close() itself may await a remote DELETE; abort network I/O first
    // and never let cleanup hold the settings status at "connecting".
    controller.abort()
    void client?.close().catch(() => {})
  }
}

interface McpClientEntry {
  controller: AbortController
  client: MCPClient
  server: McpServerConfig
}

export interface McpEnsureResult {
  errors: Record<string, string>
  tools: McpToolMeta[]
  // Reason: temporary cold/warm probe — the SW describes its own state and the
  // per-step timings inside the response, so a single console shows the whole
  // path instead of forcing a second devtools window on the SW.
  diag?: string[]
}

// Reason: temporary probe — this module is evaluated when the service worker
// boots, so "alive for N ms" separates a warm worker (cache intact) from one
// Chrome just woke up (cache empty, everything reconnects).
const swBornAt = Date.now()

export class McpClientManager {
  private entries = new Map<string, McpClientEntry>()
  // Reason: toolCache holds the live AI SDK tool objects so background can both
  // serialize metadata (for sidepanel proxy) and execute tools (for mcp:call-tool)
  private toolCache = new Map<string, { entry: McpClientEntry, tool: unknown }>()
  // Reason: the fingerprint the live connections were built from. The SW is the
  // only context that can tell "nothing changed" from "we reconnected behind
  // your back" (its own restart drops every connection), so the decision to
  // refetch lives here, next to the sockets.
  private connectedFp = ''
  private inflight: Promise<McpEnsureResult> | null = null
  private inflightFp = ''

  // Reason: single-flight — a session warm-up and the first send that follows it
  // ask independently, and each new session asks again; the first caller pays
  // for the refresh and the rest ride the same promise instead of re-listing.
  ensureTools(servers: McpServerConfig[]): Promise<McpEnsureResult> {
    const enabled = servers.filter(s => s.enabled)
    const fp = mcpServerFingerprint(enabled)
    if (this.inflight) {
      if (fp === this.inflightFp) return this.inflight
      // Reason: an edited/disabled server must not receive the old config's
      // single-flight result; finish its bounded attempt before reconciling.
      return this.inflight.then(() => this.ensureTools(enabled))
    }
    this.inflightFp = fp
    this.inflight = this.syncTools(enabled).finally(() => { this.inflight = null })
    return this.inflight
  }

  private async syncTools(servers: McpServerConfig[]): Promise<McpEnsureResult> {
    const t0 = Date.now()
    const diag: string[] = []
    const fp = mcpServerFingerprint(servers)
    diag.push(`sw-alive=${t0 - swBornAt}ms entries=${this.entries.size} cached=${this.toolCache.size} fp-match=${fp === this.connectedFp}`)
    if (fp !== this.connectedFp) {
      await this.disconnectAll()
      this.connectedFp = fp
    }
    const missing = servers.filter(s => !this.entries.has(s.id))
    const errors: Record<string, string> = {}
    if (missing.length) diag.push(`reconnect=[${missing.map(s => s.name).join(',')}]`)
    // Reason: connect and list per server in parallel, each with one deadline;
    // an unresponsive service cannot indefinitely hold healthy tools hostage.
    await Promise.all(missing.map(async server => {
      const started = Date.now()
      const controller = new AbortController()
      let client: MCPClient | undefined
      try {
        await withMcpDeadline(controller, async () => {
          client = await connectMcpServer(server, false, controller.signal)
          controller.signal.throwIfAborted()
          diag.push(`connect ${server.name} +${Date.now() - started}ms`)
          const listedAt = Date.now()
          const tools = await client.tools()
          controller.signal.throwIfAborted()
          const entry = { client, server, controller }
          for (const [name, tool] of Object.entries(tools)) {
            this.toolCache.set(`${server.name}_${name}`, { entry, tool })
          }
          this.entries.set(server.id, entry)
          diag.push(`list ${server.name} +${Date.now() - listedAt}ms (${Object.keys(tools).length} tools)`)
        })
      } catch (error) {
        errors[server.id] = error instanceof Error ? error.message : String(error)
        diag.push(`init ${server.name} FAILED +${Date.now() - started}ms: ${errors[server.id]}`)
        controller.abort(error)
        void client?.close().catch(() => {})
      }
    }))
    const tools = await this.getToolMetadata()
    diag.push(`sync total +${Date.now() - t0}ms tools=${tools.length}`)
    return { errors, tools, diag }
  }

  async disconnectAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.toolCache.clear()
    for (const entry of entries) {
      entry.controller.abort()
      void entry.client.close().catch(() => {})
    }
  }

  async getToolMetadata(): Promise<McpToolMeta[]> {
    const meta: McpToolMeta[] = []
    for (const [qualifiedName, { entry, tool }] of this.toolCache) {
      const t = tool as Record<string, unknown>
      // Reason: AI SDK wraps MCP inputSchema with jsonSchema() from @ai-sdk/provider-utils,
      // creating a Schema object with a .jsonSchema getter that returns the raw JSON Schema.
      const schema = t.inputSchema as { jsonSchema?: Record<string, unknown> } | undefined
      meta.push({
        serverId: entry.server.id,
        serverName: entry.server.name,
        name: qualifiedName.slice(entry.server.name.length + 1),
        qualifiedName,
        description: (t.description as string) ?? '',
        inputSchema: schema?.jsonSchema ?? {},
      })
    }
    return meta
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<unknown> {
    const cached = this.toolCache.get(qualifiedName)
    if (!cached) throw new Error(`MCP tool not found: ${qualifiedName}`)
    const execute = (cached.tool as Record<string, unknown>).execute as
      ((args: Record<string, unknown>) => Promise<unknown>) | undefined
    if (!execute) throw new Error(`MCP tool ${qualifiedName} has no execute method`)
    return execute(args)
  }
}
