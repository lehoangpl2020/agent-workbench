import { useState } from "react";
import { AlertCircle, BrainCircuit, Clock, ImagePlus, ListChecks, Loader2, Pencil, RefreshCw, Repeat, Square } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRun } from "@/hooks/useRun";
import { api, type RunDetail } from "@/lib/api";
import { RUN_STATUS, TONE_CLASSES, modelLabel, providerLabel, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ComposerDraft } from "./Composer";
import { ExamplesSheet } from "./ExamplesSheet";
import { LiveActivity } from "./LiveActivity";
import { AgentStudio } from "./studio/AgentStudio";
import { ResultTabs } from "./ResultTabs";
import { RunUsage } from "./RunUsage";
import { StatusBadge } from "./StatusBadge";
import { Timeline } from "./Timeline";

interface Props {
  runId: string;
  onChanged: () => void;
  onEdit: (draft: ComposerDraft) => void;
}

export function RunView({ runId, onChanged, onEdit }: Props) {
  const { run, error, refetch, ...activity } = useRun(runId, onChanged);
  const [manual, setManual] = useState<number | null>(null);
  const [tab, setTab] = useState(() => sessionStorage.getItem("live-flow-run") === runId ? "flow" : "preview");
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  if (error && !run) {
    return (
      <Alert variant="destructive" className="bg-danger-soft">
        <AlertCircle />
        <AlertDescription className="flex items-center gap-3 text-destructive">
          {error}
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            <RefreshCw /> Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!run) return <RunSkeleton />;

  // Defaults to the latest iteration; once the user clicks, the user's choice is kept
  const last = run.iterations[run.iterations.length - 1];
  const selectedNumber = manual ?? last?.number ?? null;
  const iteration = run.iterations.find((i) => i.number === selectedNumber) ?? null;

  async function stop() {
    setStopping(true);
    setStopError(null);
    try {
      await api.stopRun(runId);
      await refetch();
      onChanged();
    } catch (e) {
      setStopError(e instanceof Error ? e.message : String(e));
      void refetch();
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="space-y-5">
      <RunHeader
        run={run}
        stopping={stopping}
        onStop={stop}
        onEdit={() => onEdit({ prompt: run.prompt, maxIterations: run.max_iterations, timeoutSeconds: run.timeout_seconds,
          provider: run.provider, model: run.model, imageTool: run.image_tool })}
      />
      {stopError && (
        <Alert variant="destructive" className="bg-danger-soft">
          <AlertCircle />
          <AlertDescription className="text-destructive">{stopError}</AlertDescription>
        </Alert>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5" /> {error}
          <button className="underline" onClick={() => void refetch()}>Refresh</button>
        </p>
      )}

      <RunUsage run={run} />

      <ResultTabs run={run} iteration={iteration} logs={activity.logs} logError={activity.logError}
        retryLogs={() => void activity.retryLogs()} tab={tab} onTabChange={value => {
        setTab(value);
        if (value === "flow") sessionStorage.setItem("live-flow-run", runId);
        else sessionStorage.removeItem("live-flow-run");
      }} flow={<AgentStudio run={run} {...activity} stopping={stopping} onStop={stop} />} timeline={
        <section>
          <h2 className="mb-2.5 flex items-center justify-between text-sm font-semibold">
            Timeline
            <span className="text-xs font-normal text-muted-foreground">
              {run.iterations.filter((it) => it.exit_code !== null).length}/{run.max_iterations} code runs
              · {run.iterations.length} model call{run.iterations.length === 1 ? "" : "s"}
            </span>
          </h2>
          <Timeline run={run} selected={selectedNumber} onSelect={setManual} />
        </section>
      } />
    </div>
  );
}

function RunHeader({ run, stopping, onStop, onEdit }: { run: RunDetail; stopping: boolean; onStop: () => void; onEdit: () => void }) {
  const running = run.status === "running";
  const tone = RUN_STATUS[run.status]?.tone ?? "neutral";
  // Read-only reference: it does not know whether this run came from an example, and does not guess
  const [examplesOpen, setExamplesOpen] = useState(false);
  return (
    <div className="rounded-xl border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground/80"
              title={`${providerLabel(run)} · ${run.model || "model not recorded"}`}>
              <BrainCircuit className="size-3.5 text-muted-foreground" /> {modelLabel(run)}
              <span className="font-normal text-muted-foreground">· {providerLabel(run)}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Repeat className="size-3.5" /> max {run.max_iterations} code runs
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3.5" /> {run.timeout_seconds}s timeout
            </span>
            {run.image_tool && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                title="The agent could ask the OpenAI image model for images in this run">
                <ImagePlus className="size-3.5" /> Image tool
              </span>
            )}
            <span className="text-xs text-muted-foreground">· {relativeTime(run.created_at)}</span>
          </div>
          <p className="text-[15px] leading-relaxed font-medium break-words whitespace-pre-wrap">{run.prompt}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <ExamplesSheet
            trigger={
              <Button variant="ghost">
                <ListChecks /> Examples
              </Button>
            }
            open={examplesOpen}
            onOpenChange={setExamplesOpen}
          />
          {running ? (
            <Button variant="destructive" onClick={onStop} disabled={stopping}>
              {stopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button variant="outline" onClick={onEdit}>
              <Pencil /> Edit & re-run
            </Button>
          )}
        </div>
      </div>
      {!running && run.message && (
        <div className={cn("rounded-b-xl border-t px-4 py-2.5 text-sm sm:px-5", TONE_CLASSES[tone])}>
          <span className="font-semibold">{RUN_STATUS[run.status]?.label}.</span> {run.message}
        </div>
      )}
      {running && <LiveActivity run={run} />}
      {running && (
        <div className="h-0.5 overflow-hidden rounded-b-xl bg-accent">
          <div className="h-full w-1/3 animate-[progress_1.4s_ease-in-out_infinite] bg-primary" />
        </div>
      )}
    </div>
  );
}

function RunSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    </div>
  );
}
