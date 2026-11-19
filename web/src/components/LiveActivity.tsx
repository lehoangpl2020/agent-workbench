import { useEffect, useState } from "react";
import { Brain, ClipboardCheck, Cog, FileSearch, Package, PenLine, RotateCw, Wrench } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

// Who is working: the model (waiting for the LLM) or the runtime (the application running/checking by itself).
// Shows only observable actions + data, never the model's reasoning.
const ICONS: Record<string, typeof Brain> = {
  write: Brain, fix: Wrench, review: FileSearch, streaming: PenLine,
  executing: Cog, installing: Package, install_failed: Package,
  rerunning: RotateCw, collecting: FileSearch, checking: ClipboardCheck,
};

const ACTOR: Record<string, "model" | "sandbox"> = {
  write: "model", fix: "model", review: "model", streaming: "model",
  executing: "sandbox", installing: "sandbox", install_failed: "sandbox", rerunning: "sandbox", collecting: "sandbox",
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** The "what is happening now" bar, always visible while a run is active. Data comes from runs.activity (backend events). */
export function LiveActivity({ run }: { run: RunDetail }) {
  const now = useNow(true);
  const actor = ACTOR[run.activity_phase];
  const Icon = ICONS[run.activity_phase] ?? Cog;
  const since = run.activity_at ? Math.max(0, Math.round((now - new Date(run.activity_at).getTime()) / 1000)) : null;
  const iteration = run.activity_iteration ?? (run.iterations.length || null);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t bg-accent/40 px-4 py-2.5 sm:px-5" aria-live="polite">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase",
          actor === "model" ? "bg-[var(--model-soft)] text-[var(--model)]" : actor === "sandbox" ? "bg-[var(--sandbox-soft)] text-[var(--sandbox)]" : "bg-primary/10 text-primary",
        )}
      >
        {actor === "model" ? "Model" : actor === "sandbox" ? "Sandbox" : "Runtime"}
      </span>
      {iteration && (
        <span className="text-xs font-medium text-muted-foreground">
          Model call {iteration}{iteration > run.max_iterations && " · final review"}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
        <Icon className={cn("size-4 shrink-0 text-primary", run.activity_phase === "executing" && "animate-spin [animation-duration:2.5s]")} />
        <span className="min-w-0 break-words">{run.activity || "Starting…"}</span>
      </span>
      {since !== null && <span className="font-mono text-xs text-muted-foreground tabular-nums">{since}s</span>}
    </div>
  );
}
