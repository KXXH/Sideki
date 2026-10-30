import { useEffect } from 'react'
import AppDialog, { DialogAction } from './AppDialog'

export function DebuggerConsentDialog({ open, hostname, onAllow, onDeny }: {
  open: boolean; hostname: string; onAllow: () => void; onDeny: () => void
}) {
  return <AppDialog open={open} title="调试器授权" onClose={onDeny} footer={<>
    <DialogAction onClick={onDeny}>拒绝</DialogAction><DialogAction variant="primary" onClick={onAllow}>允许本次操作</DialogAction>
  </>}>
    <p className="text-xs leading-relaxed text-text-secondary"><span className="font-mono text-text-primary">{hostname}</span> 禁止内联脚本执行。是否允许 Sideki 使用 Chrome 调试器执行操作？页面顶部会出现调试提示条。</p>
  </AppDialog>
}

const ACTION_LABELS: Record<string, string> = {
  click: '点击元素', type: '输入文本', scroll: '滚动页面', navigate: '页面导航', js: '执行 JavaScript',
  wait: '等待', hover: '悬停', select: '选择', keypress: '按键', 'tab-switch': '切换标签页',
  'tab-new': '新开标签页', 'tab-close': '关闭标签页', 'bookmark-add': '添加收藏', 'bookmark-rm': '删除收藏',
}

export function ActionConsentDialog({ open, action, detail, origin, onAllow, onDeny }: {
  open: boolean; action: string; detail: string; origin?: string; onAllow: (alwaysAllow: boolean) => void; onDeny: () => void
}) {
  const label = ACTION_LABELS[action] ?? action
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      chrome.notifications.create(`consent-${Date.now()}`, {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'Sideki — 操作待确认',
        message: `${label}: ${detail || '(无详情)'}`.slice(0, 200), priority: 2,
      })
    }, 10000)
    return () => clearTimeout(timer)
  }, [open, action, detail, label])

  return <AppDialog open={open} title={label || '操作确认'} onClose={onDeny} footer={<div className="flex w-full flex-col gap-3">
    <div className="flex gap-2.5"><DialogAction onClick={onDeny}>拒绝</DialogAction><DialogAction variant="primary" onClick={() => onAllow(false)}>允许本次操作</DialogAction></div>
    {origin && <button type="button" onClick={() => onAllow(true)} className="rounded-md py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-overlay">在 {new URL(origin).hostname} 上不再询问</button>}
  </div>}>
    <p className="mb-3 text-xs text-text-muted">AI 请求执行以下操作</p>
    <pre className="whitespace-pre-wrap break-all rounded-lg border border-border-subtle bg-surface p-3 font-mono text-xs leading-relaxed">{detail || '(无详情)'}</pre>
  </AppDialog>
}

export function ProModeWarningDialog({ open, onAccept, onCancel }: { open: boolean; onAccept: () => void; onCancel: () => void }) {
  return <AppDialog open={open} title="激活 Pro 模式" onClose={onCancel} footer={<>
    <DialogAction onClick={onCancel}>取消</DialogAction><DialogAction variant="primary" onClick={onAccept}>我理解风险，激活</DialogAction>
  </>}>
    <div className="space-y-4 text-xs leading-relaxed">
      <div><p className="mb-2 font-medium">Pro 模式将解锁：</p><ul className="space-y-1 text-text-secondary">
        <li>• Chrome DevTools 调试器（持久连接）</li><li>• 网络请求抓包与分析</li><li>• JS 控制台实时监听</li><li>• 页面性能指标采集</li><li>• 元素计算样式与事件检查</li>
      </ul></div>
      <div className="rounded-lg border border-error/20 bg-error/5 p-3"><p className="mb-2 font-medium text-error">风险提示：</p><ul className="space-y-1 text-text-secondary">
        <li>• AI 将拥有极高执行权限，所有操作确认将被跳过</li><li>• 调试器黄条将持续显示在页面顶部</li><li>• 若连接 Claude Code，AI 可影响本地文件系统</li>
      </ul></div>
    </div>
  </AppDialog>
}
