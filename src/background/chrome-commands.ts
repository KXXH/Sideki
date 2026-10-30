import { defineCommand } from 'just-bash'
import type { Command } from 'just-bash'
import { requireConsent } from './tool-handlers'
import { gateExplicitTab, noteExplicitOperatingTab } from './tab-locks'

function parseFlag(args: string[], flag: string): string | null {
  const prefix = `--${flag}`
  const idx = args.indexOf(prefix)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  const eq = args.find(a => a.startsWith(`${prefix}=`))
  return eq ? eq.slice(prefix.length + 1) : null
}

function positional(args: string[]): string[] {
  const result: string[] = []
  let skip = false
  for (const a of args) {
    if (skip) { skip = false; continue }
    if (a.startsWith('--')) {
      if (!a.includes('=')) skip = true
      continue
    }
    result.push(a)
  }
  return result
}

const DENIED = { stdout: '', stderr: 'Action denied by user\n', exitCode: 126 }

// Reason: sequential indices shift when tabs are opened/closed between listing
// and operating. Chrome's native tab.id is stable across these mutations, so we
// accept "#<id>" as a stable reference alongside the legacy index format.
async function resolveTabId(ref: string): Promise<{ tabId: number; label: string } | null> {
  if (!ref.startsWith('#')) return null
  const id = parseInt(ref.slice(1), 10)
  if (isNaN(id)) return null
  try {
    await chrome.tabs.get(id)
    return { tabId: id, label: ref }
  } catch { return null }
}

async function resolveTabIds(refs: string[]): Promise<number[]> {
  const ids: number[] = []
  for (const ref of refs) {
    const r = await resolveTabId(ref)
    if (r) ids.push(r.tabId)
  }
  return ids
}

function formatIdleTime(now: number, lastAccessed?: number): string {
  if (!lastAccessed) return ''
  const mins = Math.floor((now - lastAccessed) / 60_000)
  if (mins < 1) return '(just now)'
  if (mins < 60) return `(${mins}m ago)`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `(${hours}h ago)`
  const days = Math.floor(hours / 24)
  return `(${days}d ago)`
}

async function getGroupNames(): Promise<Map<number, { title: string; color: string }>> {
  const groups = await chrome.tabGroups.query({})
  const map = new Map<number, { title: string; color: string }>()
  for (const g of groups) map.set(g.id, { title: g.title ?? '', color: g.color })
  return map
}

async function handleTabs(args: string[], tabId: number, sessionId: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const switchTo = parseFlag(args, 'switch')
  const newUrl = parseFlag(args, 'new')
  const closeIdx = parseFlag(args, 'close')
  const groupName = parseFlag(args, 'group')
  const groupColor = parseFlag(args, 'color') as chrome.tabGroups.Color | null
  const ungroupFlag = parseFlag(args, 'ungroup')
  const collapseFlag = parseFlag(args, 'collapse')
  const expandFlag = parseFlag(args, 'expand')

  if (groupName) {
    const pos = positional(args)
    if (!pos.length) return { stdout: '', stderr: 'Usage: chrome tabs --group "name" [--color blue] 1 2 3\n', exitCode: 1 }
    if (!await requireConsent('tab-group', `Group tabs as "${groupName}"`, tabId)) return DENIED
    const tabIds = await resolveTabIds(pos)
    if (!tabIds.length) return { stdout: '', stderr: 'No valid tab references\n', exitCode: 1 }
    // Reason: merge into existing same-name group instead of creating a duplicate
    const existingGroups = await chrome.tabGroups.query({})
    const existing = existingGroups.find(g => g.title === groupName)
    const groupId = await chrome.tabs.group({
      tabIds: tabIds as [number, ...number[]],
      ...(existing ? { groupId: existing.id } : {}),
    })
    if (!existing) {
      await chrome.tabGroups.update(groupId, {
        title: groupName,
        ...(groupColor ? { color: groupColor } : {}),
      })
    } else if (groupColor) {
      await chrome.tabGroups.update(groupId, { color: groupColor })
    }
    return { stdout: `Grouped ${tabIds.length} tabs as "${groupName}"\n`, stderr: '', exitCode: 0 }
  }

  if (ungroupFlag) {
    if (!await requireConsent('tab-ungroup', `Ungroup tabs ${ungroupFlag}`, tabId)) return DENIED
    const refs = ungroupFlag.split(',').map(s => s.trim())
    const tabIds = await resolveTabIds(refs)
    if (!tabIds.length) return { stdout: '', stderr: 'No valid tab references\n', exitCode: 1 }
    await chrome.tabs.ungroup(tabIds as [number, ...number[]])
    return { stdout: `Ungrouped ${tabIds.length} tabs\n`, stderr: '', exitCode: 0 }
  }

  if (collapseFlag || expandFlag) {
    const name = collapseFlag || expandFlag
    const collapsed = !!collapseFlag
    if (!await requireConsent(collapsed ? 'tab-collapse' : 'tab-expand', `${name}`, tabId)) return DENIED
    const groups = await chrome.tabGroups.query({})
    const group = groups.find(g => g.title === name)
    if (!group) return { stdout: '', stderr: `Group "${name}" not found\n`, exitCode: 1 }
    await chrome.tabGroups.update(group.id, { collapsed })
    return { stdout: `${collapsed ? 'Collapsed' : 'Expanded'} group "${name}"\n`, stderr: '', exitCode: 0 }
  }

  if (switchTo) {
    if (!await requireConsent('tab-switch', `Switch to tab ${switchTo}`, tabId)) return DENIED
    const resolved = await resolveTabId(switchTo)
    if (!resolved) return { stdout: '', stderr: `Tab ${switchTo} not found\n`, exitCode: 1 }
    // Reason: activating a tab another turn is driving pulls it out from under
    // that turn — the same gate implicit targets pass through.
    const busy = await gateExplicitTab(sessionId, resolved.tabId)
    if (busy) return { stdout: '', stderr: busy, exitCode: 1 }
    const tab = await chrome.tabs.get(resolved.tabId)
    await chrome.tabs.update(tab.id!, { active: true })
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true })
    // Reason: the agent is pointing itself at this tab — its own page tools must
    // follow the activation, not just the user's view.
    noteExplicitOperatingTab(sessionId, resolved.tabId)
    return { stdout: `Switched to: ${tab.title}\n`, stderr: '', exitCode: 0 }
  }

  if (newUrl) {
    if (!await requireConsent('tab-new', newUrl, tabId)) return DENIED
    const tab = await chrome.tabs.create({ url: newUrl })
    // Reason: a created tab fires no navigation-target event, so the stack learns
    // about it only from the command that made it the operating page.
    if (tab.id != null) noteExplicitOperatingTab(sessionId, tab.id)
    return { stdout: `Opened tab ${tab.id}: ${newUrl}\n`, stderr: '', exitCode: 0 }
  }

  if (closeIdx) {
    if (!await requireConsent('tab-close', `Close tab ${closeIdx}`, tabId)) return DENIED
    const resolved = await resolveTabId(closeIdx)
    if (!resolved) return { stdout: '', stderr: `Tab ${closeIdx} not found\n`, exitCode: 1 }
    // Reason: destroying another turn's tab is the most damaging cross-session
    // action — closing one's own tab stays allowed (removal releases the lock).
    const busy = await gateExplicitTab(sessionId, resolved.tabId)
    if (busy) return { stdout: '', stderr: busy, exitCode: 1 }
    const tab = await chrome.tabs.get(resolved.tabId)
    await chrome.tabs.remove(tab.id!)
    return { stdout: `Closed: ${tab.title}\n`, stderr: '', exitCode: 0 }
  }

  // List all tabs with group info and last-accessed time
  const tabs = await chrome.tabs.query({})
  const groupMap = await getGroupNames()
  const now = Date.now()
  const lines = tabs.map((t) => {
    const active = t.active ? '→' : ' '
    const id = `#${t.id}`
    const title = (t.title ?? '').slice(0, 50)
    const url = (t.url ?? '').slice(0, 60)
    const group = t.groupId && t.groupId !== -1 ? groupMap.get(t.groupId) : null
    const groupTag = group ? `[${group.title || group.color}] ` : ''
    const idle = formatIdleTime(now, t.lastAccessed)
    return `${active} ${id}  ${groupTag}${title}  ${url}  ${idle}`
  })
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
}

async function handleBookmarks(args: string[], tabId: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const search = parseFlag(args, 'search')
  const addUrl = parseFlag(args, 'add')
  const rmId = parseFlag(args, 'rm')
  const mkdirName = parseFlag(args, 'mkdir')
  const moveId = parseFlag(args, 'move')
  const moveTo = parseFlag(args, 'to')
  const renameId = parseFlag(args, 'rename')
  const rmTreeId = parseFlag(args, 'rm-tree')

  if (addUrl) {
    const pos = positional(args)
    const title = pos[0] || addUrl
    const parentId = parseFlag(args, 'parent')
    if (!await requireConsent('bookmark-add', `${title} → ${addUrl}`, tabId)) return DENIED
    const opts: chrome.bookmarks.CreateDetails = { url: addUrl, title }
    if (parentId) opts.parentId = parentId
    const node = await chrome.bookmarks.create(opts)
    return { stdout: `Added bookmark: ${node.title} (${node.id})\n`, stderr: '', exitCode: 0 }
  }

  if (mkdirName) {
    const parentId = parseFlag(args, 'parent')
    if (!await requireConsent('bookmark-mkdir', `Create folder "${mkdirName}"`, tabId)) return DENIED
    const opts: chrome.bookmarks.CreateDetails = { title: mkdirName }
    if (parentId) opts.parentId = parentId
    const node = await chrome.bookmarks.create(opts)
    return { stdout: `Created folder: ${node.title} (${node.id})\n`, stderr: '', exitCode: 0 }
  }

  if (moveId && moveTo) {
    if (!await requireConsent('bookmark-move', `Move ${moveId} → folder ${moveTo}`, tabId)) return DENIED
    await chrome.bookmarks.move(moveId, { parentId: moveTo })
    return { stdout: `Moved bookmark ${moveId} to folder ${moveTo}\n`, stderr: '', exitCode: 0 }
  }

  if (renameId) {
    const pos = positional(args)
    const newTitle = pos[0]
    if (!newTitle) return { stdout: '', stderr: 'Usage: chrome bookmarks --rename "id" "new title"\n', exitCode: 1 }
    if (!await requireConsent('bookmark-rename', `Rename ${renameId} → "${newTitle}"`, tabId)) return DENIED
    await chrome.bookmarks.update(renameId, { title: newTitle })
    return { stdout: `Renamed bookmark ${renameId} to "${newTitle}"\n`, stderr: '', exitCode: 0 }
  }

  if (rmTreeId) {
    if (!await requireConsent('bookmark-rm-tree', `Remove folder ${rmTreeId} and all contents`, tabId)) return DENIED
    await chrome.bookmarks.removeTree(rmTreeId)
    return { stdout: `Removed folder ${rmTreeId} and all contents\n`, stderr: '', exitCode: 0 }
  }

  if (rmId) {
    if (!await requireConsent('bookmark-rm', `Remove bookmark ${rmId}`, tabId)) return DENIED
    await chrome.bookmarks.remove(rmId)
    return { stdout: `Removed bookmark ${rmId}\n`, stderr: '', exitCode: 0 }
  }

  if (search) {
    const results = await chrome.bookmarks.search(search)
    if (!results.length) return { stdout: `No bookmarks matching "${search}"\n`, stderr: '', exitCode: 0 }
    const lines = results.map(b => `${b.id}  ${b.title}  ${b.url ?? '(folder)'}`)
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
  }

  // List bookmark tree (flat, max 50)
  const tree = await chrome.bookmarks.getTree()
  const lines: string[] = []
  function walk(nodes: chrome.bookmarks.BookmarkTreeNode[], depth: number) {
    for (const n of nodes) {
      if (lines.length >= 50) return
      const indent = '  '.repeat(depth)
      if (n.url) {
        lines.push(`${indent}${n.id}  ${n.title}  ${n.url}`)
      } else if (n.title) {
        lines.push(`${indent}[${n.id}] ${n.title}`)
      }
      if (n.children) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)
  if (lines.length >= 50) lines.push('... (use --search to find specific bookmarks)')
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
}

async function handleHistory(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const recent = parseFlag(args, 'recent')
  const full = args.includes('--full')
  const pos = positional(args)
  const query = pos[0] ?? ''
  const maxResults = recent ? parseInt(recent, 10) : 20

  const results = await chrome.history.search({ text: query, maxResults, startTime: 0 })
  if (!results.length) return { stdout: 'No history found\n', stderr: '', exitCode: 0 }

  const lines = results.map(h => {
    const date = h.lastVisitTime ? new Date(h.lastVisitTime).toLocaleString() : ''
    const title = (h.title ?? '').slice(0, 50)
    const url = full ? (h.url ?? '') : (h.url ?? '').slice(0, 60)
    return `${date}  ${title}  ${url}`
  })
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
}

async function handleDownloads(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const search = parseFlag(args, 'search')
  const query: chrome.downloads.DownloadQuery = { orderBy: ['-startTime'], limit: 20 }
  if (search) query.filenameRegex = search

  const results = await chrome.downloads.search(query)
  if (!results.length) return { stdout: 'No downloads found\n', stderr: '', exitCode: 0 }

  const lines = results.map(d => {
    const name = d.filename.split('/').pop() ?? d.filename
    const size = d.fileSize > 0 ? `${(d.fileSize / 1024).toFixed(0)}KB` : '?'
    const state = d.state ?? 'unknown'
    return `${state === 'complete' ? '+' : state === 'in_progress' ? '~' : '-'}  ${name}  ${size}  ${d.url?.slice(0, 50)}`
  })
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
}

async function handleTopSites(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sites = await chrome.topSites.get()
  const lines = sites.map((s, i) => `${String(i + 1).padStart(2)}  ${s.title}  ${s.url}`)
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
}

export function createChromeCommand(tabId: number, sessionId = ''): Command {
  return defineCommand('chrome', async (args) => {
    const sub = args[0]
    const subArgs = args.slice(1)

    switch (sub) {
      case 'tabs': return handleTabs(subArgs, tabId, sessionId)
      case 'bookmarks': return handleBookmarks(subArgs, tabId)
      case 'history': return handleHistory(subArgs)
      case 'downloads': return handleDownloads(subArgs)
      case 'top-sites': return handleTopSites()
      default:
        return {
          stdout: '',
          stderr: [
            'Usage: chrome <subcommand> [options]',
            '',
            'Subcommands:',
            '  tabs                          List open tabs (with groups)',
            '  tabs --switch #id             Switch to tab',
            '  tabs --new "url"              Open new tab',
            '  tabs --close #id              Close tab',
            '  tabs --group "name" [--color blue] #id...  Group tabs',
            '  tabs --ungroup "#id,#id,..."  Ungroup tabs',
            '  tabs --collapse "name"        Collapse a group',
            '  tabs --expand "name"          Expand a group',
            '  bookmarks                     List bookmarks',
            '  bookmarks --search "q"        Search bookmarks',
            '  bookmarks --add "url" "title" Add bookmark',
            '  bookmarks --rm "id"           Remove bookmark',
            '  history "keyword"             Search history',
            '  history --recent N            Recent N entries',
            '  history --full "keyword"      Full URLs (no truncation)',
            '  downloads                     List downloads',
            '  downloads --search "q"        Search downloads',
            '  top-sites                     Most visited sites',
            '',
            'Colors: grey blue red yellow green pink purple cyan orange',
            '',
          ].join('\n'),
          exitCode: sub ? 1 : 0,
        }
    }
  })
}
