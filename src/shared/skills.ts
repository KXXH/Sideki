// Reason: eager + ?raw → Vite expands to static imports at build time (pure string literals,
// no dynamic chunks, no window references). Safe for service worker context.
const skillModules = import.meta.glob('/src/skills/**/SKILL.md', { query: '?raw', eager: true }) as Record<string, { default: string }>
const supportModules = import.meta.glob('/src/skills/**/*', { query: '?raw', eager: true }) as Record<string, { default: string }>

export type SkillMode = 'chat' | 'pro' | 'all'

export interface SkillMeta {
  name: string
  description: string
  dir: string
  content: string
  mode: SkillMode
  isUser?: boolean
  files?: Record<string, string>
}

export function parseFrontmatter(raw: string): { name: string; description: string; mode: SkillMode; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) return { name: '', description: '', mode: 'all', body: raw }
  const fm = match[1]
  const body = match[2]
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const modeRaw = fm.match(/^mode:\s*(.+)$/m)?.[1]?.trim() ?? 'all'
  const mode: SkillMode = modeRaw === 'pro' ? 'pro' : modeRaw === 'chat' ? 'chat' : 'all'
  return { name, description, mode, body }
}

export const skillRegistry = new Map<string, SkillMeta>()

for (const [path, mod] of Object.entries(skillModules)) {
  const raw = mod.default
  const dir = path.match(/\/skills\/([^/]+)\//)?.[1] ?? ''
  if (!dir) continue
  const { name, description, mode, body } = parseFrontmatter(raw)
  if (!name) continue
  skillRegistry.set(name, { name, description, dir, content: body.trim(), mode })
}

function modeMatch(skill: SkillMeta, currentMode?: 'chat' | 'pro'): boolean {
  if (!currentMode || skill.mode === 'all') return true
  return skill.mode === currentMode
}

export function getSkillIndex(disabledSkills: string[] = [], currentMode?: 'chat' | 'pro'): string {
  const disabled = new Set(disabledSkills)
  const lines: string[] = []
  for (const [, skill] of skillRegistry) {
    if (disabled.has(skill.name)) continue
    if (!modeMatch(skill, currentMode)) continue
    lines.push(`- ${skill.name} — ${skill.description}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(no skills available)'
}

export function getSkillContent(name: string, disabledSkills: string[] = [], currentMode?: 'chat' | 'pro'): string | null {
  if (new Set(disabledSkills).has(name)) return null
  const skill = skillRegistry.get(name)
  if (!skill || !modeMatch(skill, currentMode)) return null
  return skill.content
}

export function getSkillFiles(currentMode?: 'chat' | 'pro'): Record<string, string> {
  const visible = new Set<string>()
  for (const [, skill] of skillRegistry) {
    if (modeMatch(skill, currentMode)) visible.add(skill.dir)
  }
  const files: Record<string, string> = {}
  for (const [path, mod] of Object.entries(supportModules)) {
    const dir = path.match(/\/skills\/([^/]+)\//)?.[1] ?? ''
    if (!dir || !visible.has(dir)) continue
    // /src/skills/chrome/SKILL.md → /skills/chrome/SKILL.md
    const vpath = path.replace(/^\/src/, '')
    files[vpath] = mod.default
  }
  // Merge user skills into VFS
  for (const [, skill] of skillRegistry) {
    if (skill.isUser && modeMatch(skill, currentMode)) {
      files[`/skills/${skill.dir}/SKILL.md`] = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}`
      if (skill.files) {
        for (const [relPath, content] of Object.entries(skill.files)) {
          files[`/skills/${skill.dir}/${relPath}`] = content
        }
      }
    }
  }
  return files
}

export interface ExportableSkill {
  name: string
  description: string
  content: string
  files?: Record<string, string>
}

export function getExportableSkills(names?: string[]): ExportableSkill[] {
  const result: ExportableSkill[] = []
  for (const [, skill] of skillRegistry) {
    if (!skill.isUser) continue
    if (names && !names.includes(skill.name)) continue
    result.push({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      files: skill.files,
    })
  }
  return result
}

// --- User Skills (chrome.storage.local) ---

export function isUserSkillDir(dir: string): boolean {
  const skill = skillRegistry.get(dir)
  return skill?.isUser === true
}

// Reason: dev panel needs three-way classification to show appropriate indicators.
export function skillDirStatus(dir: string): 'user' | 'builtin' | 'unregistered' {
  const skill = skillRegistry.get(dir)
  if (skill?.isUser) return 'user'
  if (skill) return 'builtin'
  for (const [, s] of skillRegistry) {
    if (s.dir === dir) return s.isUser ? 'user' : 'builtin'
  }
  return 'unregistered'
}

interface UserSkillData {
  description: string
  content: string
  files?: Record<string, string>
  createdAt: number
}

export async function loadUserSkills(): Promise<void> {
  // Reason: purge stale user skills before reloading — handles deletions from other contexts
  for (const [name, skill] of skillRegistry) {
    if (skill.isUser) skillRegistry.delete(name)
  }
  // Reason: offscreen documents only expose chrome.runtime — read user skills
  // through the SW proxy there; panel/SW read chrome.storage directly.
  const data = chrome.storage?.local
    ? await chrome.storage.local.get('userSkills')
    : ((await chrome.runtime.sendMessage({ type: 'env:get-user-skills' })) ?? {})
  const skills: Record<string, UserSkillData> = data.userSkills ?? {}
  for (const [name, s] of Object.entries(skills)) {
    skillRegistry.set(name, {
      name,
      description: s.description,
      dir: name,
      content: s.content,
      mode: 'all',
      isUser: true,
      files: s.files,
    })
  }
}

export async function saveUserSkill(name: string, description: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const existing = skillRegistry.get(name)
  if (existing && !existing.isUser) return { ok: false, error: `"${name}" is a built-in skill and cannot be overwritten.` }
  if (content.length > 50_000) return { ok: false, error: `Skill content too large (${content.length} chars, max 50000).` }
  const data = await chrome.storage.local.get('userSkills')
  const skills: Record<string, UserSkillData> = data.userSkills ?? {}
  skills[name] = { description, content, createdAt: Date.now() }
  await chrome.storage.local.set({ userSkills: skills })
  skillRegistry.set(name, { name, description, dir: name, content, mode: 'all', isUser: true })
  return { ok: true }
}

export async function removeUserSkill(name: string): Promise<boolean> {
  const skill = skillRegistry.get(name)
  if (!skill?.isUser) return false
  const data = await chrome.storage.local.get('userSkills')
  const skills: Record<string, UserSkillData> = data.userSkills ?? {}
  delete skills[name]
  await chrome.storage.local.set({ userSkills: skills })
  skillRegistry.delete(name)
  return true
}

export const SKILL_MAX_TOTAL_SIZE = 200 * 1024
const SKILL_MAX_FILE_SIZE = 100 * 1024
const SKILL_MAX_FILE_COUNT = 20

export async function importSkillFromEntries(
  entries: { path: string; content: string }[]
): Promise<{ name: string } | { error: string }> {
  // Find SKILL.md — may be at root or inside a subdirectory
  const skillEntry = entries.find(e => e.path.endsWith('SKILL.md') || e.path === 'SKILL.md')
  if (!skillEntry) return { error: '未找到 SKILL.md 文件' }

  const { name, description, mode, body } = parseFrontmatter(skillEntry.content)
  if (!name) return { error: 'SKILL.md 缺少 name 字段' }

  const existing = skillRegistry.get(name)
  if (existing && !existing.isUser) return { error: `「${name}」是内置技能，无法覆盖` }

  // Collect sibling files relative to SKILL.md's directory
  const skillDir = skillEntry.path.includes('/')
    ? skillEntry.path.slice(0, skillEntry.path.lastIndexOf('/') + 1)
    : ''
  const files: Record<string, string> = {}
  let totalSize = skillEntry.content.length
  let fileCount = 0

  for (const entry of entries) {
    if (entry === skillEntry) continue
    if (skillDir && !entry.path.startsWith(skillDir)) continue
    const relPath = skillDir ? entry.path.slice(skillDir.length) : entry.path
    if (!relPath || relPath.endsWith('/')) continue
    if (entry.content.length > SKILL_MAX_FILE_SIZE) continue
    totalSize += entry.content.length
    fileCount++
    if (fileCount > SKILL_MAX_FILE_COUNT) break
    files[relPath] = entry.content
  }

  if (totalSize > SKILL_MAX_TOTAL_SIZE) return { error: `技能总大小 ${Math.round(totalSize / 1024)}KB 超过 200KB 限制` }

  // Save to storage
  const data = await chrome.storage.local.get('userSkills')
  const skills: Record<string, { description: string; content: string; files?: Record<string, string>; createdAt: number }> = data.userSkills ?? {}
  skills[name] = {
    description,
    content: body.trim(),
    files: Object.keys(files).length > 0 ? files : undefined,
    createdAt: Date.now(),
  }
  await chrome.storage.local.set({ userSkills: skills })
  skillRegistry.set(name, { name, description, dir: name, content: body.trim(), mode, isUser: true, files: Object.keys(files).length > 0 ? files : undefined })
  return { name }
}

export interface SkillSyncResult {
  warnings: string[]
  changed: Map<string, { content: string; description: string; files: Record<string, string> }>
}

/**
 * Validates user skill files from VFS state. Pure computation, no I/O.
 * Returns warnings and the changed skill data to persist.
 */
export function validateUserSkillsFromVfs(
  vfsPaths: Map<string, string>,
): SkillSyncResult {
  const warnings: string[] = []
  const changed = new Map<string, { content: string; description: string; files: Record<string, string> }>()

  for (const [, skill] of skillRegistry) {
    if (!skill.isUser) continue
    const prefix = `/skills/${skill.dir}/`
    const skillMdPath = `${prefix}SKILL.md`
    const skillMdContent = vfsPaths.get(skillMdPath)

    if (!skillMdContent) continue

    let description = skill.description
    let content = skill.content

    const parsed = parseFrontmatter(skillMdContent)
    if (!parsed.name) {
      warnings.push(`[skill] ${skillMdPath}: frontmatter parse failed (missing name). Skill metadata unchanged.`)
    } else {
      description = parsed.description || skill.description
      content = parsed.body.trim()
    }

    const files: Record<string, string> = {}
    let totalSize = skillMdContent.length
    let fileCount = 0

    for (const [path, fileContent] of vfsPaths) {
      if (!path.startsWith(prefix) || path === skillMdPath) continue
      const relPath = path.slice(prefix.length)
      if (fileContent.length > SKILL_MAX_FILE_SIZE) {
        warnings.push(`[skill] ${path}: file size ${Math.round(fileContent.length / 1024)}KB exceeds 100KB limit, won't persist.`)
        continue
      }
      totalSize += fileContent.length
      fileCount++
      if (fileCount > SKILL_MAX_FILE_COUNT) {
        warnings.push(`[skill] /skills/${skill.dir}/: file count exceeds ${SKILL_MAX_FILE_COUNT} limit, extra files won't persist.`)
        break
      }
      files[relPath] = fileContent
    }

    if (totalSize > SKILL_MAX_TOTAL_SIZE) {
      warnings.push(`[skill] /skills/${skill.dir}/: total size ${Math.round(totalSize / 1024)}KB exceeds 200KB limit, extra files won't persist.`)
    }

    // Check if anything changed
    const filesChanged = JSON.stringify(files) !== JSON.stringify(skill.files ?? {})
    const contentChanged = content !== skill.content || description !== skill.description
    if (contentChanged || filesChanged) {
      changed.set(skill.name, { content, description, files })
    }
  }

  return { warnings, changed }
}

/**
 * Persists changed user skill files to chrome.storage.local and updates registry.
 */
export async function persistUserSkillChanges(
  changed: Map<string, { content: string; description: string; files: Record<string, string> }>,
): Promise<void> {
  if (changed.size === 0) return
  const data = await chrome.storage.local.get('userSkills')
  const skills: Record<string, UserSkillData> = data.userSkills ?? {}

  for (const [name, update] of changed) {
    if (!skills[name]) continue
    skills[name].content = update.content
    skills[name].description = update.description
    skills[name].files = Object.keys(update.files).length > 0 ? update.files : undefined

    const meta = skillRegistry.get(name)
    if (meta) {
      meta.content = update.content
      meta.description = update.description
      meta.files = Object.keys(update.files).length > 0 ? update.files : undefined
    }
  }

  await chrome.storage.local.set({ userSkills: skills })
}
