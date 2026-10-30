import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = join(root, 'src/viz/sandbox.src.html')
const MARKER = '<!-- @viz-csp -->'
const BANNER = '<!-- generated from sandbox.src.html by scripts/gen-viz-sandbox.mjs; edit the template -->'

// Reason: the manifest sandbox CSP is the shared ceiling for every sandbox page
// and must stay loose enough for the online renderer; the offline page tightens
// itself with a meta policy, which the browser enforces for that document only.
const OFFLINE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

const template = readFileSync(templatePath, 'utf8')
if (!template.includes(MARKER)) {
  console.error(`[gen-viz-sandbox] ${MARKER} not found in ${templatePath}`)
  process.exit(1)
}

const meta = `<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP}">`
const offline = template.replace(MARKER, `${BANNER}\n  ${meta}`)
const online = template.replace(MARKER, BANNER)

writeFileSync(join(root, 'src/viz/sandbox.html'), offline)
writeFileSync(join(root, 'src/viz/sandbox-online.html'), online)
console.log('[gen-viz-sandbox] wrote sandbox.html (offline) and sandbox-online.html')
