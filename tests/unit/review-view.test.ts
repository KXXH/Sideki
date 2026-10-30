import { beforeEach, expect, it, vi } from 'vitest'
import { defineCommand } from 'just-bash'

vi.mock('../../src/background/shell-commands', () => ({
  createPageCommands: () => [defineCommand('page-content', async () => ({ stdout: 'page', stderr: '', exitCode: 0 }))],
}))
vi.mock('../../src/background/chrome-commands', () => ({ createChromeCommand: () => defineCommand('chrome', async () => ({ stdout: '', stderr: '', exitCode: 0 })) }))
vi.mock('../../src/background/mcp-commands', () => ({ createMcpCommand: () => defineCommand('mcp', async () => ({ stdout: '', stderr: '', exitCode: 0 })) }))
vi.mock('../../src/background/debug-commands', () => ({ createDebugCommand: () => defineCommand('debug', async () => ({ stdout: '', stderr: '', exitCode: 0 })) }))
vi.mock('../../src/shared/skills', () => ({
  getSkillFiles: () => ({}), isUserSkillDir: () => false, skillDirStatus: () => 'builtin',
  validateUserSkillsFromVfs: () => ({ warnings: [], changed: [] }), persistUserSkillChanges: vi.fn(),
}))
vi.mock('../../src/shared/memory-storage', () => ({ getMemoryFiles: async () => ({}) }))
vi.mock('../../src/shared/storage', () => ({ loadConfig: async () => ({}), loadSessionIndex: async () => [] }))
vi.mock('../../src/shared/shell-storage', () => ({
  loadShellFs: async () => ({ '/tmp/task.sh': 'echo original' }), saveShellFs: vi.fn(), deleteShellFs: vi.fn(),
  MAX_SESSION_SIZE_CHAT: 2 * 1024 * 1024, MAX_SESSION_SIZE_PRO: 20 * 1024 * 1024,
}))

import { captureShellReadView, deleteShellInstance, execBash, writeToShellFile, readShellFile } from '../../src/background/shell'

beforeEach(async () => { await deleteShellInstance('review-version') })

it('does not invalidate on reads and preserves initial custom-command registration', async () => {
  const view = await captureShellReadView('review-version', 1)
  expect(view.isCurrent()).toBe(true)
  expect(await execBash('review-version', 1, 'page-content')).toMatchObject({ stdout: 'page', exitCode: 0 })
  expect(view.isCurrent()).toBe(true)
  await view.fs.readFile('/tmp/task.sh')
  expect(view.isCurrent()).toBe(true)
})

it('invalidates a live view for external writes, shell writes, and instance deletion', async () => {
  const first = await captureShellReadView('review-version', 1)
  await writeToShellFile('review-version', '/tmp/task.sh', 'changed')
  expect(first.isCurrent()).toBe(false)
  const second = await captureShellReadView('review-version', 1)
  expect(await execBash('review-version', 1, 'echo second > /tmp/task.sh')).toMatchObject({ exitCode: 0 })
  expect(second.isCurrent()).toBe(false)
  const third = await captureShellReadView('review-version', 1)
  await deleteShellInstance('review-version')
  expect(third.isCurrent()).toBe(false)
})

it('aborts remaining Bash writes when its execution capability is cancelled', async () => {
  const controller = new AbortController()
  const pending = execBash('review-version', 1, 'sleep 0.2; echo forbidden > /tmp/after-stop.txt', false, {
    mode: 'auto', sessionId: 'review-version', toolCallId: 'call', signal: controller.signal,
    isActive: () => !controller.signal.aborted,
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort()
  expect((await pending).exitCode).not.toBe(0)
  expect(await readShellFile('review-version', '/tmp/after-stop.txt')).toBeNull()
})
