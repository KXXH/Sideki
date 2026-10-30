// Reason: Pro mode keeps the debugger attached for the entire session lifetime,
// avoiding per-operation attach/detach overhead and enabling continuous capture
// of console logs, network traffic, and DOM state.

export interface ConsoleEntry {
  level: string  // log, warn, error, info, debug
  text: string
  timestamp: number
  stackTrace?: string
  args?: string[]
}

export interface NetworkEntry {
  requestId: string
  url: string
  method: string
  status?: number
  mimeType?: string
  startTime: number
  endTime?: number
  size?: number
  error?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  postData?: string
  fromCache?: boolean
}

export interface ScriptInfo {
  scriptId: string
  url: string
  startLine: number
  endLine: number
}

const CDP_VERSION = '1.3'
const MAX_BUFFER_SIZE = 500

// Reason: only extract styles that are useful for layout debugging — full
// getComputedStyle returns 300+ properties which wastes tokens
const KEY_STYLES = [
  'display', 'position', 'width', 'height', 'margin', 'padding',
  'color', 'background', 'font-size', 'visibility', 'opacity',
  'z-index', 'overflow',
]

class DebugSession {
  private tabId: number | null = null
  private attached = false
  private consoleBuffer: ConsoleEntry[] = []
  private networkBuffer: NetworkEntry[] = []
  private consoleListening = false
  private networkListening = false
  private pendingNetworkRequests = new Map<string, NetworkEntry>()
  private networkFilter: string | undefined = undefined

  constructor() {
    // Reason: single event listener registered once — routes all CDP events
    // to the appropriate handler based on method name
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId !== this.tabId) return
      this.handleCdpEvent(method, params as Record<string, unknown>)
    })

    // Reason: if debugger detaches (navigation, user closed bar), auto-reattach
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== this.tabId) return
      const tabId = this.tabId
      this.attached = false
      this.consoleListening = false
      this.networkListening = false
      this.pendingNetworkRequests.clear()
      console.log('[DebugSession] detached:', reason)

      // Reason: 'target_closed' means navigation — reattach after page loads
      if (reason === 'target_closed' && tabId !== null) {
        this.tabId = null
        const reattach = () => {
          chrome.tabs.get(tabId, (tab) => {
            if ((chrome.runtime as { lastError?: unknown }).lastError || !tab) return
            if (tab.status === 'complete') {
              this.attach(tabId).catch(e => console.warn('[DebugSession] reattach failed:', e))
            } else {
              setTimeout(reattach, 500)
            }
          })
        }
        setTimeout(reattach, 1000)
      } else {
        this.tabId = null
      }
    })
  }

  // --- Lifecycle ---

  async attach(tabId: number): Promise<void> {
    if (this.attached && this.tabId === tabId) return
    if (this.attached) await this.detach()

    await chrome.debugger.attach({ tabId }, CDP_VERSION)
    this.tabId = tabId
    this.attached = true

    // Reason: Runtime domain is needed for console capture and element evaluation —
    // enable it eagerly since most Pro mode operations need it
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
  }

  async detach(): Promise<void> {
    if (!this.attached || this.tabId === null) return

    try {
      if (this.networkListening) {
        await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Network.disable')
      }
      await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Runtime.disable')
    } catch {
      // Reason: domains may already be disabled if tab navigated or closed
    }

    try {
      await chrome.debugger.detach({ tabId: this.tabId })
    } catch {
      // Reason: already detached (user closed debugger bar)
    }

    this.attached = false
    this.consoleListening = false
    this.networkListening = false
    this.tabId = null
    this.consoleBuffer = []
    this.networkBuffer = []
    this.pendingNetworkRequests.clear()
  }

  isAttached(): boolean {
    return this.attached
  }

  getTabId(): number | null {
    return this.tabId
  }

  getStatus() {
    return {
      attached: this.attached,
      tabId: this.tabId,
      consoleListening: this.consoleListening,
      networkListening: this.networkListening,
      consoleCount: this.consoleBuffer.length,
      consoleErrors: this.consoleBuffer.filter(e => e.level === 'error' || e.level === 'warning').length,
      networkCount: this.networkBuffer.length,
      networkPending: this.pendingNetworkRequests.size,
    }
  }

  // --- Console ---

  async startConsoleCapture(): Promise<void> {
    if (!this.attached || this.tabId === null) {
      throw new Error('Debugger not attached')
    }
    if (this.consoleListening) return
    this.consoleBuffer = []
    this.consoleListening = true
    // Reason: Runtime.enable already called in attach() — consoleAPICalled
    // events will be routed by handleCdpEvent
  }

  async stopConsoleCapture(): Promise<ConsoleEntry[]> {
    this.consoleListening = false
    return [...this.consoleBuffer]
  }

  clearConsoleBuffer(): void {
    this.consoleBuffer = []
  }

  getConsoleBuffer(): ConsoleEntry[] {
    return [...this.consoleBuffer]
  }

  // --- Network ---

  async startNetworkCapture(filter?: string): Promise<void> {
    if (!this.attached || this.tabId === null) {
      throw new Error('Debugger not attached')
    }
    if (this.networkListening) {
      await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Network.disable')
    }
    this.networkBuffer = []
    this.pendingNetworkRequests.clear()
    this.networkFilter = filter
    this.networkListening = true
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Network.enable')
  }

  async stopNetworkCapture(): Promise<NetworkEntry[]> {
    if (this.attached && this.tabId !== null && this.networkListening) {
      try {
        await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Network.disable')
      } catch {
        // Reason: may fail if tab was navigated
      }
    }
    this.networkListening = false
    // Reason: flush pending requests (started but never completed) into the buffer
    for (const entry of this.pendingNetworkRequests.values()) {
      this.networkBuffer.push(entry)
    }
    this.pendingNetworkRequests.clear()
    return [...this.networkBuffer]
  }

  clearNetworkBuffer(): void {
    this.networkBuffer = []
    this.pendingNetworkRequests.clear()
  }

  getNetworkBuffer(filter?: string): NetworkEntry[] {
    const all = [
      ...this.networkBuffer,
      ...this.pendingNetworkRequests.values(),
    ]
    if (!filter) return all
    const lower = filter.toLowerCase()
    return all.filter(e => e.url.toLowerCase().includes(lower))
  }

  // --- Elements ---

  async getComputedStyles(selector: string): Promise<Record<string, string>> {
    this.assertAttached()
    const tabId = this.tabId!

    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable')
    await chrome.debugger.sendCommand({ tabId }, 'CSS.enable')

    try {
      // Reason: depth=-1 ensures the full DOM tree is loaded so querySelector can find any node
      const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: -1 }) as
        { root: { nodeId: number } }
      const queryResult = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      }) as { nodeId: number }

      if (!queryResult.nodeId) {
        throw new Error(`No element found matching "${selector}"`)
      }

      const computed = await chrome.debugger.sendCommand({ tabId }, 'CSS.getComputedStyleForNode', {
        nodeId: queryResult.nodeId,
      }) as { computedStyle: Array<{ name: string; value: string }> }

      const keySet = new Set(KEY_STYLES)
      const result: Record<string, string> = {}
      for (const prop of computed.computedStyle) {
        if (keySet.has(prop.name)) {
          result[prop.name] = prop.value
        }
      }
      return result
    } finally {
      await chrome.debugger.sendCommand({ tabId }, 'CSS.disable').catch(() => {})
      await chrome.debugger.sendCommand({ tabId }, 'DOM.disable').catch(() => {})
    }
  }

  async getEventListeners(selector: string): Promise<Array<{
    type: string; handler: string; scriptId: string; lineNumber: number
  }>> {
    this.assertAttached()
    const tabId = this.tabId!

    // Reason: use Runtime.evaluate to get a RemoteObject reference to the element,
    // then pass the objectId to DOMDebugger.getEventListeners — this is the only
    // way to get listener info including handler source and script location
    const evalResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      objectGroup: 'sidekick-debug',
    }) as { result: { objectId?: string; type: string; subtype?: string } }

    if (!evalResult.result.objectId || evalResult.result.subtype === 'null') {
      throw new Error(`No element found matching "${selector}"`)
    }

    const listeners = await chrome.debugger.sendCommand({ tabId }, 'DOMDebugger.getEventListeners', {
      objectId: evalResult.result.objectId,
    }) as { listeners: Array<{
      type: string
      handler: { description?: string }
      scriptId: string
      lineNumber: number
    }> }

    // Reason: release the object reference to avoid memory leaks
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObjectGroup', {
      objectGroup: 'sidekick-debug',
    }).catch(() => {})

    return listeners.listeners.map(l => ({
      type: l.type,
      handler: (l.handler.description ?? '').slice(0, 200),
      scriptId: l.scriptId,
      lineNumber: l.lineNumber,
    }))
  }

  async getBoxModel(selector: string): Promise<{
    content: number[]; padding: number[]; border: number[]; margin: number[]
    width: number; height: number
  }> {
    this.assertAttached()
    const tabId = this.tabId!

    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable')
    try {
      const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: -1 }) as
        { root: { nodeId: number } }
      const queryResult = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      }) as { nodeId: number }

      if (!queryResult.nodeId) {
        throw new Error(`No element found matching "${selector}"`)
      }

      const box = await chrome.debugger.sendCommand({ tabId }, 'DOM.getBoxModel', {
        nodeId: queryResult.nodeId,
      }) as { model: { content: number[]; padding: number[]; border: number[]; margin: number[]; width: number; height: number } }
      const { content, padding, border, margin, width, height } = box.model
      return { content, padding, border, margin, width, height }
    } finally {
      await chrome.debugger.sendCommand({ tabId }, 'DOM.disable').catch(() => {})
    }
  }

  // --- Scripts ---

  async getScripts(filter?: string): Promise<ScriptInfo[]> {
    this.assertAttached()
    const tabId = this.tabId!

    const scripts: ScriptInfo[] = []

    // Reason: Debugger.enable emits scriptParsed for all already-loaded scripts,
    // collect them via a temporary listener, then disable to minimize overhead
    const collectPromise = new Promise<void>(resolve => {
      let settle: ReturnType<typeof setTimeout> | null = null
      let done = false
      const finish = () => {
        if (done) return
        done = true
        chrome.debugger.onEvent.removeListener(onEvent)
        clearTimeout(timeout)
        if (settle) clearTimeout(settle)
        resolve()
      }
      const timeout = setTimeout(finish, 2000)
      const onEvent = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
        if (source.tabId !== tabId || method !== 'Debugger.scriptParsed') return
        const p = params as { scriptId: string; url: string; startLine: number; endLine: number }
        if (p.url) scripts.push({ scriptId: p.scriptId, url: p.url, startLine: p.startLine, endLine: p.endLine })
        // Reason: pages with 100+ chunks replay scriptParsed in bursts — a fixed
        // 200ms window missed late events. Treat 300ms of silence as end-of-replay.
        if (settle) clearTimeout(settle)
        settle = setTimeout(finish, 300)
      }
      chrome.debugger.onEvent.addListener(onEvent)
      chrome.debugger.sendCommand({ tabId }, 'Debugger.enable').then(() => {
        if (!settle) settle = setTimeout(finish, 500)
      }).catch(finish)
    })

    await collectPromise
    await chrome.debugger.sendCommand({ tabId }, 'Debugger.disable').catch(() => {})

    if (!filter) return scripts
    const lower = filter.toLowerCase()
    return scripts.filter(s => s.url.toLowerCase().includes(lower))
  }

  async getScriptSource(scriptId: string): Promise<string> {
    this.assertAttached()
    const tabId = this.tabId!

    await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable')
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, 'Debugger.getScriptSource', {
        scriptId,
      }) as { scriptSource: string }
      return result.scriptSource
    } finally {
      await chrome.debugger.sendCommand({ tabId }, 'Debugger.disable').catch(() => {})
    }
  }

  // --- Performance ---

  async getPerformanceMetrics(): Promise<Record<string, number>> {
    this.assertAttached()
    const tabId = this.tabId!

    await chrome.debugger.sendCommand({ tabId }, 'Performance.enable')
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, 'Performance.getMetrics') as
        { metrics: Array<{ name: string; value: number }> }
      const metrics: Record<string, number> = {}
      for (const m of result.metrics) {
        metrics[m.name] = m.value
      }
      return metrics
    } finally {
      await chrome.debugger.sendCommand({ tabId }, 'Performance.disable').catch(() => {})
    }
  }

  // --- Inject ---

  async addScriptOnNewDocument(source: string): Promise<string> {
    this.assertAttached()
    const tabId = this.tabId!
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source }) as { identifier: string }
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: source, returnByValue: false,
    }).catch(() => {})
    return result.identifier
  }

  async removeScriptOnNewDocument(identifier: string): Promise<void> {
    this.assertAttached()
    const tabId = this.tabId!
    await chrome.debugger.sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {})
  }

  // --- Internal ---

  private assertAttached(): void {
    if (!this.attached || this.tabId === null) {
      throw new Error('Debugger not attached')
    }
  }

  private handleCdpEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.onConsoleAPICalled(params)
        break
      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(params)
        break
      case 'Network.responseReceived':
        this.onResponseReceived(params)
        break
      case 'Network.loadingFinished':
        this.onLoadingFinished(params)
        break
      case 'Network.loadingFailed':
        this.onLoadingFailed(params)
        break
      case 'Network.requestServedFromCache':
        this.onRequestServedFromCache(params)
        break
    }
  }

  private onConsoleAPICalled(params: Record<string, unknown>): void {
    if (!this.consoleListening) return
    const type = params.type as string
    const args = params.args as Array<{ type: string; value?: unknown; description?: string; subtype?: string; preview?: { properties?: Array<{ name: string; value?: string }> } }>
    const stackTrace = params.stackTrace as { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number; functionName?: string }> } | undefined

    const text = args.map(a => {
      if (a.value !== undefined) return String(a.value)
      return a.description ?? `[${a.type}]`
    }).join(' ')

    // Reason: capture full arg descriptions for Error objects, Arrays etc.
    const argDetails = args.map(a => {
      if (a.value !== undefined) return String(a.value)
      if (a.description) return a.description
      return `[${a.type}${a.subtype ? ':' + a.subtype : ''}]`
    })

    // Reason: include columnNumber in stack trace — critical for minified single-line files
    let stack: string | undefined
    if (stackTrace?.callFrames?.length) {
      stack = stackTrace.callFrames
        .slice(0, 5)
        .map(f => `  at ${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
        .join('\n')
    }

    this.consoleBuffer.push({
      level: type,
      text,
      timestamp: Date.now(),
      stackTrace: stack,
      args: argDetails,
    })
    if (this.consoleBuffer.length > MAX_BUFFER_SIZE) this.consoleBuffer.shift()
  }

  private onRequestWillBeSent(params: Record<string, unknown>): void {
    if (!this.networkListening) return
    const requestId = params.requestId as string
    const request = params.request as { url: string; method: string; headers?: Record<string, string>; postData?: string }

    // Reason: apply URL filter early to avoid buffering irrelevant requests
    if (this.networkFilter && !request.url.toLowerCase().includes(this.networkFilter.toLowerCase())) {
      return
    }

    // Reason: cap pending map to prevent unbounded growth from aborted/hung requests
    if (this.pendingNetworkRequests.size >= MAX_BUFFER_SIZE) {
      const oldest = this.pendingNetworkRequests.keys().next().value!
      this.pendingNetworkRequests.delete(oldest)
    }
    this.pendingNetworkRequests.set(requestId, {
      requestId,
      url: request.url,
      method: request.method,
      startTime: Date.now(),
      requestHeaders: request.headers,
      postData: request.postData,
    })
  }

  private onResponseReceived(params: Record<string, unknown>): void {
    if (!this.networkListening) return
    const requestId = params.requestId as string
    const response = params.response as { status: number; mimeType: string; headers?: Record<string, string> }
    const entry = this.pendingNetworkRequests.get(requestId)
    if (!entry) return

    entry.status = response.status
    entry.mimeType = response.mimeType
    entry.responseHeaders = response.headers
  }

  private onLoadingFinished(params: Record<string, unknown>): void {
    if (!this.networkListening) return
    const requestId = params.requestId as string
    const encodedDataLength = params.encodedDataLength as number
    const entry = this.pendingNetworkRequests.get(requestId)
    if (!entry) return

    entry.endTime = Date.now()
    entry.size = encodedDataLength
    this.networkBuffer.push(entry)
    if (this.networkBuffer.length > MAX_BUFFER_SIZE) this.networkBuffer.shift()
    this.pendingNetworkRequests.delete(requestId)
  }

  async getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean } | { error: string }> {
    if (!this.attached || !this.tabId) return { error: 'Debugger not attached' }
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Network.getResponseBody',
        { requestId },
      ) as { body: string; base64Encoded: boolean }
      return result
    } catch (e) {
      return { error: `Failed to get response body: ${(e as Error).message}` }
    }
  }

  private onRequestServedFromCache(params: Record<string, unknown>): void {
    if (!this.networkListening) return
    const requestId = params.requestId as string
    const entry = this.pendingNetworkRequests.get(requestId)
    if (entry) entry.fromCache = true
  }

  private onLoadingFailed(params: Record<string, unknown>): void {
    if (!this.networkListening) return
    const requestId = params.requestId as string
    const errorText = params.errorText as string
    const entry = this.pendingNetworkRequests.get(requestId)
    if (!entry) return

    entry.endTime = Date.now()
    entry.error = errorText
    this.networkBuffer.push(entry)
    if (this.networkBuffer.length > MAX_BUFFER_SIZE) this.networkBuffer.shift()
    this.pendingNetworkRequests.delete(requestId)
  }
}

export const debugSession = new DebugSession()
