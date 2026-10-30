import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Reason: jsdom does not enforce CSP or model opaque-origin navigation. Opt in
// with CHROME_BIN to run this security regression in an isolated real browser.
const chromeBin = process.env.CHROME_BIN
const hostPath = new URL('../../src/preview/index.html', import.meta.url)
async function navigateSandbox(network: boolean, protectedHost = true) {
  const host = await readFile(hostPath, 'utf8')
  const policies = host.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi)?.join('\n') ?? ''
  const renderer = await readFile(new URL(`../../src/viz/sandbox${network ? '-online' : ''}.html`, import.meta.url), 'utf8')
  const hits: string[] = []
  const profile = await mkdtemp(join(tmpdir(), 'sideki-navigation-'))
  const server = createServer((request, response) => {
    hits.push(request.url ?? '')
    response.setHeader('Content-Type', 'text/html')
    if (request.url === '/sandbox') { response.end(renderer); return }
    if (request.url !== '/') { response.end('destination'); return }
    const address = server.address() as { port: number }
    const html = `<script>parent.postMessage({type:'test:attempt'},'*');location.href='http://localhost:${address.port}/leak'</script>`
    response.end(`<!doctype html><head>${protectedHost ? policies : ''}</head><body><output id="attempt"></output><script>
      addEventListener('message', event => {
        if (event.data.type === 'test:attempt') document.querySelector('output').textContent = 'attempted';
        if (event.data.type === 'viz:ready') event.source.postMessage({type:'viz:render',id:'regression',html:${JSON.stringify(html).replaceAll('<', '\\u003c')}},'*');
      });
    </script><iframe sandbox="allow-scripts" src="/sandbox"></iframe></body>`)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const port = (server.address() as { port: number }).port
    const stdout = await new Promise<string>((resolve, reject) => {
      // Reason: keep isolated CI Chrome independent of background services, proxy discovery and page-load stalls.
      const child = spawn(chromeBin!, ['--headless', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server',
        '--disable-dev-shm-usage', '--timeout=10000',
        `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=1500', `http://127.0.0.1:${port}/`])
      let output = ''
      let stderr = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4_000) })
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Chrome navigation check timed out: ${stderr}`)) }, 40_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (code === 0) resolve(output)
        else reject(new Error(`Chrome exited with ${code ?? signal}: ${stderr}`))
      })
    })
    expect(stdout).toContain('>attempted</output>')
    expect(hits).toContain('/sandbox')
    return hits
  } finally {
    // Reason: a failed browser must not keep the test alive through an unfinished HTTP connection.
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe.skipIf(!chromeBin)('real Chrome preview navigation boundary', () => {
  it('detects an external request without the host policy (positive control)', async () => {
    expect(await navigateSandbox(false, false)).toContain('/leak')
  }, 40_000)
  it.each([false, true])('blocks external navigation with network=%s while executing inline scripts', async network => {
    expect(await navigateSandbox(network)).not.toContain('/leak')
  }, 40_000)
})
