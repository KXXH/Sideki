export type ApiProtocol = 'chat-completions' | 'responses'

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | ''

// Reason: optional sampling/decoding params; only fields with finite numbers
// are injected into the request body. Mixed naming follows OpenAI + Qwen/llama.cpp conventions.
export interface ModelParams {
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  presencePenalty?: number
  repetitionPenalty?: number
  maxTokens?: number
}

export interface ProviderProfile {
  apiProtocol?: ApiProtocol
  serviceId?: string
  serviceName?: string
  templateId?: string
  id: string
  name: string
  endpoint: string
  apiKey: string
  model: string
  reasoningEffort: ReasoningEffort
  supportsImages?: boolean
  modelParams?: ModelParams
  // Reason: context window is a model spec, so it lives per-profile; absent
  // value falls back to the top-level ApiConfig.contextWindow (legacy global).
  contextWindow?: number
}

export type FontFamily = 'sans' | 'serif'
export type FontSize = 'compact' | 'default' | 'relaxed'
export type ColorMode = 'system' | 'light' | 'dark'

export type SecurityLevel = 'strict' | 'permissive'
export type PermissionMode = 'ask' | 'auto' | 'allow'

export interface McpServerConfig {
  id: string
  name: string
  url: string
  auth: { type: 'none' } | { type: 'oauth' }
  enabled: boolean
}

export type ToolCallDisplay = 'description' | 'raw'

export interface ApiConfig {
  apiProtocol?: ApiProtocol
  endpoint: string
  apiKey: string
  model: string
  contextWindow: number
  systemPrompt: string
  reasoningEffort: ReasoningEffort
  supportsImages?: boolean
  securityLevel: SecurityLevel
  defaultPermissionMode?: PermissionMode
  // Reason: zero uses the built-in 100-step budget rather than disabling the limit.
  maxToolRounds: number
  yoloMode: boolean
  proModeAccepted?: boolean
  devMode: boolean
  accentColor: string
  colorMode?: ColorMode
  fontFamily: FontFamily
  fontSize: FontSize
  pageLockIndicator?: boolean
  aiPointer?: boolean
  activeProfileId: string
  profiles: ProviderProfile[]
  modelParams?: ModelParams
  disabledSkills?: string[]
  // Reason: how the client presents itself to every configured LLM endpoint —
  // a global identity, not a per-profile property. Backed by declarativeNetRequest
  // rules in the service worker; the fetch-layer UA override is dead in Chromium.
  requestIdentity?: { enabled: boolean; userAgent?: string }
  // Reason: true-default quality-of-life switches. Explicit false is the opt-out
  // path for older configs that omit the field.
  collapseSteps?: boolean
  // Reason: presentation only; both choices retain descriptions in tool inputs.
  toolCallDisplay?: ToolCallDisplay
  // Reason: announce a finished turn through a system notification when the
  // session is not on screen (panel closed, another session shown, browser in
  // the background). True-default: explicit false is the opt-out.
  notifyOnComplete?: boolean
  labAutoCompress?: boolean
  labAsyncScript?: boolean
  labBackendCompat?: boolean
  labSingleDollarMath?: boolean
  labFetch?: boolean
  // Reason: kernel host switch — 'offscreen' (default) runs the agent runtime
  // inside the offscreen document so turns survive panel closure; 'panel' is the
  // manual fallback host.
  labKernelHost?: 'panel' | 'offscreen'
  // Reason: retain the stored key for existing image-copy preferences; file
  // capacity is independent and defaults to the large tier.
  labImageFs?: boolean
  largeFileUploads?: boolean
  // Reason: kill switch for the high-fidelity synthetic input engine. Defaults
  // to ON — set false to fall back to the legacy single-event path if a site
  // regresses. Kept in the developer compatibility settings.
  labInputEngine?: boolean
  mcpServers?: McpServerConfig[]
}

export interface PageContent {
  title: string
  url: string
  content: string
  images?: string[]
}

export interface ExtractResponse {
  success: boolean
  data?: PageContent
  error?: string
}

export type Message =
  | { type: 'extract-content'; tabId: number }
  | { type: 'tab-changed'; tabId: number }

export interface ElementAttachment {
  croppedImage: string
  domSnapshot: string
  label: string
  // Reason: raw bytes stay in the panel draft until the session VFS durably accepts them.
  file?: { name: string; mime: string; latin1: string }
  savedFile?: { sessionId: string; path: string; name: string; size: number; mime: string }
}

// Reason: messages typed as unknown[] because storage holds UIMessage[]
// which is an external type — callers cast on read
export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pageUrl?: string
  mode?: 'chat' | 'pro'
  permissionMode?: PermissionMode
  messages: unknown[]
  // Reason: metadata-only transfers (offscreen env proxy) strip messages —
  // this carries the real count so list UIs can still distinguish empty
  // sessions from stripped ones.
  messageCount?: number
  // Reason: set by mid-turn checkpoints — a session loaded with this flag
  // was interrupted by a kernel/panel death; cleared on the next ready save.
  interrupted?: boolean
}
