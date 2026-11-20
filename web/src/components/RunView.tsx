import { useCallback, useRef, useState } from "react";
import {
  AlertCircle, Box, Brain, BrainCircuit, Clock, FolderOpen, ImagePlus, ListChecks, Loader2, Pencil, RefreshCw, Repeat,
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
      <Alert variant="destructive">
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
    <div className="space-y-6">
      <RunHeader
        run={run}
        stopping={stopping}
        onStop={stop}
        onEdit={() => onEdit({ prompt: run.prompt, maxIterations: run.max_iterations, timeoutSeconds: run.timeout_seconds,
          provider: run.provider, model: run.model, imageTool: run.image_tool, reasoning: run.reasoning })}
      />
      {stopError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{stopError}</AlertDescription>
        </Alert>
      )}
      {error && (
        <p className="flex flex-wrap items-center gap-1.5 rounded-xs border border-l-[3px] border-destructive/30 border-l-destructive bg-danger-soft px-3 py-2 text-[13px] text-destructive" role="status">
          <AlertCircle className="size-4" aria-hidden /> <span className="font-semibold">Disconnected.</span> Showing the last data received. {error}
          <button className="text-link" onClick={() => void refetch()}>Refresh</button>
        </p>
      )}

      {!running && <RunResult run={run} concealed={replaying}
        onWhyStopped={() => { setTab("journey"); journey.current?.selectEnd(); }}
        onInspect={(n) => { setTab("journey"); journey.current?.selectCodeRun(n); }} />}

      <Tabs value={tab} onValueChange={setTab} className="gap-4 pt-2">
        <TabsList variant="line" className="h-11 w-full justify-start gap-2 overflow-x-auto overflow-y-hidden rounded-none border-b-2 border-rule p-0">
          <TabsTrigger value="journey" className={TAB}><Route /> Journey</TabsTrigger>
          <TabsTrigger value="logs" className={TAB}><ScrollText /> Activity log</TabsTrigger>
          <TabsTrigger value="files" className={TAB}>
            <FolderOpen /> Files
            {run.artifacts.length > 0 && (
              <span className="rounded-xs border border-border bg-card px-1 font-mono text-[11px] leading-4 font-semibold text-muted-foreground">{run.artifacts.length}</span>
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

const TAB = "h-11 flex-none rounded-none px-1 text-[14px] font-medium text-muted-foreground data-[state=active]:font-semibold data-[state=active]:text-foreground group-data-[variant=line]/tabs-list:data-[state=active]:after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-[-2px] group-data-[orientation=horizontal]/tabs:after:h-[3px] focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring";

/** Short tasks read as a headline; long prompts step down so the page does not turn into one giant heading. */
function taskSize(prompt: string) {
  const n = prompt.length;
  if (n <= 90) return "text-[26px] leading-[1.15] sm:text-[34px] sm:leading-[1.1]";
  if (n <= 220) return "text-[21px] leading-[1.25] sm:text-[26px] sm:leading-[1.2]";
  return "text-lg leading-snug sm:text-[21px]";
}

/** The task is the page's heading; configuration and usage are secondary lines under it. */
function RunHeader({ run, stopping, onStop, onEdit }: { run: RunDetail; stopping: boolean; onStop: () => void; onEdit: () => void }) {
  const running = run.status === "running" || run.status === "pending";
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [fullTask, setFullTask] = useState(false);
  const long = run.prompt.length > 200 || run.prompt.split("\n").length > 3;
  const codeRuns = run.iterations.filter(i => i.exit_code !== null).length;
  const local = /^local/i.test(run.executor);
  return (
    <header className="space-y-4">
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
        <h1 id="run-task" className={cn("max-w-[64ch] font-semibold tracking-[-0.02em] break-words whitespace-pre-wrap", taskSize(run.prompt),
          !fullTask && "line-clamp-3")}>
          {run.prompt}
        </h1>
        {long && <button type="button" aria-expanded={fullTask} aria-controls="run-task" onClick={() => setFullTask(v => !v)}
          className="text-link mt-2 text-[13px]">
          {fullTask ? "Show less" : "Show full task"}</button>}
      </div>
      <dl className="grid grid-cols-2 border-y sm:flex sm:flex-wrap sm:divide-x">
        <Meta label="Model" title={`${providerLabel(run)} · ${run.model || "model not recorded"}`} icon={<BrainCircuit className="size-3.5 text-model" aria-hidden />}
          sub={providerLabel(run)}>{modelLabel(run)}</Meta>
        <Meta label="Sandbox" title={local ? "Local executor: code is not isolated" : "Where the code runs"} className={cn(local && "text-warning")}
          icon={local ? <TriangleAlert className="size-3.5" aria-hidden /> : <Box className="size-3.5 text-sandbox" aria-hidden />}
          sub={local ? "not isolated" : undefined} mono>{run.executor || "executor not recorded"}</Meta>
        <Meta label="Code runs" title="Code runs used / allowed (max_iterations)" icon={<Repeat className="size-3.5 text-muted-foreground" aria-hidden />}
          sub="used of allowed"><span className="tabular-nums">{codeRuns} / {run.max_iterations}</span></Meta>
        <Meta label="Timeout" icon={<Clock className="size-3.5 text-muted-foreground" aria-hidden />} sub="per code run">
          <span className="tabular-nums">{run.timeout_seconds} s</span></Meta>
        {run.reasoning && <Meta label="Reasoning" title="The model was asked to think first; its reasoning is shown under each model call"
          icon={<Brain className="size-3.5 text-model" aria-hidden />} sub="shown per model call">On</Meta>}
        {run.image_tool && <Meta label="Image tool" title="The agent could ask the OpenAI image model for images in this run"
          icon={<ImagePlus className="size-3.5 text-muted-foreground" aria-hidden />} sub="opted in for this run">On</Meta>}
      </dl>
      <UsageSummary run={run} />
      {running && <div className="surface overflow-hidden">
        <LiveActivity run={run} />
        <div className="h-0.5 overflow-hidden bg-secondary">
          <div className="h-full w-1/3 animate-[progress_1.4s_ease-in-out_infinite] bg-brand" />
        </div>
      </div>}
    </header>
  );
}

/** One cell of the configuration strip: small label, the value, an optional quiet second line. */
function Meta({ label, title, className, icon, sub, mono, children }: {
  label: string; title?: string; className?: string; icon?: React.ReactNode; sub?: string; mono?: boolean; children: React.ReactNode;
}) {
  return <div className={cn("min-w-0 py-2.5 pr-4 sm:max-w-[42ch] sm:flex-[0_1_auto] sm:px-5 sm:first:pl-0", className)} title={title}>
    <dt className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[.08em] text-muted-foreground uppercase">{icon}{label}</dt>
    <dd className={cn("mt-1 text-[13.5px] leading-snug font-medium break-words", mono && "font-mono text-[12.5px] [overflow-wrap:anywhere]")}>{children}</dd>
    {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
  </div>;
}

function RunSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading run">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-9 w-3/4" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    </div>
  );
}

