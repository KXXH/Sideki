import init, { processPdf, version } from '@firecrawl/pdf-inspector-wasm'
import type { PdfProcessResult } from '@firecrawl/pdf-inspector-wasm'
import wasmUrl from '@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm?url'

export type { PdfProcessResult }

// Reason: measured on an 88-page 2MB paper — a ~143ms fixed document-load cost
// plus ~5.6ms per page. processPdf is synchronous, so that time blocks the whole
// service worker event loop, and the exec AbortController cannot interrupt it
// (abort only takes effect at an await boundary). Capping pages per call is the
// only thing that bounds the stall: 200 pages lands around 1.3s worst case.
export const MAX_PAGES_PER_CALL = 200

// Reason: the glue's own `new URL(..., import.meta.url)` fallback already makes
// Vite emit the .wasm as an asset. Importing that same file with ?url reuses
// the emitted copy instead of shipping a second one, and gives us the hashed
// path at build time. Passing the bytes to init() calls WebAssembly.instantiate
// directly, so instantiation never depends on the response MIME type.
//
// Reason: one instantiation per service worker lifetime. The SW can be evicted
// at any time; module state dies with it and the next call re-initializes, so
// no explicit invalidation is needed.
let ready: Promise<void> | null = null

function load(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const res = await fetch(wasmUrl)
      if (!res.ok) throw new Error(`wasm fetch failed: ${res.status}`)
      await init({ module_or_path: await res.arrayBuffer() })
    })().catch(e => {
      // Reason: a failed init must not poison the cache — a later call
      // (e.g. after a transient fetch failure) should be able to retry.
      ready = null
      throw e
    })
  }
  return ready
}

export async function getVersion(): Promise<string> {
  await load()
  return version()
}

export interface ParsePdfOptions {
  includePageMarkers?: boolean
}

// Reason: pages is always passed explicitly. Out-of-range page numbers are
// ignored by the engine while the returned pageCount is still the document's
// real total, so one bounded call can both cap the work and report honestly
// how much of the document was left out.
export async function parsePdf(bytes: Uint8Array, pages: number[], opts?: ParsePdfOptions): Promise<PdfProcessResult> {
  await load()
  return processPdf(bytes, { pages, ...opts })
}
