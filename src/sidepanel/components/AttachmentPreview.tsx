import { Icon } from "@iconify/react";
import { iconClose, iconQuote, iconFileDocument } from "../../shared/icons";
import type { ElementAttachment } from "../../shared/types";

interface Props {
  attachments: ElementAttachment[];
  onRemove: (index: number) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AttachmentPreview({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null;

  return (
    <div className="animate-fade-in-up mb-1.5">
      <div className="flex flex-wrap gap-1.5 pb-0.5">
        {attachments.map((att, i) => {
          // Reason: text-only attachments carry content in domSnapshot — preview it instead of the generic label
          const isText = !att.croppedImage;
          const text = att.file
            ? `${att.file.name} · ${formatSize(att.file.latin1.length)}`
            : isText && att.domSnapshot ? att.domSnapshot : att.label || "图片";
          return (
            <div
              key={i}
              title={att.label}
              className="group flex h-9 max-w-full items-center gap-1.5 overflow-hidden rounded-lg border border-border-muted bg-surface pl-1 pr-1"
            >
              {isText ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-overlay/50">
                  <Icon
                    icon={att.file ? iconFileDocument : iconQuote}
                    className="text-sm text-text-secondary"
                  />
                </div>
              ) : (
                <img
                  src={att.croppedImage}
                  alt={att.label}
                  className="h-7 w-7 shrink-0 rounded-md bg-surface-overlay/50 object-cover"
                />
              )}
              <p className="min-w-0 max-w-[180px] truncate text-[11px] text-text-secondary">
                {text}
              </p>
              <button
                onClick={() => onRemove(i)}
                aria-label={`移除附件：${att.file?.name || att.label || '图片'}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-overlay hover:text-error"
              >
                <Icon icon={iconClose} className="text-[9px]" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
