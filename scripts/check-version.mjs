import { readFileSync } from 'node:fs'

const readJson = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
const pkg = readJson('package.json')
const manifest = readJson('manifest.json')
const lock = readJson('package-lock.json')
// Reason: one version identifies the source tag, npm lock and installable extension.
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || manifest.version !== pkg.version || lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
  throw new Error('package.json, package-lock.json and manifest.json must share one numeric x.y.z version')
}
console.log(pkg.version)
