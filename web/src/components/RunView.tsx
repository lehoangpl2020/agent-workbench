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
import { RunJourney, type JourneyHandle } from "./journey/RunJourney";
import { RunResult } from "./journey/RunResult";
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
  const [replaying, setReplaying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const journey = useRef<JourneyHandle>(null);
  const onIterationChange = useCallback((n: number | null) => setIteration(n), []);

  if (error && !run) {
    return (
      <Alert variant="destructive" className="bg-danger-soft">
        <AlertCircle />
        <AlertDescription className="flex flex-wrap items-center gap-3 text-destructive">
          <span className="min-w-0 break-words"><span className="font-semibold">This run could not be loaded.</span> {error}</span>
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
    <div className="space-y-4">
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
        <p className="flex flex-wrap items-center gap-1.5 rounded-lg border border-destructive/25 bg-danger-soft px-3 py-2 text-[13px] text-destructive" role="status">
          <AlertCircle className="size-4" /> Lost contact with the server; showing the last data received. {error}
          <button className="text-link" onClick={() => void refetch()}>Refresh</button>
        </p>
      )}

      {!running && <RunResult run={run} concealed={replaying}
        onWhyStopped={() => { setTab("journey"); journey.current?.selectEnd(); }}
        onInspect={(n) => { setTab("journey"); journey.current?.selectCodeRun(n); }} />}

      <Tabs value={tab} onValueChange={setTab} className="gap-3 pt-1">
        <TabsList variant="line" className="h-10 w-full justify-start gap-1 rounded-none border-b p-0">
          <TabsTrigger value="journey" className={TAB}><Route /> Journey</TabsTrigger>
          <TabsTrigger value="logs" className={TAB}><ScrollText /> Activity log</TabsTrigger>
          <TabsTrigger value="files" className={TAB}>
            <FolderOpen /> Files
            {run.artifacts.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] font-semibold text-muted-foreground">{run.artifacts.length}</span>
            )}
          </TabsTrigger>
        </TabsList>
        {/* Kept mounted so the selected step, follow-live and replay position survive a tab switch */}
        <TabsContent value="journey" forceMount className="min-w-0 data-[state=inactive]:hidden">
          <RunJourney ref={journey} run={run} {...activity} stopping={stopping} onStop={stop} onIterationChange={onIterationChange}
            onReplayChange={setReplaying} />
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

const TAB = "h-10 flex-none rounded-none px-3 text-[13.5px] data-[state=active]:text-primary group-data-[variant=line]/tabs-list:data-[state=active]:after:bg-primary group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring";

/** The task is the page's heading; configuration and usage are secondary lines under it. */
function RunHeader({ run, stopping, onStop, onEdit }: { run: RunDetail; stopping: boolean; onStop: () => void; onEdit: () => void }) {
  const running = run.status === "running" || run.status === "pending";
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [fullTask, setFullTask] = useState(false);
  const long = run.prompt.length > 200 || run.prompt.split("\n").length > 3;
  const codeRuns = run.iterations.filter(i => i.exit_code !== null).length;
  const local = /^local/i.test(run.executor);
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusBadge status={run.status} />
        <span className="text-[13px] text-muted-foreground">
          <time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString()}>{relativeTime(run.created_at)}</time>
          <span className="font-mono text-xs" title={`Run ${run.id}`}> · #{run.id.slice(0, 6)}</span>
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <ExamplesSheet trigger={<Button variant="ghost" size="sm"><ListChecks /> Examples</Button>}
            open={examplesOpen} onOpenChange={setExamplesOpen} />
          {running ? (
            <Button variant="destructive" size="sm" onClick={onStop} disabled={stopping}>
              {stopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
              {stopping ? "Stopping…" : "Stop run"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onEdit}><Pencil /> Edit & re-run</Button>
          )}
        </div>
      </div>
      <div>
        <h1 id="run-task" className={cn("max-w-[72ch] text-xl leading-snug font-semibold tracking-tight break-words whitespace-pre-wrap sm:text-[22px]",
          !fullTask && "line-clamp-3")}>
          {run.prompt}
        </h1>
        {long && <button type="button" aria-expanded={fullTask} aria-controls="run-task" onClick={() => setFullTask(v => !v)}
          className="text-link mt-1 text-[13px]">
          {fullTask ? "Show less" : "Show full task"}</button>}
      </div>
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
        <Meta label="Model" title={`${providerLabel(run)} · ${run.model || "model not recorded"}`}>
          <BrainCircuit className="size-3.5 text-[var(--model)]" aria-hidden /><span className="font-medium text-foreground">{modelLabel(run)}</span>
          <span>· {providerLabel(run)}</span>
        </Meta>
        <Meta label="Sandbox" title={local ? "Local executor: code is not isolated" : "Where the code runs"} className={cn(local && "text-warning")}>
          {local ? <TriangleAlert className="size-3.5" aria-hidden /> : <Box className="size-3.5 text-[var(--sandbox)]" aria-hidden />}
          <span className="break-all">{run.executor || "executor not recorded"}</span>
        </Meta>
        <Meta label="Code runs used" title="Code runs used / allowed (max_iterations)">
          <Repeat className="size-3.5" aria-hidden />{codeRuns} of {run.max_iterations} code runs</Meta>
        <Meta label="Timeout"><Clock className="size-3.5" aria-hidden />{run.timeout_seconds}s per code run</Meta>
        {run.image_tool && <Meta label="Image tool" title="The agent could ask the OpenAI image model for images in this run">
          <ImagePlus className="size-3.5" aria-hidden />Image tool on</Meta>}
      </dl>
      <UsageSummary run={run} />
      {running && <div className="surface overflow-hidden">
        <LiveActivity run={run} />
        <div className="h-0.5 overflow-hidden bg-accent">
          <div className="h-full w-1/3 animate-[progress_1.4s_ease-in-out_infinite] bg-primary" />
        </div>
      </div>}
    </header>
  );
}

function Meta({ label, title, className, children }: { label: string; title?: string; className?: string; children: React.ReactNode }) {
  return <div className={cn("flex min-w-0 items-center gap-1.5", className)} title={title}>
    <dt className="sr-only">{label}</dt>
    <dd className="flex min-w-0 items-center gap-1.5">{children}</dd>
  </div>;
}

function RunSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading run">
      <Skeleton className="h-6 w-40 rounded-md" />
      <Skeleton className="h-8 w-3/4 rounded-md" />
      <Skeleton className="h-4 w-1/2 rounded-md" />
      <Skeleton className="h-36 w-full rounded-[10px]" />
      <div className="grid gap-3 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Skeleton className="h-80 w-full rounded-[10px]" />
        <Skeleton className="h-80 w-full rounded-[10px]" />
      </div>
    </div>
  );
}

