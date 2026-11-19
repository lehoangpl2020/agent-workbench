import { useCallback, useRef, useState } from "react";
import {
  AlertCircle, Box, BrainCircuit, Clock, FolderOpen, ImagePlus, ListChecks, Loader2, Pencil, RefreshCw, Repeat,
  Route, ScrollText, Square, TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRun } from "@/hooks/useRun";
import { api, type RunDetail } from "@/lib/api";
import { modelLabel, providerLabel, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ActivityLog } from "./ActivityLog";
import type { ComposerDraft } from "./Composer";
import { ExamplesSheet } from "./ExamplesSheet";
import { LiveActivity } from "./LiveActivity";
import { Outcome } from "./journey/Outcome";
import { RunJourney, type JourneyHandle } from "./journey/RunJourney";
import { FilesPanel } from "./ResultPanels";
import { UsageSummary } from "./RunUsage";
import { StatusBadge } from "./StatusBadge";

interface Props {
  runId: string;
  onChanged: () => void;
  onEdit: (draft: ComposerDraft) => void;
}

export function RunView({ runId, onChanged, onEdit }: Props) {
  const { run, error, refetch, ...activity } = useRun(runId, onChanged);
  const [tab, setTab] = useState("journey");
  const [iteration, setIteration] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const journey = useRef<JourneyHandle>(null);
  const onIterationChange = useCallback((n: number | null) => setIteration(n), []);

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

  const running = run.status === "running" || run.status === "pending";
  // The step selected in the journey decides which iteration the log and files tabs point at
  const selectedIteration = run.iterations.find(i => i.number === iteration) ?? run.iterations.at(-1) ?? null;

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
    <div className="space-y-3">
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
        <p className="flex items-center gap-1.5 text-xs text-destructive" role="status">
          <AlertCircle className="size-3.5" /> {error}
          <button className="underline" onClick={() => void refetch()}>Refresh</button>
        </p>
      )}

      {!running && <div className="@container"><Outcome run={run} onOpenEnd={() => { setTab("journey"); journey.current?.selectEnd(); }} /></div>}

      <Tabs value={tab} onValueChange={setTab} className="gap-3">
        <TabsList className="h-auto max-w-full flex-wrap justify-start sm:h-9">
          <TabsTrigger value="journey" className="px-2 sm:px-3"><Route /> Journey</TabsTrigger>
          <TabsTrigger value="logs" className="px-2 sm:px-3"><ScrollText /> Activity log</TabsTrigger>
          <TabsTrigger value="files" className="px-2 sm:px-3">
            <FolderOpen /> Files
            {run.artifacts.length > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">{run.artifacts.length}</span>
            )}
          </TabsTrigger>
        </TabsList>
        {/* Kept mounted so the selected step, follow-live and replay position survive a tab switch */}
        <TabsContent value="journey" forceMount className="min-w-0 data-[state=inactive]:hidden">
          <RunJourney ref={journey} run={run} {...activity} stopping={stopping} onStop={stop} onIterationChange={onIterationChange} />
        </TabsContent>
        <TabsContent value="logs" className="min-w-0">
          <ActivityLog run={run} logs={activity.logs} selected={selectedIteration} logError={activity.logError}
            onRetry={() => void activity.retryLogs()} />
        </TabsContent>
        <TabsContent value="files" className="min-w-0">
          <FilesPanel run={run} iteration={selectedIteration} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RunHeader({ run, stopping, onStop, onEdit }: { run: RunDetail; stopping: boolean; onStop: () => void; onEdit: () => void }) {
  const running = run.status === "running" || run.status === "pending";
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [fullTask, setFullTask] = useState(false);
  const long = run.prompt.length > 160 || run.prompt.split("\n").length > 2;
  const codeRuns = run.iterations.filter(i => i.exit_code !== null).length;
  const local = /^local/i.test(run.executor);
  return (
    <div className="studio-card">
      <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-start sm:px-5">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <StatusBadge status={run.status} />
            <span className="inline-flex items-center gap-1 font-medium text-foreground/80" title={`${providerLabel(run)} · ${run.model || "model not recorded"}`}>
              <BrainCircuit className="size-3.5 text-[var(--model)]" /> {modelLabel(run)}
              <span className="font-normal text-muted-foreground">· {providerLabel(run)}</span>
            </span>
            <span className={cn("inline-flex items-center gap-1", local && "text-warning")} title={local ? "Local executor: code is not isolated" : "Where the code runs"}>
              {local ? <TriangleAlert className="size-3.5" /> : <Box className="size-3.5 text-[var(--sandbox)]" />} {run.executor || "executor not recorded"}
            </span>
            <span className="inline-flex items-center gap-1" title="Code runs used / allowed (max_iterations)">
              <Repeat className="size-3.5" /> {codeRuns}/{run.max_iterations} code runs
            </span>
            <span className="inline-flex items-center gap-1"><Clock className="size-3.5" /> {run.timeout_seconds}s timeout</span>
            {run.image_tool && <span className="inline-flex items-center gap-1" title="The agent could ask the OpenAI image model for images in this run">
              <ImagePlus className="size-3.5" /> Image tool</span>}
            <time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString()}>{relativeTime(run.created_at)}</time>
          </div>
          <div>
            <p id="run-task" className={cn("text-[15px] leading-relaxed font-medium break-words whitespace-pre-wrap", !fullTask && "line-clamp-2")}>
              {run.prompt}
            </p>
            {long && <button type="button" aria-expanded={fullTask} aria-controls="run-task" onClick={() => setFullTask(v => !v)}
              className="mt-0.5 rounded text-xs font-medium text-primary hover:underline">
              {fullTask ? "Show less" : "Show full task"}</button>}
          </div>
          <UsageSummary run={run} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <ExamplesSheet trigger={<Button variant="ghost" size="sm"><ListChecks /> Examples</Button>}
            open={examplesOpen} onOpenChange={setExamplesOpen} />
          {running ? (
            <Button variant="destructive" size="sm" onClick={onStop} disabled={stopping}>
              {stopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onEdit}><Pencil /> Edit & re-run</Button>
          )}
        </div>
      </div>
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
    <div className="space-y-3">
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-xl" />
      <div className="grid gap-3 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    </div>
  );
}
