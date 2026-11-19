import { CheckCheck, Download, ExternalLink, File, FileImage, FileText, ImageOff, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Iteration, IterationArtifact, RunDetail } from "@/lib/api";
import { formatBytes, formatMs, isImage, iterationStatus, TONE_CLASSES } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CodeView, TerminalBlock } from "./CodeView";

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

/** Code the model is writing (streamed from the backend), auto-scrolls to the end. */
function LiveCode({ iteration, text }: { iteration: Iteration; text: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" /> {text}
      </div>
      <CodeView
        code={iteration.code}
        language={iteration.language}
        title={`iter_${String(iteration.number).padStart(2, "0")}.py · streaming…`}
        follow
      />
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
    <Panel className="text-sm text-muted-foreground">Select an iteration in the timeline to see its details.</Panel>
  );
}

// ─── Preview ───────────────────────────────────────
export function PreviewPanel({ run, iteration }: { run: RunDetail; iteration: Iteration | null }) {
  if (!iteration) return run.status === "running" ? <Waiting text="Waiting for the first iteration…" /> : <NoIteration />;
  if (iteration.status === "planning") {
    const text = currentAction(run, iteration, "Waiting for the model…");
    return iteration.code ? <LiveCode iteration={iteration} text={text} /> : <Waiting text={text} />;
  }
  if (iteration.status === "executing") {
    return <Waiting text={currentAction(run, iteration, "Running the code in the sandbox…")} />;
  }

  // DONE iteration: no code → show the final result + every image of the run
  if (iteration.status === "done") {
    const images = run.artifacts.filter((a) => isImage(a.mime));
    return (
      <div className="space-y-4">
        <Panel className="border-success/25 bg-success-soft/50">
          <div className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCheck className="size-4" /> The model reviewed the output and confirmed the task is complete.
          </div>
        </Panel>
        {images.map((a) => (
          <ImageCard key={a.path} src={a.url} name={a.path} download={a.download_url} />
        ))}
        <TextResult title="Final result" text={run.answer} />
      </div>
    );
  }

  const meta = iterationStatus(iteration.status);
  // Iteration ended before its code finished running (Stop / infrastructure error / planner error)
  if (iteration.exit_code === null) {
    return (
      <Panel className={cn("border", TONE_CLASSES[meta.tone])}>
        <div className="text-sm font-medium">{meta.label}</div>
        <p className="mt-1 text-sm opacity-90">
          {iteration.status === "stopped"
            ? "The run was stopped before this iteration finished. The running process was killed, so there is no output."
            : run.message || "This iteration did not produce any output."}
        </p>
      </Panel>
    );
  }

  const images = iteration.artifacts.filter((a) => isImage(a.mime));
  const ok = iteration.exit_code === 0;
  return (
    <div className="space-y-4">
      {!ok && (
        <Panel className={cn("border", TONE_CLASSES[meta.tone])}>
          <div className="text-sm font-medium">{meta.label}</div>
          <pre className="mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap opacity-90">
            {lastLines(iteration.stderr, 8) || "No error output."}
          </pre>
          <p className="mt-2 text-xs opacity-80">
            {run.status === "running" || iteration.number < run.iterations.length
              ? "The error was sent back to the model so it can fix the code in the next iteration."
              : "See the Logs tab for full stdout/stderr."}
          </p>
        </Panel>
      )}
      {images.map((a) => (
        <ImageCard
          key={a.path}
          src={a.url}
          name={a.path}
          download={`/api/runs/${run.id}/artifacts/${encodeURIComponent(a.path)}?iteration=${iteration.number}&download=1`}
        />
      ))}
      {ok && images.length === 0 && iteration.artifacts.length > 0 && (
        <Panel className="text-sm text-muted-foreground">
          Created {iteration.artifacts.length} file(s) — see the Files tab.
        </Panel>
      )}
      {(ok || iteration.stdout) && <TextResult title="Output" text={iteration.stdout} />}
    </div>
  );
}

function ImageCard({ src, name, download }: { src: string; name: string; download: string }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <FileImage className="size-4 shrink-0 text-primary" />
          <span className="truncate">{name}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <a href={src} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Open in new tab">
            <ExternalLink className="size-4" />
          </a>
          <a href={download} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted">
            <Download className="size-3.5" /> Download
          </a>
        </div>
      </div>
      <div className="checker flex justify-center p-3 sm:p-5">
        <img src={src} alt={name} className="max-h-[560px] max-w-full rounded object-contain" loading="lazy" />
      </div>
    </div>
  );
}

function TextResult({ title, text }: { title: string; text: string }) {
  return <TerminalBlock label={title} text={text.trimEnd()} empty="(no text output)" />;
}

// ─── Code ──────────────────────────────────────────
export function CodePanel({ run, iteration }: { run: RunDetail; iteration: Iteration | null }) {
  if (!iteration) return <NoIteration />;
  if (iteration.status === "planning") {
    const text = currentAction(run, iteration, "Waiting for the model…");
    return iteration.code ? <LiveCode iteration={iteration} text={text} /> : <Waiting text={text} />;
  }
  if (!iteration.code) {
    return (
      <Panel className="text-sm text-muted-foreground">
        {iteration.status === "done"
          ? "No code in this iteration — the model replied DONE."
          : "No code was generated in this iteration."}
      </Panel>
    );
  }
  return (
    <div className="space-y-3">
      {iteration.explanation && (
        <Panel className="py-3 text-sm">
          <span className="mr-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Explanation</span>
          {iteration.explanation}
        </Panel>
      )}
      <CodeView code={iteration.code} language={iteration.language} title={`iter_${String(iteration.number).padStart(2, "0")}.py`} />
    </div>
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
                  {a.iteration && <> · last changed in iteration {a.iteration}</>}
                </div>
              </div>
              {changed?.has(a.path) && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground">
                  changed in iteration {iteration}
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

function lastLines(text: string, n: number) {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}
