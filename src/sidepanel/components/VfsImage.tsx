import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { parseVfsPreviewLink } from '../../shared/html-artifact'
import { previewFileBlob, readPreviewFile } from '../../preview/preview-host'

const SessionContext = createContext<string | undefined>(undefined)
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i

export function VfsImageProvider({ sessionId, children }: { sessionId?: string; children: ReactNode }) {
  return <SessionContext.Provider value={sessionId}>{children}</SessionContext.Provider>
}

export default function VfsImage({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const sessionId = useContext(SessionContext)
  const path = parseVfsPreviewLink(src)?.path
  if (!sessionId || !path || !IMAGE_EXT.test(path)) {
    return <span role="status" className="text-xs text-text-muted">图片加载失败：{alt || src}</span>
  }
  // Reason: a different session or file must start with a fresh loading state, never a revoked URL.
  return <LoadedVfsImage key={JSON.stringify([sessionId, path])} sessionId={sessionId} path={path} alt={alt} title={title} />
}

function LoadedVfsImage({ sessionId, path, alt, title }: { sessionId: string; path: string; alt?: string; title?: string }) {
  const [state, setState] = useState<{ url?: string; failed?: boolean }>({})

  useEffect(() => {
    let disposed = false
    let url: string | undefined
    void readPreviewFile(message => chrome.runtime.sendMessage(message), sessionId, path)
      .then(content => {
        // Reason: late reads must not display another session's image or leak a Blob URL.
        if (disposed) return
        url = URL.createObjectURL(previewFileBlob(path, content))
        setState({ url })
      })
      .catch(() => { if (!disposed) setState({ failed: true }) })
    return () => {
      disposed = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [sessionId, path])

  if (state.failed) return <span role="status" className="text-xs text-text-muted">图片加载失败：{alt || path}</span>
  if (!state.url) return <span role="status" className="text-xs text-text-muted">正在加载图片…</span>
  return (
    <img
      src={state.url}
      alt={alt ?? ''}
      title={title}
      className="my-2 inline-block h-auto max-w-full rounded-lg"
      onError={() => setState({ failed: true })}
    />
  )
}
