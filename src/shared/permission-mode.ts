import type { ApiConfig, ChatSession, PermissionMode } from './types'

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'allow']

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  ask: '请求批准',
  auto: '自动审批（beta）',
  allow: '全部允许',
}

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: '需要授权的操作由你确认',
  auto: 'AI 根据你的要求审批操作，通过后执行',
  allow: '跳过普通操作确认，直接执行',
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'auto' || value === 'allow'
}

export function legacyPermissionMode(config?: Partial<ApiConfig> | null): PermissionMode {
  return config?.yoloMode || config?.securityLevel === 'permissive' ? 'allow' : 'ask'
}

export function resolveDefaultPermissionMode(config?: Partial<ApiConfig> | null): PermissionMode {
  return isPermissionMode(config?.defaultPermissionMode) ? config.defaultPermissionMode : legacyPermissionMode(config)
}

export function resolveSessionPermissionMode(session?: Pick<ChatSession, 'permissionMode'> | null, config?: Partial<ApiConfig> | null): PermissionMode {
  // Reason: changing the new-chat default must not change existing chats that predate per-session permissions.
  return isPermissionMode(session?.permissionMode) ? session.permissionMode : legacyPermissionMode(config)
}
