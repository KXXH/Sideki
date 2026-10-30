import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom'

const template = readFileSync(new URL('../../src/viz/sandbox.src.html', import.meta.url), 'utf8')
const opened: JSDOM[] = []

interface SandboxMessage {
  type: string
  id?: string
  message?: string
  height?: number
}

function sandbox(network = false, loadResource?: (request: Request) => Response | Promise<Response>) {
  const messages: SandboxMessage[] = []
  const parent = { postMessage: (message: SandboxMessage) => messages.push(message) }
  const policy = network ? '' : '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'
  // Reason: jsdom exercises the shared renderer's DOM/script protocol; it does not implement extension CSP or opaque origins.
  const dom = new JSDOM(template.replace('<!-- @viz-csp -->', policy), {
    url: 'https://sandbox.example/renderer.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: loadResource ? { interceptors: [requestInterceptor(loadResource)] } : undefined,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { value: parent })
    },
  })
  opened.push(dom)
  const render = (html: string, id = 'render-1') => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: parent,
      data: {
        type: 'viz:render', id, html,
        theme: { mode: 'light', tokens: { '--seed-fg': '#112233', '--seed-primary': '#d0261a' } },
      },
    }))
  }
  const rendered = (id = 'render-1') => vi.waitFor(() => {
    expect(messages.some(message => message.type === 'viz:rendered' && message.id === id)).toBe(true)
  })
  return { dom, window: dom.window, document: dom.window.document, messages, parent, render, rendered }
}

afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close()
})

describe('shared HTML sandbox runtime', () => {
  it('handshakes and executes fragment scripts with local DOM interactions', async () => {
    const host = sandbox()
    expect(host.messages).toContainEqual({ type: 'viz:ready' })
    host.render(`
      <button id="increment">Add</button><output id="count">0</output>
      <script>
        document.getElementById('increment').addEventListener('click', () => {
          const output = document.getElementById('count');
          output.textContent = String(Number(output.textContent) + 1);
        });
      </script>
    `)
    await host.rendered()
    host.document.getElementById('increment')!.click()
    expect(host.document.getElementById('count')!.textContent).toBe('1')
    expect(host.document.documentElement.style.getPropertyValue('--seed-fg')).toBe('#112233')
    expect(host.messages.filter(message => message.type === 'viz:error')).toEqual([])
  })

  it('preserves full-document head CSS/scripts, body attributes and script order', async () => {
    const host = sandbox()
    host.render(`<!doctype html>
      <html lang="en" data-view="report">
      <head>
        <title>Sales</title>
        <style>.report #total { color: rgb(12, 34, 56); }</style>
        <script>window.units = 7;</script>
      </head>
      <body class="report" data-period="weekly" style="padding: 5px">
        <output id="total"></output>
        <script>document.getElementById('total').textContent = String(window.units * 3);</script>
      </body></html>`)
    await host.rendered()
    expect(host.document.documentElement.lang).toBe('en')
    expect(host.document.documentElement.dataset.view).toBe('report')
    expect(host.document.body.className).toBe('report')
    expect(host.document.body.dataset.period).toBe('weekly')
    expect(host.document.body.style.padding).toBe('5px')
    expect(host.document.getElementById('total')!.textContent).toBe('21')
    expect(host.window.getComputedStyle(host.document.getElementById('total')!).color).toBe('rgb(12, 34, 56)')
    expect(host.messages.filter(message => message.type === 'viz:error')).toEqual([])
  })


  it('preserves host theme tokens alongside authored html style', async () => {
    const host = sandbox()
    host.render('<html style="background:rgb(12, 34, 56)"><body><p>Styled document</p></body></html>')
    await host.rendered()
    expect(host.document.documentElement.style.background).toBe('rgb(12, 34, 56)')
    expect(host.document.documentElement.style.getPropertyValue('--seed-fg')).toBe('#112233')
    expect(host.document.documentElement.style.colorScheme).toBe('light')
  })

  it('removes previous document/body attributes, head styles and content on a second render', async () => {
    const host = sandbox()
    host.render('<html lang="fr" data-old="yes"><head><style>#old{color:red}</style></head><body class="old" style="padding:20px" data-old="yes"><div id="old">Old</div></body></html>')
    await host.rendered()
    host.render('<p id="fresh">Fresh</p>', 'render-2')
    await host.rendered('render-2')
    expect(host.document.getElementById('old')).toBeNull()
    expect(host.document.getElementById('fresh')!.textContent).toBe('Fresh')
    expect(host.document.documentElement.hasAttribute('data-old')).toBe(false)
    expect(host.document.documentElement.lang).not.toBe('fr')
    expect(host.document.body.hasAttribute('data-old')).toBe(false)
    expect(host.document.body.className).toBe('')
    expect(host.document.body.style.padding).toBe('')
    expect(host.document.getElementById('viz-root')!.querySelector('style')).toBeNull()
    expect(host.document.documentElement.style.getPropertyValue('--seed-fg')).toBe('#112233')
  })

  it('waits for an external script before executing its dependent inline script and reporting completion', async () => {
    let release: ((content: Response) => void) | undefined
    const requested: string[] = []
    const host = sandbox(true, request => {
      requested.push(request.url)
      return new Promise<Response>(resolve => { release = resolve })
    })
    host.render(`
      <script>window.order = [];</script>
      <script src="https://cdn.example/library.js"></script>
      <output id="answer"></output>
      <script>window.order.push('inline'); document.getElementById('answer').textContent = String(window.library.double(6));</script>
    `)
    await vi.waitFor(() => expect(requested).toEqual(['https://cdn.example/library.js']))
    expect(host.window.order).toEqual([])
    expect(host.messages.some(message => message.type === 'viz:rendered')).toBe(false)
    release!(new Response("window.order.push('remote'); window.library = { double: value => value * 2 };", { headers: { 'Content-Type': 'application/javascript' } }))
    await host.rendered()
    expect(host.window.order).toEqual(['remote', 'inline'])
    expect(host.document.getElementById('answer')!.textContent).toBe('12')
    expect(host.messages.filter(message => message.type === 'viz:error')).toEqual([])
  })

  it('reports external script failure instead of silently acknowledging a successful render', async () => {
    const host = sandbox(true, () => new Response('CDN unavailable', { status: 503 }))
    host.render('<script src="https://cdn.example/missing.js"></script><p>Fallback</p>')
    await vi.waitFor(() => expect(host.messages.some(message => message.type === 'viz:error' && message.message === 'Script failed to load.')).toBe(true))
    expect(host.document.getElementById('viz-root')!.textContent).toContain('Fallback')
  })

  it('sanitizes embedded documents, outward links, submission targets and offline resources before scripts run', async () => {
    const host = sandbox()
    host.render(`
      <iframe src="https://example.com"></iframe><object data="https://example.com"></object>
      <embed src="https://example.com"><base href="https://example.com">
      <meta http-equiv="refresh" content="0;url=https://example.com">
      <link rel="stylesheet" href="https://example.com/a.css">
      <a id="out" href="https://example.com" target="_blank" download>Out</a>
      <a id="inside" href="#details">Inside</a>
      <form id="form" action="https://example.com" method="post"><button id="submit" formaction="https://example.com">Submit</button></form>
      <img id="remote-image" src="https://example.com/a.png"><img id="embedded-image" src="data:image/png;base64,AAA" srcset="data:image/png;base64,AAA 1x, data:image/png;base64,BBB 2x">
      <script>window.cleaned = !document.querySelector('#viz-root iframe, #viz-root object, #viz-root embed, #viz-root base');</script>
    `)
    await host.rendered()
    const root = host.document.getElementById('viz-root')!
    expect(host.window.cleaned).toBe(true)
    expect(root.querySelector('meta[http-equiv],link')).toBeNull()
    expect(host.document.getElementById('out')!.hasAttribute('href')).toBe(false)
    expect(host.document.getElementById('out')!.hasAttribute('target')).toBe(false)
    expect(host.document.getElementById('out')!.hasAttribute('download')).toBe(false)
    expect(host.document.getElementById('inside')!.getAttribute('href')).toBe('#details')
    expect(host.document.getElementById('form')!.hasAttribute('action')).toBe(false)
    expect(host.document.getElementById('submit')!.hasAttribute('formaction')).toBe(false)
    expect(host.document.getElementById('remote-image')!.hasAttribute('src')).toBe(false)
    expect(host.document.getElementById('embedded-image')!.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect(host.document.getElementById('embedded-image')!.getAttribute('srcset')).toBe('data:image/png;base64,AAA 1x, data:image/png;base64,BBB 2x')
    const submit = new host.window.Event('submit', { bubbles: true, cancelable: true })
    host.document.getElementById('form')!.dispatchEvent(submit)
    expect(submit.defaultPrevented).toBe(true)
  })

  it('prevents document.write from replacing the shared renderer and reports script exceptions', async () => {
    const host = sandbox()
    host.render('<p id="keep">Keep</p><script>document.write("<p>Replace</p>"); throw new Error("bad calculation");</script>')
    await host.rendered()
    expect(host.document.getElementById('keep')!.textContent).toBe('Keep')
    expect(host.messages).toContainEqual({ type: 'viz:error', id: 'render-1', message: 'document.write() is not supported inside the visualization sandbox.' })
    expect(host.messages).toContainEqual({ type: 'viz:error', id: 'render-1', message: 'bad calculation' })
  })

  it('accepts render messages only from the parent and theme updates only for the current instance', async () => {
    const host = sandbox()
    host.window.dispatchEvent(new host.window.MessageEvent('message', {
      source: null, data: { type: 'viz:render', id: 'outside', html: '<p id="outside">Outside</p>' },
    }))
    expect(host.document.getElementById('outside')).toBeNull()
    host.render('<p>Current</p>')
    await host.rendered()
    host.window.dispatchEvent(new host.window.MessageEvent('message', {
      source: host.parent,
      data: { type: 'viz:theme', id: 'old-instance', theme: { mode: 'dark', tokens: { '--seed-fg': '#ffffff' } } },
    }))
    expect(host.document.documentElement.style.getPropertyValue('--seed-fg')).toBe('#112233')
  })
})
