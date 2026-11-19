import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Compass, Loader2, LocateFixed, Pause, Play, Radio, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { LogEntry, RunDetail } from "@/lib/api";
import { useLivePresenter, useNow } from "@/hooks/useLivePresenter";
import { useReplayClock } from "@/hooks/useReplayClock";
import { buildJourney, meaningfulOrder, neighbor, sectionIndex } from "@/lib/journey";
import { buildSteps, REPLAY_MAX_MS, REPLAY_MIN_MS, REPLAY_TRANSFER_MIN_MS, seenAt, type StudioStep } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { HowItWorks } from "../studio/HowItWorks";
import { StudioStage } from "../studio/StudioStage";
import { ActorLegend } from "./ActorChip";
import { Inspector } from "./Inspector";
import { JourneyList } from "./JourneyList";

export interface JourneyHandle {
  /** Select the run's last step (its outcome and evidence). */
  selectEnd: () => void;
}

interface Props {
  run: RunDetail;
  logs: LogEntry[];
  connected: boolean;
  logError: boolean;
  historyLoaded: boolean;
  retryLogs: () => void;
  stopping: boolean;
  onStop: () => void;
  onIterationChange?: (iteration: number | null) => void;
  ref?: Ref<JourneyHandle>;
}

const SPEEDS = [1, 2, 4];
const EMPTY = { steps: [] as StudioStep[], partial: false };
// Width of the journey area from which the inspector gets its own column (otherwise it opens inside the list)
const WIDE_PX = 860;

function readPref(key: string, fallback: boolean) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === "1"; } catch { return fallback; }
}
function writePref(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* storage blocked: keep the in-memory value */ }
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function RunJourney({ run, logs, connected, logError, historyLoaded, retryLogs, stopping, onStop, onIterationChange, ref }: Props) {
  const { steps, partial } = useMemo(() => historyLoaded ? buildSteps(run, logs) : EMPTY, [historyLoaded, run, logs]);
  const sections = useMemo(() => buildJourney(run, steps), [run, steps]);
  const bySection = useMemo(() => sectionIndex(sections), [sections]);
  const order = useMemo(() => meaningfulOrder(sections), [sections]);
  const running = run.status === "running" || run.status === "pending";
  const last = steps.length - 1;

  const [mode, setMode] = useState<"explore" | "replay">("explore");
  const [follow, setFollow] = useState(true);
  const [picked, setPicked] = useState<number | null>(null);
  const live = useLivePresenter(steps, historyLoaded);
  const replay = mode === "replay";
  const following = running && follow && !replay;

  const selected = Math.max(0, Math.min(last,
    replay ? picked ?? order[0] ?? 0 : following ? live.shown : picked ?? last));
  const clock = useReplayClock({ steps, order, index: selected, onStep: setPicked, active: replay });
  const now = useNow(running);

  useEffect(() => { if (running && replay) { setMode("explore"); clock.pause(); } }, [running, replay, clock]);

  const step = steps[selected];
  const section = step ? bySection.get(step.index) : undefined;
  const revealed = replay ? selected : running ? Math.max(selected, live.shown) : last;
  const liveEdge = !replay && selected === last;
  const animate = replay ? clock.playing && clock.animatedKey === step?.key : following && live.animated === step?.key;
  const seen = useMemo(() => seenAt(run, steps, selected), [run, steps, selected]);

  const iteration = section?.iteration ?? null;
  useEffect(() => { onIterationChange?.(iteration); }, [iteration, onIterationChange]);

  const select = useCallback((i: number) => {
    if (replay) clock.pause();
    if (running) setFollow(false);
    setPicked(i);
  }, [replay, running, clock]);

  useImperativeHandle(ref, () => ({ selectEnd: () => { setMode("explore"); clock.pause(); setPicked(last); } }), [last, clock]);

  const prev = neighbor(order, selected, -1);
  const next = neighbor(order, selected, 1);

  // ── Layout ──
  const [box, width] = useWidth<HTMLDivElement>();
  const wide = width >= WIDE_PX;
  const [diagram, setDiagram] = useState(() => readPref("journey-diagram", true));
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the selected row visible inside the journey column without moving the page.
  useEffect(() => {
    // One frame later, so the first render's layout is settled before measuring
    const frame = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!wide || !el) return;
      const row = el.querySelector<HTMLElement>(`[data-step="${selected}"][aria-current="step"]`) ?? el.querySelector<HTMLElement>(`[data-step="${selected}"]`);
      if (!row) return;
      const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      if (top < el.scrollTop || top + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, wide, steps.length]);

  const liveText = running ? run.activity || undefined : undefined;
  const position = step ? `Step ${selected + 1} of ${steps.length}${section ? ` · ${section.title}` : ""}` : historyLoaded ? "No steps yet" : "Loading recorded activity…";

  const stage = <details open={diagram} onToggle={e => { const open = (e.currentTarget as HTMLDetailsElement).open; setDiagram(open); writePref("journey-diagram", open); }}
    className={cn("studio-card group overflow-hidden", replay && !clock.playing && "is-paused")}>
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
      <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />Flow diagram
      <span className="font-normal">· where the data is at the selected step</span>
    </summary>
    <div className="border-t">
      <StudioStage run={run} steps={steps} step={step} seen={seen} animate={animate} speed={replay ? clock.speed : 1} liveEdge={liveEdge} now={now} />
    </div>
  </details>;

  const inspector = <Inspector run={run} steps={steps} sections={sections} section={section} step={step} seen={seen}
    liveEdge={liveEdge} now={now} onSelect={select} />;

  const list = <JourneyList run={run} steps={steps} sections={sections} selected={selected} revealed={revealed}
    liveIndex={running ? last : null} liveText={liveText} onSelect={select} inline={wide ? undefined : <div className="p-3 sm:p-4">{inspector}</div>} />;

  return <section aria-label="Agent journey" className="space-y-3">
    {/* ── Toolbar ── */}
    <div className="studio-card z-10 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 lg:sticky lg:top-2">
      {running ? <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
        <Radio className={cn("size-4", connected ? "text-destructive" : "text-muted-foreground")} />Live
        {!connected && <span className="text-xs font-normal text-warning">· reconnecting…</span>}
      </span> : <div className="studio-segment" role="group" aria-label="View mode">
        <button type="button" aria-pressed={!replay} onClick={() => { setMode("explore"); clock.pause(); }}><Compass className="size-3.5" />Explore</button>
        <button type="button" aria-pressed={replay} disabled={!historyLoaded || order.length < 2}
          onClick={() => { if (!replay) { setMode("replay"); clock.restart(); } }}><RotateCcw className="size-3.5" />Replay</button>
      </div>}

      <p className="min-w-0 flex-1 basis-48 truncate text-[13px] text-muted-foreground" aria-live={replay || following ? "polite" : "off"}>
        {replay && <span className="mr-1.5 rounded bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">Replay · read-only</span>}
        {position}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {running && !follow && <Button size="sm" onClick={() => { setFollow(true); setPicked(null); }}><LocateFixed />Follow live</Button>}
        {running && follow && <span className="text-xs text-muted-foreground">Following live</span>}
        <Button variant="outline" size="sm" onClick={() => prev != null && select(prev)} disabled={prev == null} aria-label="Previous step"><ChevronLeft />Prev</Button>
        <Button variant="outline" size="sm" onClick={() => next != null && select(next)} disabled={next == null} aria-label="Next step">Next<ChevronRight /></Button>
        {replay && <>
          <Button size="sm" onClick={clock.toggle} className="w-[104px]">{clock.playing ? <Pause /> : <Play />}{clock.playing ? "Pause" : clock.atEnd ? "Play again" : "Play"}</Button>
          <div className="studio-segment" role="group" aria-label="Playback speed">
            {SPEEDS.map(s => <button key={s} type="button" aria-pressed={clock.speed === s} onClick={() => clock.setSpeed(s)}>{s}×</button>)}
          </div>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="About replay">
                  <CircleHelp className="size-4" /></button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-72 text-left">
                Replay reads the recorded log and file snapshots only. It makes no model calls and runs no code.
                It visits the meaningful steps; timestamps are original, and waits are shortened to {REPLAY_MIN_MS / 1000}–{REPLAY_MAX_MS / 1000}s at 1×
                (at least {REPLAY_TRANSFER_MIN_MS / 1000}s after a hand-off).
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </>}
        {running && <Button variant="destructive" size="sm" onClick={onStop} disabled={stopping}>
          {stopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}{stopping ? "Stopping…" : "Stop"}</Button>}
      </div>
    </div>

    {logError && <p className="text-xs text-warning">Activity history could not be loaded. <button className="underline" onClick={retryLogs}>Retry</button></p>}
    {partial && <p className="text-xs text-muted-foreground"><strong className="font-semibold text-foreground">Partial history:</strong> this run was stored with fewer
      recorded steps (older version, or the end was not logged). Steps marked “rebuilt” come from the run record.</p>}

    <div ref={box} className="@container">
      {wide ? <div className="grid grid-cols-[minmax(320px,400px)_minmax(0,1fr)] items-start gap-3">
        <div ref={scroller} className="studio-card sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto p-3">
          <JourneyHeader />
          {list}
        </div>
        <div className="min-w-0 space-y-3">
          {stage}
          <aside className="studio-card p-4 sm:p-5" aria-label="Step inspector">{inspector}</aside>
        </div>
      </div> : <div className="space-y-3">
        {stage}
        <div className="studio-card p-3"><JourneyHeader />{list}</div>
      </div>}
    </div>

    <HowItWorks />
  </section>;
}

function JourneyHeader() {
  return <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 px-1">
    <h2 className="text-sm font-semibold">Journey</h2>
    <ActorLegend />
  </div>;
}
