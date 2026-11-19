import { useEffect, useMemo, useRef, useState } from "react";
import { BrainCircuit, ChevronDown, CircleHelp, FolderOutput, Loader2, Pause, Play, Radio, RotateCcw, Square, SquareTerminal, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { LogEntry, RunDetail } from "@/lib/api";
import { RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import { buildSteps, explain, REPLAY_MAX_MS, REPLAY_MIN_MS, REPLAY_TRANSFER_MIN_MS, replayGap, seenAt, stepTime, type StudioStep } from "@/lib/studio";
import { cn } from "@/lib/utils";
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

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Live view presenter. Backend events can land milliseconds apart (code accepted → file written → executing),
 * so new steps are shown in order with a short dwell, then the view sits on the real latest state.
 * History that already existed when the tab opened is shown settled, without animation.
 */
function useLivePresenter(steps: StudioStep[], ready: boolean) {
  const [shown, setShown] = useState(-1);
  const [animated, setAnimated] = useState<string | null>(null);
  const latest = useRef(steps);
  latest.current = steps;
  const last = steps.length - 1;
  useEffect(() => {
    if (!ready || last < 0) return;
    if (shown < 0) { setShown(last); return; }
    if (shown >= last) return;
    const behind = last - shown;
    if (behind > 14) { setShown(last); setAnimated(null); return; } // far behind (tab was hidden): jump
    const current = latest.current[shown];
    // Only hand-offs get time on screen; bookkeeping steps pass quickly so the view stays close to real time.
    const dwell = current?.transfer && animated === current.key ? (behind > 5 ? 380 : 520) : 70;
    const t = window.setTimeout(() => {
      setShown(shown + 1);
      setAnimated(latest.current[shown + 1]?.key ?? null);
    }, dwell);
    return () => window.clearTimeout(t);
  }, [ready, last, shown, animated]);
  return { shown: shown < 0 ? last : Math.min(shown, last), animated };
}

export function AgentStudio({ run, logs, connected, logError, historyLoaded, retryLogs, stopping, onStop }: Props) {
  const { steps, partial } = useMemo(() => historyLoaded ? buildSteps(run, logs) : EMPTY, [historyLoaded, run, logs]);
  const running = run.status === "running" || run.status === "pending";
  const last = steps.length - 1;
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pinned, setPinned] = useState<number | null>(null);
  const [replayAnimated, setReplayAnimated] = useState<string | null>(null);
  const remaining = useRef<{ key: string; ms: number } | null>(null);
  const live = useLivePresenter(steps, historyLoaded);
  const replay = mode === "replay";
  const now = useNow(running && !replay);

  // Leaving replay is forced if a run is (re)started; replay is only offered for finished runs.
  useEffect(() => { if (running && replay) { setMode("live"); setPlaying(false); } }, [running, replay]);

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

  // Replay clock: waits the (clamped) recorded gap; Pause keeps the remaining time for this step.
  useEffect(() => {
    if (!replay || !playing) return;
    const current = steps[cursor];
    const next = steps[cursor + 1];
    if (!current || !next) { setPlaying(false); return; }
    const full = replayGap(current, next) / speed;
    const ms = remaining.current?.key === current.key ? remaining.current.ms : full;
    const started = performance.now();
    const t = window.setTimeout(() => {
      remaining.current = null;
      setReplayAnimated(next.key);
      setCursor(cursor + 1);
    }, ms);
    return () => {
      window.clearTimeout(t);
      remaining.current = { key: current.key, ms: Math.max(0, ms - (performance.now() - started)) };
    };
  }, [replay, playing, cursor, speed, steps]);

  function seek(i: number) {
    remaining.current = null;
    setReplayAnimated(null);
    setPlaying(false);
    setCursor(Math.max(0, Math.min(last, i)));
  }
  function startReplay() {
    remaining.current = null;
    setMode("replay");
    setPinned(null);
    setCursor(0);
    setReplayAnimated(steps[0]?.key ?? null);
    setPlaying(steps.length > 1);
  }
  function goLive() {
    setMode("live");
    setPlaying(false);
    setPinned(null);
  }
  function select(i: number) {
    if (replay) return seek(i);
    if (running) return setPinned(i === live.shown ? null : i);
    setMode("replay");
    setPinned(null);
    seek(i);
  }
  function togglePlay() {
    if (playing) return setPlaying(false);
    if (cursor >= last) { seek(0); setReplayAnimated(steps[0]?.key ?? null); }
    setPlaying(true);
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
        <Button size="sm" onClick={togglePlay} disabled={steps.length < 2} className="w-[92px]">
          {playing ? <Pause /> : <Play />}{playing ? "Pause" : ended ? "Play again" : "Play"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => { seek(0); setReplayAnimated(steps[0]?.key ?? null); setPlaying(steps.length > 1); }}>
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

function HowItWorks() {
  const items = [
    { Icon: Workflow, title: "Agent runtime", file: "agent.py", text: "Application code that runs the loop: send the task, receive code, run it, check the exit code, and decide whether to continue. It stops on DONE, the code run limit, an infrastructure error or Stop. After the last allowed run succeeds, the model gets one final review call to reply DONE; no code runs in that call." },
    { Icon: BrainCircuit, title: "Model", file: "planner.py", text: "Claude writes Python code, fixes it from error feedback, or replies DONE when the previous output satisfies the task. It decides what to write, not how it runs." },
    { Icon: SquareTerminal, title: "Python sandbox", file: "executor.py", text: "Runs each iter_NN.py with a timeout and returns stdout, stderr and the exit code. Missing packages may be installed and the code re-run." },
    { Icon: FolderOutput, title: "Artifacts", file: "workspace.py", text: "Files written to /workspace/output are collected after each execution and kept per iteration, so replay shows the version that existed at that step." },
  ];
  return <details className="studio-card group">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold sm:px-5">
      How it works
      <span className="text-xs font-normal text-muted-foreground">one agent · one loop · four parts</span>
      <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-4 border-t px-4 py-4 sm:grid-cols-2 sm:px-5">
      {items.map(({ Icon, title, file, text }) => <div key={title} className="flex gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-primary"><Icon className="size-4" /></span>
        <div>
          <p className="text-sm font-semibold">{title} <span className="font-mono text-[11px] font-normal text-muted-foreground">{file}</span></p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{text}</p>
        </div>
      </div>)}
      <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
        Every step on this page comes from the run’s recorded activity log. The live view shows new events in order with a short pause so fast hand-offs stay visible, then waits on the real current state.
        Model explanations are the short text the model returned with its code; the model’s internal reasoning is not shown.
      </p>
    </div>
  </details>;
}
