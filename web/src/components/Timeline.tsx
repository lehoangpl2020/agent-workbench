import { AlertTriangle, Brain, CheckCheck, CheckCircle2, Clock, Cog, FileImage, Loader2, OctagonX, XCircle } from "lucide-react";
import type { Iteration, RunDetail } from "@/lib/api";
import { formatMs, iterationStatus, TONE_CLASSES } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  planning: Brain,
  executing: Cog,
  succeeded: CheckCircle2,
  failed: XCircle,
  timed_out: Clock,
  done: CheckCheck,
  stopped: OctagonX,
  error: AlertTriangle,
};

interface Props {
  run: RunDetail;
  selected: number | null;
  onSelect: (n: number) => void;
}

/**
 * Mỗi iteration = 1 lần gọi model (+ 1 lần chạy code nếu model chưa báo DONE).
 * max_iterations = số lần chạy code tối đa; có thể có thêm 1 iteration "final review" không chạy code.
 */
export function Timeline({ run, selected, onSelect }: Props) {
  const runsUsed = run.iterations.filter((it) => it.exit_code !== null).length;
  const remaining = run.status === "running" ? Math.max(0, run.max_iterations - runsUsed) : 0;

  return (
    <ol className="relative space-y-2">
      {run.iterations.length === 0 && run.status === "running" && (
        <li className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" /> Starting…
        </li>
      )}
      {run.iterations.length === 0 && run.status !== "running" && (
        <li className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No iterations recorded.</li>
      )}
      {run.iterations.map((it) => (
        <TimelineItem key={it.number} it={it} max={run.max_iterations} active={selected === it.number} onSelect={onSelect} />
      ))}
      {remaining > 0 && (
        <li className="px-3 text-xs text-muted-foreground">
          Up to {remaining} more code run{remaining === 1 ? "" : "s"} available
        </li>
      )}
    </ol>
  );
}

function TimelineItem({ it, max, active, onSelect }: { it: Iteration; max: number; active: boolean; onSelect: (n: number) => void }) {
  const baseMeta = iterationStatus(it.status);
  // Khi đang gọi model: nói rõ model được gọi để làm gì
  const planningLabel =
    it.code.length > 0
      ? `Writing code · ${it.code.length.toLocaleString()} chars`
      : it.intent === "fix"
        ? "Fixing error"
        : it.intent === "review"
          ? "Deciding: DONE or continue"
          : "Generating code";
  const meta = it.status === "planning" ? { ...baseMeta, label: planningLabel } : baseMeta;
  const live = it.status === "planning" || it.status === "executing";
  const Icon = live ? Loader2 : (ICON[it.status] ?? AlertTriangle);
  const images = it.artifacts.filter((a) => a.mime.startsWith("image/")).length;

  return (
    <li>
      <button
        onClick={() => onSelect(it.number)}
        className={cn(
          "w-full rounded-lg border bg-card p-3 text-left transition",
          active ? "border-primary/50 ring-2 ring-primary/15" : "hover:border-primary/30 hover:bg-muted/40",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            Iteration {it.number}
            {it.number > max && <span className="font-normal"> · final review</span>}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
              TONE_CLASSES[meta.tone],
            )}
          >
            <Icon className={cn("size-3", live && "animate-spin")} />
            {meta.label}
          </span>
        </div>
        {it.intent === "fix" && it.intent_detail && (
          <p className="mt-1.5 line-clamp-2 rounded bg-danger-soft px-1.5 py-1 font-mono text-[11px] leading-snug text-destructive">
            Fixing: {it.intent_detail}
          </p>
        )}
        {it.intent === "review" && it.status !== "done" && it.status !== "planning" && (
          <p className="mt-1.5 text-[12px] text-muted-foreground">Previous output reviewed → model chose another step</p>
        )}
        {it.explanation && it.status !== "done" && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-foreground/85">{it.explanation}</p>
        )}
        {it.status === "done" && (
          <p className="mt-1.5 text-[13px] leading-snug text-foreground/85">
            Reviewed the previous output — the request is satisfied.
          </p>
        )}
        {it.status === "planning" && !it.code && (
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {it.intent === "review" ? "Model is reading the output…" : "Waiting for the model…"}
          </p>
        )}
        {(it.exit_code !== null || images > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            {it.exit_code !== null && (
              <span className={cn(it.exit_code !== 0 && "text-destructive")}>exit {it.exit_code}</span>
            )}
            {it.execution_time_ms !== null && <span>{formatMs(it.execution_time_ms)}</span>}
            {it.false_success && <span className="text-warning">output looked like an error</span>}
            {images > 0 && (
              <span className="inline-flex items-center gap-1">
                <FileImage className="size-3" />
                {images} image{images === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
      </button>
    </li>
  );
}
