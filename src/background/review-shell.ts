import { Bash, defineCommand } from 'just-bash'
import type { CommandName, IFileSystem } from 'just-bash'
import { captureShellReadView } from './shell'
import { execScript } from './tool-handlers'

const MAX_READ_BYTES = 512 * 1024
const MAX_TOTAL_READ_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT = 12_000
const MAX_EXEC_MS = 5_000

function readOnlyError(): never { throw new Error('EROFS: 审批环境为只读，禁止修改文件') }

// Reason: an explicit facade exposes no backend-specific sync writers or mutable buffers.
export function createReadonlyReviewFs(source: IFileSystem, isCurrent: () => boolean): IFileSystem {
  let totalRead = 0
  const check = () => { if (!isCurrent()) throw new Error('审批上下文已变化，请重新发起工具调用') }
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    check()
    const value = await operation()
    check()
    return value
  }
  const file = async <T>(path: string, operation: () => Promise<T>): Promise<T> => read(async () => {
    const stat = await source.stat(path)
    check()
    if (stat.size > MAX_READ_BYTES) throw new Error('审批单次文件读取超过 512 KiB 限制')
    totalRead += stat.size
    if (totalRead > MAX_TOTAL_READ_BYTES) throw new Error('审批累计文件读取超过 2 MiB 限制')
    return operation()
  })
  return Object.freeze({
    readFile: (path, options) => file(path, () => source.readFile(path, options)),
    readFileBuffer: (path) => file(path, async () => new Uint8Array(await source.readFileBuffer(path))),
    exists: path => read(() => source.exists(path)),
    stat: path => read(async () => { const stat = await source.stat(path); return { ...stat, mtime: new Date(stat.mtime) } }),
    lstat: path => read(async () => { const stat = await source.lstat(path); return { ...stat, mtime: new Date(stat.mtime) } }),
    readdir: path => read(async () => [...await source.readdir(path)]),
    readlink: path => read(() => source.readlink(path)),
    realpath: path => read(() => source.realpath(path)),
    resolvePath: (base, path) => { check(); return source.resolvePath(base, path) },
    getAllPaths: () => { check(); return [...source.getAllPaths()] },
    writeFile: async () => readOnlyError(),
    appendFile: async () => readOnlyError(),
    mkdir: async () => readOnlyError(),
    rm: async () => readOnlyError(),
    cp: async () => readOnlyError(),
    mv: async () => readOnlyError(),
    chmod: async () => readOnlyError(),
    utimes: async () => readOnlyError(),
    symlink: async () => readOnlyError(),
    link: async () => readOnlyError(),
  } satisfies IFileSystem)
}

type PageIdentity = { url: string; timeOrigin: number }
type PageInjectionResult<T> = { result: T; documentId?: string }

async function pageIdentity(tabId: number): Promise<PageInjectionResult<PageIdentity>> {
  const [result] = await execScript<PageIdentity>({
    target: { tabId }, world: 'ISOLATED', injectImmediately: true,
    func: () => ({ url: location.href, timeOrigin: performance.timeOrigin }),
  }, MAX_EXEC_MS)
  if (!result?.result?.url || !Number.isFinite(result.result.timeOrigin)) throw new Error('无法读取审批目标页面')
  return result
}

// Reason: this serialized function is self-contained and never installs page globals,
// invokes handlers, changes DOM, reveals elements, navigates, or evaluates supplied code.
function readReviewPage(kind: string, target: string, html: boolean): string {
  const root = target ? document.querySelector(target) : document.body
  if (!root) return '未找到目标元素'
  const limit = 50_000
  if (kind === 'element-info') {
    return JSON.stringify({
      tag: root.tagName,
      text: (root.textContent ?? '').slice(0, 2_000),
      attributes: Object.fromEntries([...root.attributes].slice(0, 30).map(a => [a.name, a.value.slice(0, 1_000)])),
    })
  }
  if (kind === 'dom') {
    const nodes = [root, ...root.querySelectorAll('button,a,input,select,textarea,[role]')].slice(0, 400)
    return JSON.stringify(nodes.map(node => ({ tag: node.tagName, id: node.id, role: node.getAttribute('role'), text: (node.textContent ?? '').slice(0, 200) }))).slice(0, limit)
  }
  if (html) return root.outerHTML.slice(0, limit)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  let node: Node | null
  let count = 0
  while ((node = walker.nextNode()) && text.length < limit && count++ < 5_000) {
    if (node.parentElement?.closest('script,style,noscript')) continue
    text += (node.textContent ?? '').slice(0, limit - text.length) + '\n'
  }
  return `Page: ${document.title}\nURL: ${location.href}\n\n${text.slice(0, limit)}`
}

const READ_COMMANDS: CommandName[] = [
  'echo', 'printf', 'cat', 'ls', 'pwd', 'readlink', 'head', 'tail', 'wc', 'stat',
  'grep', 'fgrep', 'egrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'comm', 'cut',
  'paste', 'tr', 'rev', 'nl', 'fold', 'expand', 'unexpand', 'strings', 'column',
  'join', 'find', 'basename', 'dirname', 'tree', 'du', 'env', 'printenv', 'xargs',
  'true', 'false', 'bash', 'sh', 'jq', 'base64', 'diff', 'seq', 'expr', 'file',
  'which', 'tac', 'od', 'md5sum', 'sha1sum', 'sha256sum',
]

export interface ReviewShell {
  exec(command: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }>
  isCurrent(): Promise<boolean>
  dispose(): void
}

export async function createReviewShell(sessionId: string, tabId: number): Promise<ReviewShell> {
  const view = await captureShellReadView(sessionId, tabId)
  const identity = await pageIdentity(tabId)
  let closed = false
  const active = new Set<AbortController>()
  const isCurrent = async () => {
    if (closed || !view.isCurrent()) return false
    try {
      const current = await pageIdentity(tabId)
      return !closed && view.isCurrent()
        && current.result.url === identity.result.url
        && current.result.timeOrigin === identity.result.timeOrigin
        && (!identity.documentId || current.documentId === identity.documentId)
    } catch { return false }
  }
  const customCommands = ['page-content', 'dom', 'element-info'].map(name => defineCommand(name, async args => {
    if (!await isCurrent()) throw new Error('审批上下文已变化')
    if (name === 'page-content' && args.some(arg => arg !== '--html')) throw new Error('审批 page-content 仅支持 --html，读取当前主文档')
    if (name === 'dom' && args.some(arg => !arg.startsWith('--root='))) throw new Error('审批 dom 仅支持 --root=CSS')
    if (name === 'element-info' && args.length !== 1) throw new Error('审批 element-info 需要一个 CSS 选择器')
    const root = args.find(arg => arg.startsWith('--root='))?.slice(7) ?? ''
    const target = name === 'element-info' ? args[0] ?? '' : root
    if (name === 'element-info' && !target) throw new Error('element-info 需要 CSS 选择器')
    const [result] = await execScript<string>({
      target: identity.documentId ? { tabId, documentIds: [identity.documentId] } : { tabId },
      world: 'ISOLATED', injectImmediately: true,
      func: readReviewPage,
      args: [name, target, args.includes('--html')],
    }, MAX_EXEC_MS)
    if (!await isCurrent()) throw new Error('审批上下文已变化')
    return { stdout: result?.result ?? '', stderr: '', exitCode: 0 }
  }))
  const bash = new Bash({
    fs: createReadonlyReviewFs(view.fs, () => !closed && view.isCurrent()),
    cwd: '/', commands: READ_COMMANDS, customCommands, python: false, javascript: false,
    executionLimits: { maxCommandCount: 300, maxLoopIterations: 500, maxOutputSize: MAX_OUTPUT, maxCallDepth: 30 },
  })
  let queue: Promise<unknown> = Promise.resolve()
  return {
    isCurrent,
    dispose() { closed = true; for (const controller of active) controller.abort(); active.clear() },
    exec(command, signal) {
      const run = queue.then(async () => {
        const controller = new AbortController()
        active.add(controller)
        const timer = setTimeout(() => controller.abort(), MAX_EXEC_MS)
        try {
          if (signal?.aborted || !await isCurrent()) throw new Error('审批已取消或上下文已变化')
          const result = await bash.exec(command, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal })
          if (controller.signal.aborted || signal?.aborted) throw new Error('审批调查已取消或超时')
          if (!await isCurrent()) throw new Error('审批上下文已变化')
          return { stdout: result.stdout.slice(0, MAX_OUTPUT), stderr: result.stderr.slice(0, MAX_OUTPUT), exitCode: result.exitCode }
        } catch (error) {
          return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }
        } finally { clearTimeout(timer); active.delete(controller) }
      })
      queue = run.catch(() => {})
      return run
    },
  }
}
