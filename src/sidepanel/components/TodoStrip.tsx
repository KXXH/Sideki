import { useState, useEffect } from "react";
import { Icon } from "@iconify/react";
import { iconCheck, iconChevronDown } from "../../shared/icons";
import iconListChecks from "@iconify-icons/lucide/list-checks";

export interface TodoItem {
  id: number;
  text: string;
  status: string;
}

// Reason: single source of truth is /todo.json in the session VFS — broadcasts
// are incremental, so we fetch once on mount to catch up. The parent remounts
// this component per session via key={sessionId}.
async function fetchTodos(sessionId: string): Promise<TodoItem[]> {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "dev:cat",
      sessionId,
      path: "/todo.json",
    });
    return resp?.content ? (JSON.parse(resp.content) as TodoItem[]) : [];
  } catch {
    return [];
  }
}

export default function TodoStrip({ sessionId }: { sessionId: string }) {
  const [todos, setTodos] = useState<TodoItem[]>([]);

  useEffect(() => {
    let alive = true;
    if (sessionId)
      fetchTodos(sessionId).then((items) => {
        if (alive) setTodos(items);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    // Reason: todo:changed carries no sessionId — only the active session's
    // shell executes commands, so the broadcast always refers to it.
    const handler = (msg: { type?: string; items?: TodoItem[] }): undefined => {
      if (msg.type === "todo:changed" && msg.items) setTodos(msg.items);
      return undefined;
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  return <TodoStripContent todos={todos} />;
}

export function TodoStripContent({ todos }: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const pending = total - done;
  const current =
    todos.find((t) => t.status === "in_progress") ??
    todos.find((t) => t.status === "pending");

  // Reason: flash a success state only on a live transition to all-done —
  // a list already fully completed on mount is stale and stays hidden.
  // State adjustment during render per react.dev "adjusting state when props change".
  const [prevPending, setPrevPending] = useState(pending);
  if (pending !== prevPending) {
    setPrevPending(pending);
    if (pending === 0 && prevPending > 0 && total > 0) {
      setCelebrating(true);
      setExpanded(false);
    }
  }

  useEffect(() => {
    if (!celebrating) return;
    const t = setTimeout(() => setCelebrating(false), 2200);
    return () => clearTimeout(t);
  }, [celebrating]);

  const visible = total > 0 && (pending > 0 || celebrating);
  if (!visible) return null;

  const allDone = pending === 0;
  const icons: Record<string, string> = {
    completed: "✓",
    in_progress: "▶",
    pending: "○",
  };
  const colors: Record<string, string> = {
    completed: "text-success/70",
    in_progress: "text-accent",
    pending: "text-text-muted/50",
  };

  return (
    <div className="relative z-0 mx-2 -mb-3">
      {/* Reason: grid-rows 1fr→0fr collapses height in sync with the fade,
          so unmount causes no layout jump */}
      <div
        className={`grid transition-all duration-700 ease-out ${celebrating ? "mb-0 grid-rows-[0fr] opacity-0 delay-[1300ms]" : "mb-1 grid-rows-[1fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="overflow-hidden rounded-t-xl border border-b-0 border-border-subtle bg-surface-overlay pb-4">
      {/* Expanded task list — sits above the header row, opens upward in place */}
      <div className={`expand-panel ${expanded ? "is-open" : ""}`}>
        <div className="overflow-hidden">
          <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto border-b border-border-subtle px-3 py-2">
            {todos.map((t) => (
              <div
                key={t.id}
                className="flex items-start gap-1.5 text-[11px] leading-snug"
              >
                <span
                  className={`${colors[t.status] || "text-text-muted/50"} w-3 shrink-0 text-center text-[9px] leading-[1.6]`}
                >
                  {icons[t.status] || "○"}
                </span>
                <span
                  className={
                    t.status === "completed"
                      ? "text-text-muted/50 line-through"
                      : t.status === "in_progress"
                        ? "text-text-primary"
                        : "text-text-secondary"
                  }
                >
                  {t.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Header row */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? '收起任务计划' : '展开任务计划'}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-raised/30"
      >
        <Icon
          icon={allDone ? iconCheck : iconListChecks}
          className={`shrink-0 text-xs transition-colors ${allDone ? "text-success" : "text-accent"}`}
        />
        <span
          className={`flex-1 truncate text-[11px] transition-colors ${allDone ? "text-success/90" : "text-text-secondary"}`}
        >
          {allDone ? "全部完成" : current?.text}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">
          {done}/{total}
        </span>
        <Icon
          icon={iconChevronDown}
          className={`shrink-0 text-xs text-text-muted/60 transition-transform duration-200 ${expanded ? "" : "rotate-180"}`}
        />
      </button>

      <div className="relative mx-3 h-[3px] overflow-hidden rounded-full bg-border-subtle">
        <div
          className={`absolute inset-y-0 left-0 transition-[width] duration-500 ease-out ${allDone ? "bg-success" : "bg-accent"}`}
          style={{
            width: `${total > 0 ? (done / total) * 100 : 0}%`,
          }}
        />
      </div>
      </div>
        </div>
      </div>
    </div>
  );
}
