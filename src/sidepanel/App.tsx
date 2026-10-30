import { useState, useCallback, useEffect, useRef } from 'react'
import Header from './components/Header'
import ChatView from './views/ChatView'
import SettingsView from './views/SettingsView'
import DevView from './views/DevView'
import UpdateIntro from './components/UpdateIntro'
import { useUpdateIntro } from './hooks/use-update-intro'
import { parsePageContent } from '../shared/parser'
import { applyTheme, applyFont, applyProMode, applyColorMode } from '../shared/themes'
import { loadConfig as loadCfg, saveConfig } from '../shared/storage'
import { ActionConsentDialog, DebuggerConsentDialog, ProModeWarningDialog } from './components/ConsentDialogs'
import type { PageContent } from '../shared/types'
import { loadUserSkills } from '../shared/skills'
import { setLockedTabId } from '../shared/tools/bridge'

let myWindowId: number | null = null
export function getMyWindowId() { return myWindowId }

type View = 'chat' | 'settings' | 'dev'

interface DebuggerRequest {
  hostname: string
  resolve: (granted: boolean) => void
}

interface ActionRequest {
  action: string
  detail: string
  origin?: string
  resolve: (granted: boolean, alwaysAllow?: boolean) => void
}

export default function App() {
  const updateIntro = useUpdateIntro()
  const [view, setView] = useState<View>('chat')
  const [pageContent, setPageContent] = useState<PageContent | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [pageInfo, setPageInfo] = useState<{ title: string; url: string } | null>(null)
  const [proMode, setProMode] = useState(false)
  const [devMode, setDevMode] = useState(false)
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [debuggerRequest, setDebuggerRequest] = useState<DebuggerRequest | null>(null)
  const [actionRequest, setActionRequest] = useState<ActionRequest | null>(null)
  const [contextLocked, setContextLocked] = useState(false)
  const contextLockedRef = useRef(false)
  contextLockedRef.current = contextLocked
  const lockedTabIdRef = useRef<number | null>(null)
  const debuggerRequestRef = useRef(debuggerRequest)
  debuggerRequestRef.current = debuggerRequest
  const actionRequestRef = useRef(actionRequest)
  actionRequestRef.current = actionRequest

  useEffect(() => {
    chrome.windows.getCurrent().then(w => { myWindowId = w.id ?? null })
    loadCfg().then(c => {
      applyColorMode(c?.colorMode || 'system')
      applyTheme(c?.accentColor)
      applyFont(c?.fontFamily || 'sans', c?.fontSize || 'default')
      if (c?.devMode) setDevMode(true)
    })
    loadUserSkills()
    // Reason: reload user skills when created/deleted from service worker
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.userSkills) loadUserSkills()
    }
    chrome.storage.local.onChanged.addListener(onStorageChanged)
    return () => chrome.storage.local.onChanged.removeListener(onStorageChanged)
  }, [])

  useEffect(() => {
    const handler = (
      message: { type: string; hostname?: string; action?: string; detail?: string; windowId?: number; origin?: string },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: { granted: boolean; alwaysAllow?: boolean }) => void,
    ) => {
      if (message.windowId && message.windowId !== myWindowId) return
      if (message.type === 'request-debugger-consent' && message.hostname) {
        setDebuggerRequest({
          hostname: message.hostname,
          resolve: (granted: boolean) => {
            sendResponse({ granted })
            setDebuggerRequest(null)
          },
        })
        return true
      }
      if (message.type === 'request-action-consent' && message.action) {
        setActionRequest(prev => {
          if (prev) prev.resolve(false)
          return {
            action: message.action!,
            detail: message.detail ?? '',
            origin: message.origin,
            resolve: (granted: boolean, alwaysAllow?: boolean) => {
              sendResponse({ granted, alwaysAllow: alwaysAllow === true })
              setActionRequest(null)
            },
          }
        })
        return true
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => {
      chrome.runtime.onMessage.removeListener(handler)
      actionRequestRef.current?.resolve(false)
    }
  }, [])

  const fetchCurrentTab = useCallback(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      console.log('[SidePanel] fetchCurrentTab:', tab?.title?.slice(0, 40), tab?.url?.slice(0, 60))
      if (tab) {
        setPageInfo({ title: tab.title ?? '', url: tab.url ?? '' })
        if (tab.id) setActiveTabId(tab.id)
      }
    } catch { /* tabs API may fail */ }
  }, [])

  useEffect(() => {
    fetchCurrentTab()
    const handler = (message: { type: string; windowId?: number }): undefined => {
      if (message.windowId && message.windowId !== myWindowId) return undefined
      if (message.type === 'tab-changed') {
        if (contextLockedRef.current) return undefined
        console.log('[SidePanel] received tab-changed, fetching new tab info...')
        fetchCurrentTab()
        setPageContent(null)
      }
      return undefined
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [fetchCurrentTab])

  // Reason: if the locked tab is closed, auto-unlock to prevent dead tool executions.
  // Also track URL/title changes on the locked tab (e.g. AI uses navigate command)
  // so the page-info strip stays current.
  useEffect(() => {
    const onRemoved = (tabId: number) => {
      if (lockedTabIdRef.current === tabId) {
        setLockedTabId(null)
        lockedTabIdRef.current = null
        setContextLocked(false)
        fetchCurrentTab()
      }
    }
    const onUpdated = (tabId: number, changeInfo: { url?: string; title?: string }) => {
      if (!lockedTabIdRef.current || lockedTabIdRef.current !== tabId) return
      if (!changeInfo.url && !changeInfo.title) return
      chrome.tabs.get(tabId).then(tab => {
        setPageInfo({ title: tab.title ?? '', url: tab.url ?? '' })
      }).catch(() => {})
    }
    chrome.tabs.onRemoved.addListener(onRemoved)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      chrome.tabs.onRemoved.removeListener(onRemoved)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [fetchCurrentTab])

  const toggleContextLock = useCallback(() => {
    if (contextLocked) {
      setLockedTabId(null)
      lockedTabIdRef.current = null
      setContextLocked(false)
      fetchCurrentTab()
    } else {
      setLockedTabId(activeTabId)
      lockedTabIdRef.current = activeTabId
      setContextLocked(true)
    }
  }, [contextLocked, activeTabId, fetchCurrentTab])

  const [showProWarning, setShowProWarning] = useState(false)

  const activateProMode = useCallback(async () => {
    setProMode(true)
    applyProMode(true)
    if (activeTabId) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'pro:attach', tabId: activeTabId })
        if (!resp?.success) {
          console.warn('[Pro] debugger attach failed:', resp?.error)
          // Reason: Don't block Pro mode activation — debugger auto-attaches on first debug command
        }
      } catch (e) {
        console.warn('[Pro] debugger attach error:', e)
      }
    }
  }, [activeTabId])

  const deactivateProMode = useCallback(async () => {
    setProMode(false)
    applyProMode(false)
    chrome.runtime.sendMessage({ type: 'pro:detach' }).catch(() => {})
  }, [])

  const handleProModeChange = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const cfg = await loadCfg()
      if (!cfg?.proModeAccepted) {
        setShowProWarning(true)
        return
      }
      await activateProMode()
    } else {
      await deactivateProMode()
    }
  }, [activateProMode, deactivateProMode])

  const handleProWarningAccept = useCallback(async () => {
    setShowProWarning(false)
    const cfg = await loadCfg()
    if (cfg) await saveConfig({ ...cfg, proModeAccepted: true })
    await activateProMode()
  }, [activateProMode])

  const extractContent = useCallback(async (): Promise<PageContent> => {
    if (pageContent) return pageContent

    setExtracting(true)
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error('No active tab found')

      const response = await chrome.runtime.sendMessage({
        type: 'extract-content',
        tabId: tab.id,
      })
      if (!response?.success) throw new Error(response?.error ?? 'Failed to extract page content')

      const parsed = parsePageContent(response.data)
      setPageContent(parsed)
      return parsed
    } finally {
      setExtracting(false)
    }
  }, [pageContent])

  return (
    <div className="flex h-screen flex-col bg-surface text-text-primary select-none">
      <Header activeView={view} onViewChange={setView} proMode={proMode} onProModeChange={handleProModeChange} devMode={devMode} seamless={view === 'chat'} />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={view === 'chat' ? 'contents' : 'hidden'}>
          <ChatView
            pageInfo={pageInfo}
            pageContent={pageContent}
            activeTabId={activeTabId}
            extractContent={extractContent}
            extracting={extracting}
            proMode={proMode}
            contextLocked={contextLocked}
            onToggleContextLock={toggleContextLock}
            onOpenSettings={() => setView('settings')}
          />
        </div>
        {view === 'settings' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SettingsView onShowUpdateIntro={updateIntro.replay} onShowOnboarding={updateIntro.replayOnboarding} onBack={() => {
              setView('chat')
              loadCfg().then(c => { if (c) setDevMode(!!c.devMode) })
            }} />
          </div>
        )}
        {view === 'dev' && <DevView tabId={activeTabId} />}
      </main>

      <UpdateIntro kind={updateIntro.kind} open={updateIntro.open && !debuggerRequest && !actionRequest && !showProWarning} onClose={updateIntro.dismiss} devMode={devMode} />

        <DebuggerConsentDialog
          open={!!debuggerRequest}
          hostname={debuggerRequest?.hostname ?? ''}
          onAllow={() => debuggerRequest?.resolve(true)}
          onDeny={() => debuggerRequest?.resolve(false)}
        />
        <ActionConsentDialog
          open={!!actionRequest}
          action={actionRequest?.action ?? ''}
          detail={actionRequest?.detail ?? ''}
          origin={actionRequest?.origin}
          onAllow={(alwaysAllow) => actionRequest?.resolve(true, alwaysAllow)}
          onDeny={() => actionRequest?.resolve(false)}
        />
        <ProModeWarningDialog
          open={showProWarning}
          onAccept={handleProWarningAccept}
          onCancel={() => setShowProWarning(false)}
        />
    </div>
  )
}
