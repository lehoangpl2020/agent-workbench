import { CheckCircle2, CircleSlash, Clock, Loader2, OctagonX, RotateCcw, XCircle } from "lucide-react";
import type { RunStatus } from "@/lib/api";
import { RUN_STATUS, TONE_CLASSES, type Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICONS: Record<RunStatus, React.ComponentType<{ className?: string }>> = {
  pending: Clock,
  running: Loader2,
  success: CheckCircle2,
  error: XCircle,
  stopped: OctagonX,
  timeout: Clock,
  max_retries: RotateCcw,
};

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const meta = RUN_STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  const Icon = ICONS[status] ?? CircleSlash;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-xs border px-2 text-xs font-semibold whitespace-nowrap",
        TONE_CLASSES[meta.tone],
        className,
      )}
    >
      <Icon className={cn("size-3.5", status === "running" && "animate-spin text-brand")} aria-hidden />
      {meta.label}
    </span>
  );
}
