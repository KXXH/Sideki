import { describe, expect, it } from 'vitest'
import { isPermissionMode, resolveDefaultPermissionMode, resolveSessionPermissionMode } from '../../src/shared/permission-mode'

describe('permission mode scope and compatibility', () => {
  it('migrates legacy defaults without losing explicit new defaults', () => {
    expect(resolveDefaultPermissionMode(null)).toBe('ask')
    expect(resolveDefaultPermissionMode({ yoloMode: true })).toBe('allow')
    expect(resolveDefaultPermissionMode({ securityLevel: 'permissive' })).toBe('allow')
    expect(resolveDefaultPermissionMode({ yoloMode: true, defaultPermissionMode: 'auto' })).toBe('auto')
  })

  it('does not apply the new-chat default to a legacy chat', () => {
    expect(resolveSessionPermissionMode({}, { defaultPermissionMode: 'allow', securityLevel: 'strict' })).toBe('ask')
    expect(resolveSessionPermissionMode({}, { defaultPermissionMode: 'ask', yoloMode: true })).toBe('allow')
  })

  it('keeps a saved session choice independent of both default and legacy flags', () => {
    expect(resolveSessionPermissionMode({ permissionMode: 'ask' }, { yoloMode: true, defaultPermissionMode: 'allow' })).toBe('ask')
    expect(resolveSessionPermissionMode({ permissionMode: 'auto' }, { defaultPermissionMode: 'ask' })).toBe('auto')
    expect(isPermissionMode('permissive')).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
  })
})
