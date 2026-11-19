import { useEffect, useMemo, useState } from "react";
import { CircleHelp, Loader2, Pause, Play, Radio, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { LogEntry, RunDetail } from "@/lib/api";
import { RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import { useLivePresenter, useNow } from "@/hooks/useLivePresenter";
import { useReplayClock } from "@/hooks/useReplayClock";
import { buildSteps, explain, REPLAY_MAX_MS, REPLAY_MIN_MS, REPLAY_TRANSFER_MIN_MS, seenAt, stepTime, type StudioStep } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { HowItWorks } from "./HowItWorks";
import { StepDetails } from "./StepDetails";
import { StudioStage } from "./StudioStage";
import { StudioTimeline } from "./StudioTimeline";

interface Props {
  run: RunDetail;
  logs: LogEntry[];
  connected: boolean;
  logError: boolean;
  historyLoaded: boolean;
  retryLogs: () => void;
  stopping: boolean;
  onStop: () => void;
}

const SPEEDS = [1, 2, 4];
const EMPTY = { steps: [] as StudioStep[], partial: false };

export function AgentStudio({ run, logs, connected, logError, historyLoaded, retryLogs, stopping, onStop }: Props) {
  const { steps, partial } = useMemo(() => historyLoaded ? buildSteps(run, logs) : EMPTY, [historyLoaded, run, logs]);
  const running = run.status === "running" || run.status === "pending";
  const last = steps.length - 1;
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [pinned, setPinned] = useState<number | null>(null);
  const live = useLivePresenter(steps, historyLoaded);
  const replay = mode === "replay";
  const { cursor, playing, speed, setSpeed, animatedKey: replayAnimated, seek, restart, pause, toggle } =
    useReplayClock(steps, replay);
  const now = useNow(running && !replay);

  // Leaving replay is forced if a run is (re)started; replay is only offered for finished runs.
  useEffect(() => { if (running && replay) { setMode("live"); pause(); } }, [running, replay, pause]);

  const stageIndex = replay ? Math.min(cursor, last) : live.shown;
  const panelIndex = replay ? stageIndex : pinned != null && pinned <= last ? pinned : stageIndex;
  // While the live view is still presenting a burst of events, later steps stay unrevealed too.
  const revealed = stageIndex;
  const caughtUp = replay || stageIndex === last;
  const showLive = !replay && (running || !caughtUp);
  const step = steps[stageIndex];
  const panelStep = steps[panelIndex];
  const liveEdge = !replay && stageIndex === last;
  const animate = replay ? playing && replayAnimated === step?.key : live.animated === step?.key;

  const stageSeen = useMemo(() => seenAt(run, steps, stageIndex), [run, steps, stageIndex]);
  const panelSeen = useMemo(() => panelIndex === stageIndex ? stageSeen : seenAt(run, steps, panelIndex), [run, steps, panelIndex, stageIndex, stageSeen]);
  const revealedSeen = useMemo(() => revealed === stageIndex ? stageSeen : seenAt(run, steps, revealed), [run, steps, revealed, stageIndex, stageSeen]);

  function startReplay() {
    setMode("replay");
    setPinned(null);
    restart();
  }
  function goLive() {
    setMode("live");
    pause();
    setPinned(null);
  }
  function select(i: number) {
    if (replay) return seek(i);
    if (running) return setPinned(i === live.shown ? null : i);
    setMode("replay");
    setPinned(null);
    seek(i);
  }

  const ended = replay && !playing && cursor >= last && last > 0;
  const meta = RUN_STATUS[run.status];
  const sinceActivity = running && run.activity_at ? Math.max(0, Math.floor((now - Date.parse(run.activity_at)) / 1000)) : null;
  const liveAction = liveEdge && running ? run.activity || step?.title || "Starting run" : step?.title;

  return <section aria-label="Agent Studio" className="space-y-3">
    {/* ── Control bar ── */}
    <div className="studio-card flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4">
      <div className="studio-segment" role="group" aria-label="View mode">
        <button type="button" aria-pressed={!replay} onClick={goLive}>
          <Radio className={cn("size-3.5", running && connected && "text-destructive")} />{showLive || running ? "Live" : "Result"}
        </button>
        <button type="button" aria-pressed={replay} onClick={() => replay ? undefined : startReplay()}
          disabled={running || !historyLoaded || steps.length === 0} title={running ? "Replay is available when the run finishes" : undefined}>
          <RotateCcw className="size-3.5" />Replay
        </button>
      </div>

      <div className="flex min-w-0 flex-1 basis-56 items-center gap-2" role="status" aria-live="polite">
        {replay ? <>
          <span className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent-foreground">
            {ended ? "End" : `${stageIndex + 1}/${steps.length}`}</span>
          <span className="min-w-0 truncate text-sm font-medium">{ended ? "Replay finished" : step?.title}</span>
        </> : showLive ? <>
          <span className={cn("studio-dot shrink-0", running && connected ? "bg-destructive" : "bg-muted-foreground/50")} />
          <span className="min-w-0 truncate text-sm font-medium">{liveAction}</span>
          {sinceActivity != null && liveEdge && <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{sinceActivity}s</span>}
          {running && !connected && <span className="shrink-0 text-xs text-warning">Reconnecting…</span>}
        </> : <>
          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium", TONE_CLASSES[meta.tone])}>{meta.label}</span>
          <span className="min-w-0 truncate text-sm text-muted-foreground">{run.message}</span>
        </>}
        {stageSeen.iteration != null && <span className="ml-auto shrink-0 text-xs text-muted-foreground">Iteration {stageSeen.iteration}{stageSeen.iteration > run.max_iterations && " · final review"}</span>}
      </div>

      {running && <Button variant="destructive" size="sm" onClick={onStop} disabled={stopping}>
        {stopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}{stopping ? "Stopping…" : "Stop"}
      </Button>}

      {replay && <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={toggle} disabled={steps.length < 2} className="w-[92px]">
          {playing ? <Pause /> : <Play />}{playing ? "Pause" : ended ? "Play again" : "Play"}
        </Button>
        <Button variant="outline" size="sm" onClick={restart}>
          <RotateCcw />Restart
        </Button>
        <div className="studio-segment" role="group" aria-label="Playback speed">
          {SPEEDS.map(s => <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
        </div>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="About replay timing">
                <CircleHelp className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-72 text-left">
              Replay reads the recorded log and file versions only. It never calls the model or runs code.
              Timestamps are original; waits between steps are shortened to {REPLAY_MIN_MS / 1000}–{REPLAY_MAX_MS / 1000}s at 1×
              (at least {REPLAY_TRANSFER_MIN_MS / 1000}s after a data hand-off).
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>}
      {replay && <p className="w-full text-[11px] text-muted-foreground">
        Replaying recorded activity · run result: {meta.label}{partial && " · partial history (older run, fewer recorded steps)"}
      </p>}
    </div>

    {logError && <p className="text-xs text-warning">Activity history could not be loaded. <button className="underline" onClick={retryLogs}>Retry</button></p>}
    {!replay && partial && <p className="text-xs text-muted-foreground">Partial history: this older run only kept run and iteration boundaries.</p>}

    {/* ── Stage + details ── */}
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
      {/* Below lg the column dissolves so the order becomes stage → details → timeline. */}
      <div className="contents lg:block lg:min-w-0 lg:space-y-3">
      <div className={cn("studio-card order-1 min-w-0 overflow-hidden lg:order-none", replay && !playing && "is-paused")}>
        <div className="flex min-h-11 items-center gap-2 border-b px-4 py-2.5 sm:px-5">
          <p key={step?.key} className="studio-caption line-clamp-2 min-w-0 flex-1 text-sm">
            {step ? explain(step, run) : historyLoaded ? running ? "Waiting for the first event from the backend." : "No recorded activity." : "Loading recorded activity…"}
          </p>
          {step && <time dateTime={step.ts} className="shrink-0 font-mono text-[11px] text-muted-foreground">{stepTime(step.ts)}</time>}
        </div>
        <StudioStage run={run} steps={steps} step={step} seen={stageSeen} animate={animate} speed={replay ? speed : 1}
          liveEdge={liveEdge} now={now} />
      </div>
      <div className="studio-card order-3 min-w-0 overflow-hidden lg:order-none">
        <StudioTimeline run={run} steps={steps} current={stageIndex} revealed={revealed} selected={panelIndex}
          seen={revealedSeen} onSelect={select} />
      </div>
      </div>
      <aside className="studio-card order-2 min-w-0 p-4 lg:order-none lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto" aria-label="Step details">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {replay ? "At this step" : pinned != null && running ? `Step ${panelIndex + 1}` : showLive ? "Now" : "Final step"}
          </h2>
          {!replay && pinned != null && running && <button className="text-xs font-medium text-primary hover:underline" onClick={() => setPinned(null)}>Back to live</button>}
        </div>
        <StepDetails run={run} steps={steps} step={panelStep} seen={panelSeen}
          liveEdge={!replay && panelIndex === last} now={now} />
      </aside>
    </div>

    <HowItWorks />
  </section>;
}
