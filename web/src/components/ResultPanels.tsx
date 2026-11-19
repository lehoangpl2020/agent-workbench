import { Download, ExternalLink, File, FileImage, FileText, ImageOff, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Iteration, IterationArtifact, RunDetail } from "@/lib/api";
import { formatBytes, formatMs, isImage, iterationStatus } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TerminalBlock } from "./CodeView";

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border bg-card p-4 sm:p-5", className)}>{children}</div>;
}

function Waiting({ text }: { text: string }) {
  return (
    <Panel>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" /> {text}
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    </Panel>
  );
}

/** The current action of this iteration (if the run is at that iteration), otherwise a default text. */
function currentAction(run: RunDetail, iteration: Iteration, fallback: string) {
  return run.status === "running" && run.activity_iteration === iteration.number && run.activity
    ? run.activity
    : fallback;
}

function NoIteration() {
  return (
    <Panel className="text-sm text-muted-foreground">Select a step in the journey to see its details.</Panel>
  );
}

// ─── Logs ──────────────────────────────────────────
/** stdout/stderr + exit code of one iteration (collapsible area below the activity log). */
export function ProcessOutputPanel({ run, iteration }: { run: RunDetail; iteration: Iteration | null }) {
  if (!iteration) return <NoIteration />;
  if (iteration.status === "planning") return <Waiting text="Nothing has run yet — waiting for the model's code." />;
  if (iteration.status === "executing") {
    return <Waiting text={`${currentAction(run, iteration, "Running…")} — logs appear when the process exits.`} />;
  }
  if (iteration.exit_code === null) {
    return <Panel className="text-sm text-muted-foreground">No process result was recorded for this iteration.</Panel>;
  }
  const stats = [
    { label: "Exit code", value: String(iteration.exit_code), bad: iteration.exit_code !== 0 },
    { label: "Execution time", value: formatMs(iteration.execution_time_ms) },
    { label: "Timed out", value: iteration.timed_out ? "Yes" : "No", bad: iteration.timed_out },
    { label: "Status", value: iterationStatus(iteration.status).label },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[11px] text-muted-foreground">{s.label}</div>
            <div className={cn("font-mono text-sm font-medium", s.bad && "text-destructive")}>{s.value}</div>
          </div>
        ))}
      </div>
      <TerminalBlock label="stdout" text={iteration.stdout} />
      <TerminalBlock label="stderr" text={iteration.stderr} tone="error" />
    </div>
  );
}

// ─── Files ─────────────────────────────────────────
export function FilesPanel({ run, iteration }: { run: RunDetail; iteration: Iteration | null }) {
  if (run.artifacts.length === 0) {
    return (
      <Panel className="flex flex-col items-center gap-2 py-10 text-center">
        <ImageOff className="size-6 text-muted-foreground" />
        <div className="text-sm font-medium">No files yet</div>
        <p className="max-w-sm text-xs text-muted-foreground">
          Files the code saves to <code className="font-mono">/workspace/output</code> appear here, separate for each run.
        </p>
      </Panel>
    );
  }
  const changedNow = new Set(iteration?.artifacts.map((a) => a.path) ?? []);
  return <ArtifactList files={run.artifacts} changed={changedNow} iteration={iteration?.number}
    caption="Latest version of every file in this run's output folder" />;
}

export function ArtifactList({ files, changed, iteration, caption, thumbnails }: {
  files: (IterationArtifact & { download_url?: string; iteration?: number | null })[];
  changed?: Set<string>; iteration?: number; caption: string; thumbnails?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-2.5 text-xs text-muted-foreground">
        {caption}
      </div>
      <ul className="divide-y">
        {files.map((a) => {
          const Icon = isImage(a.mime) ? FileImage : a.mime.startsWith("text/") ? FileText : File;
          return (
            <li key={a.path} className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:flex-nowrap">
              {thumbnails && a.snapshot_available !== false && isImage(a.mime)
                ? <a href={a.url} target="_blank" rel="noreferrer" aria-label={`Preview ${a.path}`}>
                    <img src={a.url} alt={a.path} loading="lazy" className="checker size-14 rounded border object-contain" />
                  </a>
                : <Icon className="size-4 shrink-0 text-primary" />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{a.path}</div>
                <div className="text-[11px] text-muted-foreground">
                  {formatBytes(a.size)} · {a.mime}
                  {a.iteration && <> · last changed in code run {a.iteration}</>}
                </div>
              </div>
              {changed?.has(a.path) && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground">
                  changed in code run {iteration}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {a.snapshot_available === false ? <span className="text-xs text-muted-foreground">Snapshot unavailable</span> : <>
                <a href={a.url} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Open">
                  <ExternalLink className="size-4" />
                </a>
                <a href={a.download_url ?? `${a.url}&download=1`} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted">
                  <Download className="size-3.5" /> Download
                </a>
                </>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
