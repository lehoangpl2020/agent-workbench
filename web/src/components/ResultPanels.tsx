import { Download, ExternalLink, File, FileImage, FileText, ImageOff, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Iteration, IterationArtifact, RunDetail } from "@/lib/api";
import { formatBytes, formatMs, isImage, iterationStatus } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TerminalBlock } from "./CodeView";
import { FILE_ACTION, NOTE } from "./styles";

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("surface p-4 sm:p-5", className)}>{children}</div>;
}

// These states render inside other surfaces (inspector, process output), so they are quiet blocks, not more boxes.
function Waiting({ text }: { text: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-brand" aria-hidden /> {text}
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
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
    <p className={NOTE}>Select a step in the journey to see its details.</p>
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
    return <p className={NOTE}>No process result was recorded for this iteration.</p>;
  }
  const stats = [
    { label: "exit", value: String(iteration.exit_code), bad: iteration.exit_code !== 0 },
    { label: "time", value: formatMs(iteration.execution_time_ms) },
    { label: "timed out", value: iteration.timed_out ? "yes" : "no", bad: iteration.timed_out },
    { label: "status", value: iterationStatus(iteration.status).label },
  ];
  return (
    <div className="space-y-2.5">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 border-y py-2 text-[13px]">
        {stats.map((s) => (
          <div key={s.label} className="flex items-baseline gap-1.5">
            <dt className="text-[12px] font-medium text-muted-foreground">{s.label}</dt>
            <dd className={cn("font-mono font-medium", s.bad && "text-destructive")}>{s.value}</dd>
          </div>
        ))}
      </dl>
      {iteration.stdout
        ? <TerminalBlock label={`stdout · ${iteration.stdout.length.toLocaleString()} chars`} text={iteration.stdout} />
        : <p className="font-mono text-xs text-muted-foreground">stdout · empty (the code printed nothing)</p>}
      {iteration.stderr
        ? <TerminalBlock label={`stderr · ${iteration.stderr.length.toLocaleString()} chars`} text={iteration.stderr} tone="error" />
        : <p className="font-mono text-xs text-muted-foreground">stderr · empty</p>}
    </div>
  );
}

// ─── Files ─────────────────────────────────────────
export function FilesPanel({ run, iteration }: { run: RunDetail; iteration: Iteration | null }) {
  if (run.artifacts.length === 0) {
    return (
      <Panel className="flex flex-col items-start gap-2 py-8 sm:py-10">
        <ImageOff className="size-6 text-muted-foreground" aria-hidden />
        <div className="text-base font-semibold tracking-tight">No files yet</div>
        <p className="max-w-sm text-xs text-muted-foreground">
          Files the code saves to <code className="font-mono">/workspace/output</code> appear here, separate for each run.
        </p>
      </Panel>
    );
  }
  const changedNow = new Set(iteration?.artifacts.map((a) => a.path) ?? []);
  return <ArtifactList files={run.artifacts} changed={changedNow} iteration={iteration?.number} thumbnails
    caption="Latest version of every file in this run's output folder" />;
}

export function ArtifactList({ files, changed, iteration, caption, thumbnails }: {
  files: (IterationArtifact & { download_url?: string; iteration?: number | null })[];
  changed?: Set<string>; iteration?: number; caption: string; thumbnails?: boolean;
}) {
  return (
    <div className="surface overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
        <span className="text-[13px] font-semibold">{caption}</span>
        <span className="idx">{files.length}</span>
      </div>
      <ul className="divide-y">
        {files.map((a) => {
          const Icon = isImage(a.mime) ? FileImage : a.mime.startsWith("text/") ? FileText : File;
          return (
            <li key={a.path} className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:flex-nowrap">
              {thumbnails && a.snapshot_available !== false && isImage(a.mime)
                ? <a href={a.url} target="_blank" rel="noreferrer" aria-label={`Preview ${a.path}`}>
                    <img src={a.url} alt={a.path} loading="lazy" className="checker size-16 rounded-xs border object-contain" />
                  </a>
                : <Icon className="size-4 shrink-0 text-sandbox" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{a.path}</div>
                <div className="text-xs text-muted-foreground">
                  {formatBytes(a.size)} · {a.mime}
                  {a.iteration && <> · last changed in code run {a.iteration}</>}
                </div>
              </div>
              {changed?.has(a.path) && (
                <span className="tag border-sandbox/40 text-sandbox">
                  changed in code run {iteration}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {a.snapshot_available === false ? <span className="tag">Snapshot unavailable</span> : <>
                <a href={a.url} target="_blank" rel="noreferrer" className="rounded-xs p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Open in a new tab" aria-label={`Open ${a.path} in a new tab`}>
                  <ExternalLink className="size-4" />
                </a>
                <a href={a.download_url ?? `${a.url}&download=1`} aria-label={`Download ${a.path}`} className={FILE_ACTION}>
                  <Download className="size-3.5" aria-hidden /> Download
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
