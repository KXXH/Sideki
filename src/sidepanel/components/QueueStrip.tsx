import { Icon } from "@iconify/react";
import { useState } from 'react';
import { iconClose, iconChevronDown } from "../../shared/icons";
import iconListOrdered from '@iconify-icons/lucide/list-ordered';
import type { QueuedMessage } from "../hooks/useSidekickChat";

function queuedLabel(q: QueuedMessage): string {
  const skill = q.opts?.skill ? `/${q.opts.skill.name} ` : "";
  const att = q.attachments?.length ? `[${q.attachments.length} 个附件] ` : "";
  return `${skill}${att}${q.text}`.trim() || "(空消息)";
}

// Queued messages waiting for the agent to finish the current turn.
// Click a row to move it back into the input for editing; ✕ removes it.
export default function QueueStrip({
  queue,
  onRemove,
  onRecall,
}: {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  onRecall: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (queue.length === 0) return null;

  return (
    <div className="mb-2 text-[11px]">
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-text-secondary hover:text-text-primary">
        <Icon icon={iconListOrdered} className="shrink-0 text-xs text-text-muted" />
        <span>待发送 {queue.length} 条</span>
        <span className="ml-auto text-[10px] text-text-muted">{expanded ? '收起' : '查看 / 编辑'}</span>
        <Icon icon={iconChevronDown} className={`shrink-0 text-xs text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && <div className="mt-1 max-h-40 overflow-y-auto border-y border-border-muted py-1">
      <p className="px-1 pb-1 text-[10px] text-text-muted">当前回复结束后依次发送；点击消息取回编辑</p>
      {queue.map((q, i) => (
        <div
          key={q.id}
          className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-overlay/50"
        >
          <span
            className={`shrink-0 text-[10px] ${i === 0 ? "text-text-secondary" : "text-text-muted/50"}`}
          >
            {i + 1}
          </span>
          <button
            onClick={() => onRecall(q.id)}
            title="取回输入框编辑"
            className={`min-w-0 flex-1 truncate text-left text-[11px] transition-colors hover:text-accent ${i === 0 ? "text-text-secondary" : "text-text-muted"}`}
          >
            {queuedLabel(q)}
          </button>
          <button
            onClick={() => onRemove(q.id)}
            title="移除"
            aria-label={`移除排队消息：${queuedLabel(q)}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-overlay hover:text-error"
          >
            <Icon icon={iconClose} className="text-xs" />
          </button>
        </div>
      ))}
      </div>}
    </div>
  );
}
