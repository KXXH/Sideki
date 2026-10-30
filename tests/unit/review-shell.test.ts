import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bash, defineCommand } from 'just-bash'

vi.mock('../../src/background/shell', () => ({ captureShellReadView: vi.fn() }))
vi.mock('../../src/background/tool-handlers', () => ({ execScript: vi.fn() }))

import { createReadonlyReviewFs, createReviewShell } from '../../src/background/review-shell'
import { captureShellReadView } from '../../src/background/shell'
import { execScript } from '../../src/background/tool-handlers'

function readonlyBash() {
  const owner = new Bash({ files: { '/tmp/task.sh': 'echo first\necho second\n' }, cwd: '/' })
  const fs = createReadonlyReviewFs(owner.fs, () => true)
  return { owner, fs, bash: new Bash({ fs, cwd: '/' }) }
}

describe('review filesystem boundary', () => {
  it('retains pipes, search, nested shells, and file inspection', async () => {
    const { bash } = readonlyBash()
    expect(await bash.exec("cat /tmp/task.sh | grep second")).toMatchObject({ stdout: 'echo second\n', exitCode: 0 })
    expect(await bash.exec("bash -c 'head -n 1 /tmp/task.sh'")).toMatchObject({ stdout: 'echo first\n', exitCode: 0 })
  })

  it.each([
    'echo replaced > /tmp/task.sh',
    'echo appended >> /tmp/task.sh',
    "sed -i 's/first/changed/' /tmp/task.sh",
    "awk 'BEGIN { print \"changed\" > \"/tmp/task.sh\" }'",
    'rm /tmp/task.sh',
    'cp /tmp/task.sh /tmp/copy.sh',
    'mv /tmp/task.sh /tmp/moved.sh',
    'mkdir /tmp/new',
    'touch /tmp/new',
    'chmod 777 /tmp/task.sh',
    'ln /tmp/task.sh /tmp/link',
    'ln -s /tmp/task.sh /tmp/link',
  ])('rejects file mutations: %s', async command => {
    const { owner, bash } = readonlyBash()
    const result = await bash.exec(command).catch(error => ({ stderr: String(error), exitCode: 1 }))
    expect(result.stderr).not.toBe('')
    expect(result.exitCode).not.toBe(0)
    expect(await owner.fs.readFile('/tmp/task.sh')).toBe('echo first\necho second\n')
    expect(await owner.fs.exists('/tmp/new')).toBe(false)
  })

  it('never leaks mutable file buffers or metadata', async () => {
    const { owner, fs } = readonlyBash()
    const bytes = await fs.readFileBuffer('/tmp/task.sh')
    bytes.fill(0)
    const stat = await fs.stat('/tmp/task.sh')
    stat.mtime.setTime(0)
    expect(await owner.fs.readFile('/tmp/task.sh')).toContain('first')
    expect((await owner.fs.stat('/tmp/task.sh')).mtime.getTime()).not.toBe(0)
    expect('writeFileSync' in fs).toBe(false)
  })

  it('bounds reads before allocating file bodies and fails on stale views', async () => {
    const owner = new Bash({ files: { '/big.txt': 'x'.repeat(512 * 1024 + 1) }, cwd: '/' })
    const read = vi.spyOn(owner.fs, 'readFile')
    let current = true
    const fs = createReadonlyReviewFs(owner.fs, () => current)
    await expect(fs.readFile('/big.txt')).rejects.toThrow('512 KiB')
    expect(read).not.toHaveBeenCalled()
    current = false
    await expect(fs.stat('/big.txt')).rejects.toThrow('上下文已变化')
  })
})

describe('review shell capabilities', () => {
  let current: boolean
  let documentId: string
  beforeEach(() => {
    current = true
    documentId = 'doc-a'
    const owner = new Bash({
      files: { '/task.sh': 'echo inspect\n' }, cwd: '/',
      customCommands: ['page-content', 'dom', 'element-info'].map(name => defineCommand(name, async () => ({ stdout: '', stderr: '', exitCode: 0 }))),
    })
    vi.mocked(captureShellReadView).mockResolvedValue({ fs: owner.fs, isCurrent: () => current })
    vi.mocked(execScript).mockImplementation(async injection => {
      const isRead = 'args' in injection
      return [{ result: isRead ? 'Page body: Submit order' : { url: 'https://example.com/', timeOrigin: 12 }, documentId }] as never
    })
  })

  it('allows fixed isolated page reads and local searches without external effects', async () => {
    const shell = await createReviewShell('session', 23)
    const result = await shell.exec('page-content | grep Submit')
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe('Page body: Submit order\n')
    const read = vi.mocked(execScript).mock.calls.find(([injection]) => 'args' in injection)?.[0]
    expect(read).toMatchObject({ target: { tabId: 23, documentIds: ['doc-a'] }, world: 'ISOLATED' })
    for (const command of ['js "document.body.remove()"', 'click Submit', 'curl https://example.com', 'http-put https://example.com', 'mcp list', 'chrome tabs', 'debug console']) {
      expect((await shell.exec(command)).exitCode).not.toBe(0)
    }
    shell.dispose()
  })

  it('invalidates on VFS change, same-URL document replacement, and disposal', async () => {
    const shell = await createReviewShell('session', 23)
    expect(await shell.isCurrent()).toBe(true)
    documentId = 'doc-b'
    expect(await shell.isCurrent()).toBe(false)
    expect((await shell.exec('cat /task.sh')).exitCode).not.toBe(0)
    documentId = 'doc-a'
    current = false
    expect(await shell.isCurrent()).toBe(false)
    current = true
    shell.dispose()
    expect(await shell.isCurrent()).toBe(false)
    expect((await shell.exec('cat /task.sh')).exitCode).not.toBe(0)
  })
})
