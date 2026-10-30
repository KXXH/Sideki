import { useEffect, useState } from 'react'
import { normalizeMarkdownText } from '../shared/pdf-anchor'
import { fetchPageMarkdown } from './vfs-client'

// Reason: re-parsing a page costs a worker round-trip plus an engine pass, so
// the normalized projection is cached for the document's lifetime. The cache is
// module-scoped because page slots unmount as they scroll out of view.
const cache = new Map<string, Promise<string>>()

function keyOf(sessionId: string, path: string, page: number, documentVersion: string): string {
  return JSON.stringify([sessionId, path, page, documentVersion])
}

// Returns the normalized markdown for one page, or null while it is still
// loading. `enabled` is false for pages with no AI note, so untouched pages
// never pay for a parse.
export function usePageMarkdown(
  sessionId: string,
  path: string,
  page: number,
  enabled: boolean,
  documentVersion: string,
): string | null {
  const [md, setMd] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !sessionId || !path || !documentVersion) return
    const key = keyOf(sessionId, path, page, documentVersion)
    let pending = cache.get(key)
    if (!pending) {
      pending = fetchPageMarkdown(sessionId, path, page, documentVersion).then(normalizeMarkdownText)
      // Reason: a failed parse must not be cached — a later note on this page
      // gets a fresh attempt.
      pending.catch(() => cache.delete(key))
      cache.set(key, pending)
    }
    let alive = true
    pending.then(text => { if (alive) setMd(text) }).catch(() => { if (alive) setMd('') })
    return () => { alive = false }
  }, [sessionId, path, page, enabled, documentVersion])

  return md
}
