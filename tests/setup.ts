import { vi } from 'vitest'

const chromeMock = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
      getBytesInUse: vi.fn().mockResolvedValue(0),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com', title: 'Test', active: true, groupId: -1 }]),
    get: vi.fn().mockImplementation(async (id: number) => ({ id, status: 'complete', url: 'https://example.com', title: 'Test' })),
    update: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ id: 2 }),
    remove: vi.fn().mockResolvedValue(undefined),
    captureVisibleTab: vi.fn().mockResolvedValue('data:image/jpeg;base64,abc'),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  tabGroups: { query: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  runtime: {
    sendMessage: vi.fn().mockResolvedValue({ granted: true }),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    lastError: null,
    // Reason: pdf open builds the reader URL via chrome.runtime.getURL
    getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
    id: 'test-extension-id',
  },
  declarativeNetRequest: {
    getDynamicRules: vi.fn().mockResolvedValue([]),
    updateDynamicRules: vi.fn().mockResolvedValue(undefined),
  },
  scripting: { executeScript: vi.fn().mockResolvedValue([{ result: { success: true } }]) },
  debugger: {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn() },
  },
  bookmarks: { search: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: '1', title: 'test' }), remove: vi.fn().mockResolvedValue(undefined), getTree: vi.fn().mockResolvedValue([]) },
  history: { search: vi.fn().mockResolvedValue([]) },
  downloads: { search: vi.fn().mockResolvedValue([]) },
  topSites: { get: vi.fn().mockResolvedValue([]) },
  alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
  sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined), open: vi.fn().mockResolvedValue(undefined) },
  action: { onClicked: { addListener: vi.fn() } },
  windows: { update: vi.fn().mockResolvedValue(undefined) },
  webNavigation: {
    onCommitted: { addListener: vi.fn() },
    getAllFrames: vi.fn().mockResolvedValue([]),
    onCreatedNavigationTarget: { addListener: vi.fn() },
  },
}

vi.stubGlobal('chrome', chromeMock)
vi.stubGlobal('WebSocket', vi.fn())

const locks = new Map<string, Promise<unknown>>()
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: {
    request(name: string, callback: () => unknown) {
      const next = (locks.get(name) ?? Promise.resolve()).then(callback)
      locks.set(name, next.catch(() => {}))
      return next
    },
  },
})
