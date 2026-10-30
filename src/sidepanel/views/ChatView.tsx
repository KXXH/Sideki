import ScheduledTaskStrip from "../components/ScheduledTaskStrip";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import AnimatedPopover from "../components/AnimatedPopover";
import { Icon } from "@iconify/react";
import {
  iconAlertCircle,
  iconClose,
  iconLoading,
  iconCrosshairs,
  iconTextBox,
  iconChevronDown,
  iconWeb,
  iconTimer,
  iconProNetwork,
  iconProMagnify,
  iconProConsole,
  iconPlus,
  iconAutoFix,
  iconPin,
  iconPinOff,
  iconImage,
  iconFileDocument,
} from "../../shared/icons";
import SessionBar from "../components/SessionBar";
import ProBackground from "../components/ProBackground";
import DebugToolbar from "../components/DebugToolbar";
import TodoStrip from "../components/TodoStrip";
import QueueStrip from "../components/QueueStrip";
import {
  EmptyState,
  MessageBubble,
  ContextMeter,
} from "../components/MessageList";
import { ACTION_PROMPTS, CHAT_EMPTY_STATE, PRO_EMPTY_STATE } from "../empty-state-suggestions";
import AttachmentPreview from "../components/AttachmentPreview";
import ComposerActions from "../components/ComposerActions";
import ChatComposer from "../components/ChatComposer";
import PermissionModeSwitcher from "../components/PermissionModeSwitcher";
import ModelSwitcher from "../components/ModelSwitcher";
import { EmptyContextMeter } from "../components/ContextMeter";
import { useElementPicker } from "../hooks/useElementPicker";
import { useSidekickChat, COMPACT_MSG_ID } from "../hooks/useSidekickChat";
import { findPageForReply } from "../../shared/message-protocol";
import { t } from "../../shared/i18n";
import type { UIMessage } from "ai";
import type { PageContent } from "../../shared/types";
import { skillRegistry } from "../../shared/skills";
import { getMyWindowId } from "../App";
import { derivePhase } from "../status-phase";
import { projectMessages } from "../message-display";

export interface CustomAction {
  label: string
  prompt: string
}

const CUSTOM_ACTIONS_KEY = 'customActions'

const CHAT_ACTIONS = [
  { label: "总结页面", icon: iconTextBox, prompt: ACTION_PROMPTS.summary },
  { label: "提取链接", icon: iconWeb, prompt: ACTION_PROMPTS.links },
  { label: "整理标签页", icon: iconProConsole, prompt: ACTION_PROMPTS.tabs },
  { label: "整理书签", icon: iconProMagnify, prompt: ACTION_PROMPTS.bookmarks },
];

const PRO_ACTIONS = [
  { label: "性能分析", icon: iconTimer, prompt: ACTION_PROMPTS.performance },
  { label: "网络抓包", icon: iconProNetwork, prompt: ACTION_PROMPTS.network },
  { label: "SEO 检查", icon: iconProMagnify, prompt: ACTION_PROMPTS.seo },
];

// Reason: strip fallback for pages without a title — show the host rather than
// a bare url or "No page".
function hostLabel(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

interface Props {
  pageInfo: { title: string; url: string } | null;
  pageContent: PageContent | null;
  activeTabId: number | null;
  extractContent: () => Promise<PageContent>;
  extracting: boolean;
  proMode: boolean;
  contextLocked: boolean;
  onToggleContextLock: () => void;
  onOpenSettings: () => void;
}

export default function ChatView({
  pageInfo,
  pageContent,
  activeTabId,
  extractContent,
  proMode,
  contextLocked,
  onToggleContextLock,
  onOpenSettings,
}: Props) {
  // Reason: kernel host switch — read once + follow changes; drives whether
  // the hook runs the agent locally or mirrors the offscreen kernel.
  const [kernelHost, setKernelHost] = useState<'panel' | 'offscreen'>('offscreen')
  useEffect(() => {
    chrome.storage.local.get('sidekick_config').then(r => {
      const host = (r.sidekick_config as { labKernelHost?: 'panel' | 'offscreen' } | undefined)?.labKernelHost
      setKernelHost(host === 'panel' ? 'panel' : 'offscreen')
    }).catch(() => {})
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (!changes.sidekick_config) return
      const next = (changes.sidekick_config.newValue as { labKernelHost?: 'panel' | 'offscreen' } | undefined)?.labKernelHost
      setKernelHost(next === 'panel' ? 'panel' : 'offscreen')
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const {
    messages,
    status,
    preparing,
    dispatching,
    connecting,
    error: chatError,
    clearError: clearChatError,
    stop,
    sendMessage,
    queue,
    removeQueued,
    takeQueued,
    handleRegenerate,
    sessions,
    activeId,
    handleSelectSession,
    handleNewSession,
    handleDeleteSession,
    handleRenameSession,
    tokenUsage,
    contextWindow,
    contextLoaded,
    contextPageInfo,
    contextRemote,
    contextState,
    compacting,
    compactNow,
    config,
    permissionMode,
    setPermissionMode,
    approvalState,
    relayedIds,
    debugStatusRef,
  } = useSidekickChat(pageInfo, pageContent, activeTabId, extractContent, proMode, contextLocked, kernelHost);

  const [input, setInput] = useState("");
  const [uiError, setUiError] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const draftRef = useRef({ input, activeId });
  draftRef.current = { input, activeId };
  const [stopping, setStopping] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [customActions, setCustomActions] = useState<CustomAction[]>([]);

  // Reason: handleRegenerate's identity changes with messages — route through
  // a ref so memoized bubbles keep one stable callback across patch frames.
  const regenRef = useRef(handleRegenerate);
  useEffect(() => { regenRef.current = handleRegenerate; });
  const onRegenerateStable = useCallback((id: string) => regenRef.current(id), []);

  useEffect(() => {
    chrome.storage.local.get(CUSTOM_ACTIONS_KEY).then(data => {
      setCustomActions(data[CUSTOM_ACTIONS_KEY] ?? [])
    })
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[CUSTOM_ACTIONS_KEY]) setCustomActions(changes[CUSTOM_ACTIONS_KEY].newValue ?? [])
    }
    chrome.storage.local.onChanged.addListener(handler)
    return () => chrome.storage.local.onChanged.removeListener(handler)
  }, [])
  const [historyEntries, setHistoryEntries] = useState<
    Array<{
      compressedMessages: Array<{
        id: string;
        role: string;
        parts: Array<{ type: string; text?: string }>;
      }>;
      marker: { summary: string; timestamp: number };
    }>
  >([]);

  // Reason: load history from session storage for HistoryMessages rendering
  useEffect(() => {
    if (!activeId) {
      setHistoryEntries([]);
      return;
    }
    const key = `history:${activeId}`;
    chrome.storage.local
      .get(key)
      .then((data) => setHistoryEntries(data[key] ?? []));
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[key]) setHistoryEntries(changes[key].newValue ?? []);
    };
    chrome.storage.local.onChanged.addListener(handler);
    return () => chrome.storage.local.onChanged.removeListener(handler);
  }, [activeId]);
  const {
    isPicking,
    attachments,
    error: pickerError,
    startPicker,
    removeAttachment,
    clearError: clearPickerError,
    setAttachments,
  } = useElementPicker();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const [topBarH, setTopBarH] = useState(64);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [bottomBarH, setBottomBarH] = useState(94);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [skillMenuIdx, setSkillMenuIdx] = useState(-1);

  // Reason: right-click "添加到 Sidekick 上下文" + in-chat selection float
  const addTextToContext = useCallback((text: string) => {
    setAttachments(prev => [...prev, {
      croppedImage: '',
      domSnapshot: text,
      label: `选中文本 (${text.length} 字)`,
    }])
  }, [setAttachments])

  const processImageFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let w = img.width, h = img.height
        if (w > 800) { h = Math.round(h * (800 / w)); w = 800 }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
        setAttachments(prev => [...prev, { croppedImage: dataUrl, domSnapshot: '', label: file.name || '粘贴图片' }])
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }, [setAttachments])

  const processBinaryFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      // Reason: latin1 byte string is the VFS binary convention. readAsDataURL
      // (what processImageFile uses) would hand us base64, and that path also
      // re-encodes through a canvas — both destroy the original bytes.
      const bytes = new Uint8Array(reader.result as ArrayBuffer)
      let latin1 = ''
      for (let i = 0; i < bytes.length; i += 8192) {
        latin1 += String.fromCharCode(...bytes.subarray(i, i + 8192))
      }
      setAttachments(prev => [...prev, {
        croppedImage: '',
        domSnapshot: '',
        label: file.name,
        file: { name: file.name, mime: file.type || 'application/octet-stream', latin1 },
      }])
    }
    reader.readAsArrayBuffer(file)
  }, [setAttachments])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean) as File[]
    if (files.length === 0) return
    e.preventDefault()
    files.forEach(f => processImageFile(f))
  }, [processImageFile])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach(f => processImageFile(f))
    e.target.value = ''
  }, [processImageFile])

  const handleDocSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach(f => processBinaryFile(f))
    e.target.value = ''
  }, [processBinaryFile])

  useEffect(() => {
    const handler = (message: { type: string; text?: string; windowId?: number }): undefined => {
      if (message.windowId && message.windowId !== getMyWindowId()) return undefined
      if (message.type === 'context:add' && message.text) {
        addTextToContext(message.text)
      }
      return undefined
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [addTextToContext])

  const [manualHeight, setManualHeight] = useState<number | null>(null)
  const dragState = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current) return
      const delta = dragState.current.startY - e.clientY
      const next = Math.max(32, Math.min(300, dragState.current.startH + delta))
      setManualHeight(next)
    }
    const onUp = () => { dragState.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  useEffect(() => {
    const el = bottomBarRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setBottomBarH(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = topBarRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setTopBarH(entry.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const attachPopoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!attachMenuOpen) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (attachMenuRef.current?.contains(t) || attachPopoverRef.current?.contains(t)) return
      setAttachMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [attachMenuOpen])

  const [selFloat, setSelFloat] = useState<{ x: number; y: number; text: string } | null>(null)
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onMouseUp = () => {
      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text || text.length < 2) { setSelFloat(null); return }
      const range = sel!.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) { setSelFloat(null); return }
      const rect = range.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      setSelFloat({ x: Math.min(rect.right - containerRect.left, containerRect.width - 100), y: rect.top - containerRect.top - 32, text })
    }
    // Reason: mousedown on container clears immediately; document-level selectionchange
    // catches clicks outside the container (input bar, header, etc.) that collapse the selection.
    const onMouseDown = () => setSelFloat(null)
    const onSelectionChange = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed) setSelFloat(null)
    }
    container.addEventListener('mouseup', onMouseUp)
    container.addEventListener('mousedown', onMouseDown)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => { container.removeEventListener('mouseup', onMouseUp); container.removeEventListener('mousedown', onMouseDown); document.removeEventListener('selectionchange', onSelectionChange) }
  }, [scrollRef.current]) // eslint-disable-line react-hooks/exhaustive-deps

  const skillSuggestions = useMemo(() => {
    if (!input.startsWith("/")) return [];
    const query = input.slice(1).toLowerCase();
    const mode = proMode ? "pro" : "chat";
    return Array.from(skillRegistry.values()).filter(
      (s) =>
        (s.mode === "all" || s.mode === mode) &&
        (s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query)),
    );
  }, [input, proMode]);

  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    const minH = manualHeight ?? 32
    el.style.height = Math.max(minH, Math.min(el.scrollHeight, manualHeight ?? 128)) + "px";
  }, [manualHeight]);

  const isStreaming =
    status === "streaming" || status === "submitted" || preparing || compacting;
  const turnRunning = status === "streaming" || status === "submitted" || preparing;
  const replyPhase = derivePhase({ status, preparing, dispatching, trailing: "none" });
  const displayItems = useMemo(
    () => projectMessages(messages, activeId, replyPhase),
    [messages, activeId, replyPhase],
  );
  const error = uiError || (chatError ? String(chatError) : "") || pickerError;

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  // Reason: programmatic smooth scrolling keeps emitting onScroll events at
  // intermediate positions. Ignoring them until scrollend prevents the list
  // from being marked "not at bottom" mid-animation, which would skip re-pins
  // when the composer or content grows.
  const programmaticRef = useRef(false)
  const programmaticTimerRef = useRef<number | undefined>(undefined)
  const userScrollUntilRef = useRef(0)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    programmaticRef.current = true
    window.clearTimeout(programmaticTimerRef.current)
    // Reason: scrollend never fires when scrollTo does not move the viewport
    // (already at the bottom), so a timeout keeps the guard from sticking.
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticRef.current = false
    }, behavior === 'smooth' ? 1500 : 120)
    el.scrollTo({
      top: el.scrollHeight,
      behavior,
    })
    setIsAtBottom(true)
  }, [])

  const handleScroll = useCallback(() => {
    if (programmaticRef.current) return
    if (performance.now() < userScrollUntilRef.current) return
    setIsAtBottom(checkAtBottom());
  }, [checkAtBottom]);

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const endProgrammatic = () => {
      programmaticRef.current = false
      window.clearTimeout(programmaticTimerRef.current)
    }

    // Reason: wheel/touch intent must win over the guard, otherwise scrolling
    // up during streaming gets overridden by the next auto-follow.
    const detach = () => {
      endProgrammatic()
      userScrollUntilRef.current = performance.now() + 200
      setIsAtBottom(false)
      window.setTimeout(() => {
        if (performance.now() < userScrollUntilRef.current) return
        setIsAtBottom(checkAtBottom())
      }, 220)
    }

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && el.scrollTop > 0) detach()
    }
    // Reason: scrollbar drags target the scroll element itself, not a child.
    const onPointerDown = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const onScrollbar = e.clientX >= rect.left + el.clientWidth - 6
      if (e.target === el && onScrollbar) detach()
    }
    let touchStartY = 0
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      if ((e.touches[0]?.clientY ?? 0) - touchStartY > 4 && el.scrollTop > 0) detach()
    }

    el.addEventListener('scrollend', endProgrammatic)
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      el.removeEventListener('scrollend', endProgrammatic)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      window.clearTimeout(programmaticTimerRef.current)
    }
  }, [checkAtBottom])

  const bottomInset = bottomBarH + 16 + (isStreaming || sending ? 0 : 34)

  useEffect(() => {
    if (isAtBottom) scrollToBottom();
  }, [messages, bottomInset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reason: streamdown memoizes intermediate blocks, so messages ref may not
  // change even as content height grows (e.g. code blocks, tables expanding).
  // ResizeObserver catches these layout shifts and keeps scroll pinned.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !isStreaming) return
    const ro = new ResizeObserver(() => {
      if (isAtBottom) scrollToBottom()
    })
    ro.observe(el.firstElementChild || el)
    return () => ro.disconnect()
  }, [isStreaming, isAtBottom, scrollToBottom]);

  useEffect(() => {
    setIsAtBottom(true);
    requestAnimationFrame(() => scrollToBottom());
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!turnRunning) setStopping(false);
  }, [turnRunning]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyT') { e.preventDefault(); handleNewSession() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleNewSession])

  const handleSend = useCallback(
    async (quickPrompt?: string, sendOpts?: { fromBridge?: boolean }) => {
      const trimmed = (quickPrompt ?? input).trim();
      if ((!trimmed && attachments.length === 0) || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      setUiError("");
      try {
        let text = trimmed;
        let skill: { name: string; content: string } | undefined;
        if (trimmed.startsWith("/")) {
          const name = trimmed.slice(1).split(/\s+/)[0];
          const { getSkillContent } = await import("../../shared/skills");
          const content = getSkillContent(name, [], proMode ? "pro" : "chat");
          if (content) {
            text = trimmed.slice(1 + name.length).trim();
            skill = { name, content };
          }
        }
        if (draftRef.current.activeId !== activeId) throw new Error("会话已切换，发送已取消；输入和附件已保留");
        // Reason: only upload/acceptance blocks the composer; an active agent can still queue this send.
        await sendMessage(text, attachments.length > 0 ? attachments : undefined, { ...sendOpts, ...(skill ? { skill } : {}) });
        if (draftRef.current.activeId === activeId) {
          if (quickPrompt === undefined && draftRef.current.input === input) {
            setInput(prev => prev === input ? "" : prev);
            setManualHeight(null);
            if (textareaRef.current) textareaRef.current.style.height = "";
          }
          setAttachments(prev => prev.filter(a => !attachments.includes(a)));
        }
        requestAnimationFrame(() => scrollToBottom());
      } catch (error) {
        setUiError(error instanceof Error ? error.message : String(error));
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [input, attachments, activeId, sendMessage, setAttachments, scrollToBottom, proMode],
  );

  // Reason: "move back to input" — queued item becomes an editable draft again
  const handleRecallQueued = useCallback((id: string) => {
    const item = takeQueued(id);
    if (!item) return;
    const text = item.opts?.skill
      ? `/${item.opts.skill.name}${item.text ? " " + item.text : ""}`
      : item.text;
    setInput(prev => [prev, text].filter(Boolean).join('\n'));
    if (item.attachments?.length) {
      setAttachments(prev => [...prev, ...item.attachments!]);
    }
    textareaRef.current?.focus();
  }, [takeQueued, setAttachments]);

  const selectSkill = useCallback((name: string) => {
    setInput(`/${name}`);
    setSkillMenuIdx(-1);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (skillSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSkillMenuIdx((prev) => (prev + 1) % skillSuggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSkillMenuIdx((prev) =>
            prev <= 0 ? skillSuggestions.length - 1 : prev - 1,
          );
          return;
        }
        if (e.key === "Tab" || e.key === "Enter") {
          // Reason: Enter confirms the highlighted suggestion (first item by
          // default) instead of sending a half-typed command as plain text.
          // Exception: input already holds an exact skill name — let Enter send it.
          const typed = input.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
          const isExact = skillSuggestions.some((s) => s.name.toLowerCase() === typed);
          if (!(e.key === "Enter" && isExact && skillMenuIdx < 0)) {
            e.preventDefault();
            const idx = skillMenuIdx >= 0 ? skillMenuIdx : 0;
            selectSkill(skillSuggestions[idx].name);
            return;
          }
        }
        if (e.key === "Escape") {
          setInput("");
          setSkillMenuIdx(-1);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, skillSuggestions, skillMenuIdx, selectSkill, input],
  );

  // Reason: CC sends natural language via bridge — just send as if user typed it
  useEffect(() => {
    if (!proMode) return;
    const handler = (message: { type: string; text?: string }): undefined => {
      if (message.type !== "bridge:message" || !message.text) return undefined;
      // Reason: bridge origin is carried as metadata.source — expandForModel
      // prepends the [from:claude-code] tag for the AI, UI shows a badge.
      handleSend(message.text, { fromBridge: true });
      return undefined;
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [proMode, handleSend]);

  const emptySession = messages.length === 0 && historyEntries.length === 0;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <ProBackground active={proMode} />

      {/* Reason: scroll area fills entire container so content passes behind
         both top and bottom glass bars — makes backdrop-blur visible. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          paddingTop: topBarH + 8,
          paddingBottom: bottomInset,
          // Reason: sticky children (the viz error banner) must stop below the
          // opaque floating top bar, whose height is measured at runtime.
          '--chat-top-bar-height': `${topBarH}px`,
        } as React.CSSProperties}
        className="relative h-full overflow-y-auto overflow-x-hidden overscroll-y-contain"
      >
        {emptySession ? (
          <EmptyState
            key={`${activeId ?? "new"}:${proMode ? "pro" : "chat"}`}
            deck={proMode ? PRO_EMPTY_STATE : CHAT_EMPTY_STATE}
            pageHost={hostLabel(contextPageInfo?.url || pageInfo?.url)}
            onSend={handleSend}
          />
        ) : (
          <div className="chat-column flex flex-col gap-4 py-4">
            {/* HistoryMessages — compressed-out messages, display only */}
            {historyEntries.length > 0 && (
              <>
                {historyExpanded &&
                  historyEntries.map((entry, ei) => (
                    <div key={`hist-${ei}`}>
                      {entry.compressedMessages
                        .filter((msg) => msg.id !== COMPACT_MSG_ID)
                        .map((msg) => (
                          <div key={msg.id} className="opacity-40">
                            <MessageBubble
                              message={msg as UIMessage}
                              toolCallDisplay={config?.toolCallDisplay}
                              isStreaming={false}
                              isLast={false}
                            />
                          </div>
                        ))}
                      <div className="flex items-center gap-2 py-2 text-[10px] text-text-muted">
                        <div className="flex-1 border-t border-border-muted" />
                        <span>
                          上下文已压缩 ·{" "}
                          {new Date(
                            entry.marker.timestamp,
                          ).toLocaleTimeString()}
                        </span>
                        <div className="flex-1 border-t border-border-muted" />
                      </div>
                    </div>
                  ))}
                <button
                  onClick={() => setHistoryExpanded(!historyExpanded)}
                  className="flex items-center gap-2 self-center rounded-[var(--radius-2xl)] border border-border-subtle px-3 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-raised"
                >
                  {historyExpanded
                    ? "▾ 收起历史消息"
                    : `▸ 查看已压缩的 ${historyEntries.reduce((n, e) => n + e.compressedMessages.length, 0)} 条消息`}
                </button>
              </>
            )}
            {displayItems.map(({ key, message: msg, sourceIndex: i }, displayIndex) => {
              if (msg?.id === COMPACT_MSG_ID) {
                return (
                  <div
                    key={key}
                    className="flex items-center gap-2 py-1 text-[10px] text-text-muted"
                  >
                    <div className="flex-1 border-t border-accent/20" />
                    <span className="text-accent/50">上下文已压缩</span>
                    <div className="flex-1 border-t border-accent/20" />
                  </div>
                );
              }
              return (
                <MessageBubble
                  key={key}
                  message={msg}
                  toolCallDisplay={config?.toolCallDisplay}
                  approvalState={approvalState}
                  isStreaming={
                    isStreaming &&
                    i === messages.length - 1 &&
                    msg?.role === "assistant"
                  }
                  isLast={displayIndex === displayItems.length - 1}
                  pendingPhase={msg === null ? replyPhase : undefined}
                  onRegenerate={onRegenerateStable}
                  pageRef={
                    msg?.role === "assistant"
                      ? findPageForReply(messages, i)
                      : null
                  }
                  fromBridge={
                    msg?.role === "user" &&
                    ((msg.metadata as { source?: string } | undefined)?.source ===
                      "claude-code" ||
                      (
                        msg.parts.find((p) => p.type === "text")?.text ?? ""
                      ).startsWith("[from:claude-code]"))
                  }
                  relayedToCC={
                    msg !== null && (
                      relayedIds.current.has(msg.id) ||
                      (msg.metadata as { relayed?: boolean } | undefined)
                        ?.relayed === true ||
                      (msg.role === "assistant" &&
                        (
                          msg.parts.find((p) => p.type === "text")?.text ?? ""
                        ).includes("[relayed:claude-code]"))
                    )
                  }
                  sessionId={activeId}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Top bar — opaque band, with a soft blur seam into the scroll area */}
      <div
        ref={topBarRef}
        onPointerMove={proMode ? (e) => {
          const bar = e.currentTarget
          const rect = bar.getBoundingClientRect()
          bar.style.setProperty('--glow-x', `${e.clientX - rect.left}px`)
          bar.style.setProperty('--glow-opacity', '1')
        } : undefined}
        onPointerLeave={proMode ? (e) => {
          e.currentTarget.style.setProperty('--glow-opacity', '0')
        } : undefined}
        className={`chat-top-bar ${proMode ? "pro-bar-glow" : ""}`}
      >
        <div className="px-[var(--chat-gutter)]">
        <div className="flex items-start gap-2 pb-1.5 pt-0.5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <SessionBar
                  sessions={sessions}
                  activeId={activeId}
                  onSelect={handleSelectSession}
                  onDelete={handleDeleteSession}
                  onRename={handleRenameSession}
                />
              </div>
            </div>
            <div className="mt-0.5 min-w-0 truncate text-[10px] text-text-muted" title={contextPageInfo?.title || contextPageInfo?.url || undefined}>
              {contextPageInfo?.title || hostLabel(contextPageInfo?.url) || "未绑定页面"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <ScheduledTaskStrip key={`schedule:${activeId}`} sessionId={activeId} proMode={proMode} />
            <button
              onClick={onToggleContextLock}
              aria-label={contextState === 'locked' ? t.unlockContext : contextState === 'held' ? (contextRemote ? t.contextElsewhere : t.contextHeld) : t.lockContext}
              title={contextState === 'locked' ? t.unlockContext : contextState === 'held' ? (contextRemote ? t.contextElsewhere : t.contextHeld) : t.lockContext}
              aria-pressed={contextState === 'locked'}
              className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${contextState === 'locked' ? 'bg-accent text-on-accent' : contextState === 'held' ? 'text-accent hover:bg-accent-wash' : 'text-text-muted hover:bg-surface-overlay hover:text-text-secondary'}`}
            >
              <Icon icon={contextState === 'free' ? iconPinOff : iconPin} className="text-xs" />
            </button>
            <button onClick={handleNewSession} aria-label="新建会话" title="新建会话" className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-wash text-accent ring-1 ring-inset ring-accent/20 transition-colors hover:bg-accent/15">
              <Icon icon={iconPlus} className="text-sm" />
            </button>
          </div>
        </div>
        {proMode && <DebugToolbar debugStatusRef={debugStatusRef} />}
        </div>
        <div className="chat-top-fade" aria-hidden="true" />
      </div>

      {/* Scroll-to-bottom */}
      {!isAtBottom && messages.length > 0 && (
        <div style={{ bottom: bottomInset }} className="pointer-events-none absolute inset-x-0 z-30 flex justify-center">
          <div className="flex w-full justify-end px-[var(--chat-gutter)]">
            <button
              onClick={() => scrollToBottom('smooth')}
              aria-label="滚动到底部"
              title="滚动到底部"
              className="theme-overlay pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-all hover:bg-surface/50 hover:text-text-secondary"
            >
              <Icon icon={iconChevronDown} className="text-sm" />
            </button>
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div style={{ bottom: bottomInset + (!isAtBottom && messages.length > 0 ? 40 : 0) }} className="pointer-events-none absolute inset-x-0 z-30 flex justify-center">
          <div className="pointer-events-auto w-full px-[var(--chat-gutter)]">
            <div className="flex items-center gap-2 rounded-lg border border-error/20 bg-error/10 backdrop-blur-[var(--theme-blur)] px-3 py-2">
              <Icon
                icon={iconAlertCircle}
                className="shrink-0 text-xs text-error/70"
              />
              <p className="flex-1 text-[11px] text-error/80">{error}</p>
              <button
                onClick={() => {
                  setUiError("");
                  clearChatError();
                  clearPickerError();
                }}
                className="text-error/50 hover:text-error"
              >
                <Icon icon={iconClose} className="text-xs" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Selection float — "add to context" */}
      {selFloat && (
        <button
          onClick={() => { addTextToContext(selFloat.text); window.getSelection()?.removeAllRanges(); setSelFloat(null) }}
          style={{ left: selFloat.x, top: selFloat.y }}
          className="theme-raised absolute z-30 flex items-center gap-1 rounded-[var(--radius-2xl)] border border-border-subtle bg-surface-raised/95 px-2 py-1 text-[10px] text-text-secondary backdrop-blur-sm transition-all hover:border-accent/40 hover:text-accent"
        >
          <Icon icon={iconPlus} className="text-xs" />
          添加上下文
        </button>
      )}

      {/* Reason: a sibling of the input shelf, not a child — the shelf's
          backdrop-filter creates a backdrop root that would void the chips' blur. */}
      {!isStreaming && !sending && (
        <div
          style={{ bottom: bottomBarH + 6 }}
          className="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
        >
          <div className="pointer-events-auto flex w-full gap-1.5 overflow-x-auto px-[var(--chat-gutter)] pb-2">
          {(proMode ? PRO_ACTIONS : CHAT_ACTIONS).map((qa) => (
            <button
              key={qa.label}
              onClick={() => handleSend(qa.prompt)}
              className="quick-chip flex shrink-0 items-center gap-1 rounded-[var(--radius-2xl)] px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
            >
              <Icon icon={qa.icon} className="text-xs" />
              {qa.label}
            </button>
          ))}
          {customActions.map((ca) => (
            <button
              key={`custom-${ca.label}`}
              onClick={() => handleSend(ca.prompt)}
              className="quick-chip flex shrink-0 items-center gap-1 rounded-[var(--radius-2xl)] px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
            >
              <Icon icon={iconAutoFix} className="text-xs" />
              {ca.label}
            </button>
          ))}
          </div>
        </div>
      )}

      {/* Bottom input — tinted glass overlay */}
      <div ref={bottomBarRef} className="absolute inset-x-0 bottom-0 z-10">
        <div>
        <div className="px-[var(--chat-gutter)]"><TodoStrip key={activeId} sessionId={activeId} /></div>
        <div className="glass-shelf glass-edge-t relative z-[1] px-[var(--chat-gutter)] pb-2 shadow-[inset_0_1px_0_var(--color-accent-wash)]">
        {/* Drag handle */}
        <div
          onMouseDown={e => {
            const h = textareaRef.current?.offsetHeight ?? 32
            dragState.current = { startY: e.clientY, startH: h }
          }}
          className="group flex cursor-ns-resize items-center justify-center py-1"
        >
          <div className="h-[3px] w-8 rounded-full bg-text-muted/20 transition-colors group-hover:bg-text-muted/40 group-active:bg-accent/50" />
        </div>

        <QueueStrip queue={queue} onRemove={removeQueued} onRecall={handleRecallQueued} />
        <ChatComposer
          proMode={proMode}
          attachments={attachments.length > 0 && (
          <AttachmentPreview
            attachments={attachments}
            onRemove={removeAttachment}
          />
        )}
          beforeInput={<>
{/* Reason: composer stays mounted while the agent works — sends are
              queued by the hook; only the quick-action row yields the space. */}
          {compacting && (
            <div className="flex items-center justify-center gap-1.5 rounded-lg border border-accent/20 bg-accent-wash/30 py-1 text-[11px] text-accent">
              <Icon icon={iconLoading} className="animate-spin text-xs" />
              压缩上下文中…
            </div>
          )}
          {skillSuggestions.length > 0 && (
            <div className="mb-1.5 border-b border-border-muted pb-1">
              {skillSuggestions.map((skill, i) => (
                <button
                  key={skill.name}
                  onClick={() => {
                    selectSkill(skill.name);
                  }}
                  className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${i === skillMenuIdx ? "bg-accent/12 text-accent" : "hover:bg-surface-overlay"}`}
                >
                  <span className="text-[11px] font-medium text-text-primary">
                    /{skill.name}
                  </span>
                  <span className="truncate text-[10px] text-text-muted">
                    {skill.description}
                  </span>
                </button>
              ))}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileSelect} />
          <input ref={docInputRef} type="file" multiple className="hidden" onChange={handleDocSelect} />
          </>}
          input={{
              ref: textareaRef,
              value: input,
              onChange: (e) => {
                setInput(e.target.value);
                autoResize(e.target);
                setSkillMenuIdx(-1);
              },
              onKeyDown: handleKeyDown,
              onPaste: handlePaste,
              style: {
                ...(manualHeight ? { minHeight: manualHeight, maxHeight: manualHeight } : {}),
              },
          }}
          attachmentControl={<div ref={attachMenuRef} className="shrink-0">
              <button
                onClick={() => setAttachMenuOpen(v => !v)}
                style={{ anchorName: '--attach-btn' } as React.CSSProperties}
                aria-label="添加附件"
                aria-expanded={attachMenuOpen}
                aria-haspopup="menu"
                className={`-ml-1 flex h-7 w-7 items-center justify-center rounded-md transition-all duration-200 ${attachMenuOpen ? 'bg-accent-wash text-accent' : 'text-text-muted hover:bg-surface-overlay hover:text-accent'}`}
                title="附件"
              >
                <Icon icon={iconPlus} className={`text-base transition-transform duration-200 ${attachMenuOpen ? 'rotate-45' : ''}`} />
              </button>
              <AnimatedPopover open={attachMenuOpen} direction="up"
                  ref={attachPopoverRef}
                  style={{
                    positionAnchor: '--attach-btn',
                    bottom: 'anchor(top)',
                    left: 'anchor(left)',
                  } as React.CSSProperties}
                  className="theme-overlay fixed z-50 mb-2 flex flex-col gap-1 rounded-lg p-1"
                >
                  <button
                    onClick={() => { startPicker(); setAttachMenuOpen(false) }}
                    disabled={isPicking}
                    className="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-surface-overlay hover:text-accent disabled:opacity-50"
                  >
                    <Icon icon={iconCrosshairs} className={`text-sm ${isPicking ? 'animate-pulse-glow text-accent' : ''}`} />
                    选择元素
                  </button>
                  <button
                    onClick={() => { fileInputRef.current?.click(); setAttachMenuOpen(false) }}
                    className="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-surface-overlay hover:text-accent"
                  >
                    <Icon icon={iconImage} className="text-sm" />
                    上传图片
                  </button>
                  <button
                    onClick={() => { docInputRef.current?.click(); setAttachMenuOpen(false) }}
                    className="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-surface-overlay hover:text-accent"
                  >
                    <Icon icon={iconFileDocument} className="text-sm" />
                    上传文件
                  </button>
                </AnimatedPopover>
            </div>}
          modelControls={<>
{connecting ? (
                <>

                  <span role="status" className="flex shrink-0 items-center gap-1">
                    <Icon icon={iconLoading} className="animate-spin text-[10px]" />
                    连接内核中…
                  </span>
                </>
              ) : config ? (
                <>

                  <ModelSwitcher
                    direction="up"
                    config={config}
                    disabled={status === "streaming" || status === "submitted" || compacting || sending}
                    onOpenSettings={onOpenSettings}
                  />
                  <PermissionModeSwitcher
                    value={permissionMode}
                    onChange={setPermissionMode}
                    disabled={!activeId || sending || stopping}
                  />
                </>
              ) : null}
              {(contextLoaded || pageContent) && contextWindow > 0 ? (
                <ContextMeter
                  direction="up"
                  used={tokenUsage.tokens}
                  total={contextWindow}
                  exact={tokenUsage.exact}
                  onCompact={compactNow}
                  compacting={compacting}
                  canCompact={status === 'ready' && !sending && messages.length > 2}
                />
              ) : (
                <EmptyContextMeter />
              )}
          </>}
          actions={<>
<span className="sr-only" role="status">{stopping ? '正在停止…' : sending ? '准备发送…' : turnRunning ? '正在回复…' : compacting ? '压缩上下文中…' : 'Enter 发送 · Shift+Enter 换行'}</span>
            <ComposerActions
              running={turnRunning}
              stopping={stopping}
              sending={sending}
              hasDraft={Boolean(input.trim() || attachments.length)}
              onSend={() => handleSend()}
              onStop={() => {
                  setStopping(true);
                  void Promise.resolve(stop()).catch(error => {
                    setStopping(false);
                    setUiError(error instanceof Error ? error.message : String(error));
                  });
              }}
            />
          </>}
        />
        </div>
        </div>
      </div>
    </div>
  );
}
