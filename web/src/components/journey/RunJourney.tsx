import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, Compass, Loader2, LocateFixed, PanelTopClose, PanelTopOpen, Pause, Play, Radio, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { LogEntry, RunDetail } from "@/lib/api";
import { useLivePresenter, useNow } from "@/hooks/useLivePresenter";
import { useReplayClock } from "@/hooks/useReplayClock";
import {
  buildJourney, meaningfulOrder, neighbor, neighborSection, revealedSections, sectionIndex, sectionTarget, sectionTransferStep,
  type JourneySection,
} from "@/lib/journey";
import { buildSteps, REPLAY_MAX_MS, REPLAY_MIN_MS, REPLAY_TRANSFER_MIN_MS, seenAt, type StudioStep } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { HowItWorks } from "../studio/HowItWorks";
import { StudioStage } from "../studio/StudioStage";
import { ActorLegend } from "./ActorChip";
import { Inspector } from "./Inspector";
import { JourneyList } from "./JourneyList";

export interface JourneyHandle {
  /** Select the run's end (why it stopped) and bring the journey into view. */
  selectEnd: () => void;
  /** Select the code run of iteration `n` and bring the journey into view. */
  selectCodeRun: (n: number) => void;
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
function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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

/**
 * Two levels of selection. A *step* (Model call 2, Code run 1, Runtime check...) is what Prev/Next and the journey
 * list visit; its evidence covers everything recorded in it. An *event* (one log entry inside a step) is chosen by
 * clicking a row, and is what Replay plays through. Both keep one selected index, so list, diagram and inspector agree.
 */
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
  const [level, setLevel] = useState<"step" | "event">("step");
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
  const eventLevel = replay || level === "event";
  // A whole step shows everything recorded in it so far; an event shows the state at that event.
  const upto = !eventLevel && section ? Math.min(section.last, revealed) : selected;
  const stageStep = !eventLevel && section ? sectionTransferStep(section, upto) ?? step : step;
  const liveEdge = !replay && upto === last;
  const animate = !!stageStep && (replay ? clock.playing && clock.animatedKey === stageStep.key : following && live.animated === stageStep.key);
  const seen = useMemo(() => seenAt(run, steps, upto), [run, steps, upto]);
  const visible = useMemo(() => revealedSections(sections, revealed), [sections, revealed]);

  const iteration = section?.iteration ?? null;
  useEffect(() => { onIterationChange?.(iteration); }, [iteration, onIterationChange]);

  const box = useRef<HTMLElement>(null);
  const reveal = useCallback(() => {
    requestAnimationFrame(() => box.current?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" }));
  }, []);

  const selectEvent = useCallback((i: number) => {
    if (replay) clock.pause();
    if (running) setFollow(false);
    setLevel("event");
    setPicked(i);
  }, [replay, running, clock]);

  const selectSection = useCallback((s: JourneySection) => {
    if (replay) clock.pause();
    if (running) setFollow(false);
    setLevel("step");
    setPicked(sectionTarget(s, revealed));
  }, [replay, running, clock, revealed]);

  const jumpTo = useCallback((s: JourneySection | undefined) => {
    if (!s) return;
    setMode("explore");
    clock.pause();
    if (running) setFollow(false);
    setLevel("step");
    setPicked(sectionTarget(s, last));
    reveal();
  }, [clock, running, last, reveal]);

  useImperativeHandle(ref, () => ({
    selectEnd: () => jumpTo([...sections].reverse().find(s => s.kind === "end") ?? sections.at(-1)),
    selectCodeRun: (n: number) => jumpTo(sections.find(s => s.kind === "code" && s.iteration === n)),
  }), [jumpTo, sections]);

  // Explore moves between journey steps; replay moves between recorded events.
  const prevStep = neighborSection(sections, section, -1, revealed);
  const nextStep = neighborSection(sections, section, 1, revealed);
  const prevEvent = neighbor(order, selected, -1);
  const nextEvent = neighbor(order, selected, 1);
  const goPrev = replay ? (prevEvent != null ? () => selectEvent(prevEvent) : null) : prevStep ? () => selectSection(prevStep) : null;
  const goNext = replay ? (nextEvent != null ? () => selectEvent(nextEvent) : null) : nextStep ? () => selectSection(nextStep) : null;

  // ── Layout ──
  const [area, width] = useWidth<HTMLDivElement>();
  const wide = width >= WIDE_PX;
  const [panels, setPanels] = useState(() => readPref("journey-panels", false));
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the selected step visible inside the journey column without moving the page.
  useEffect(() => {
    // One frame later, so the first render's layout is settled before measuring
    const frame = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!wide || !el || !section) return;
      const row = (eventLevel && el.querySelector<HTMLElement>(`[data-step="${selected}"]`)) || el.querySelector<HTMLElement>(`[data-section="${section.key}"]`);
      if (!row) return;
      const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      if (top < el.scrollTop || top + Math.min(row.offsetHeight, 120) > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 4);
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, section, eventLevel, wide, steps.length]);

  const liveText = running ? run.activity || undefined : undefined;
  const stepPos = section ? visible.indexOf(section) + 1 : 0;
  const eventPos = order.indexOf(selected) + 1;
  const position = !step ? (historyLoaded ? "No steps yet" : "Loading recorded activity…")
    : replay ? `Recorded event ${eventPos || "–"} of ${order.length}${section ? ` · ${section.title}` : ""}`
    : `Step ${stepPos} of ${visible.length}${section ? ` · ${section.title}` : ""}${eventLevel ? " · one event selected" : ""}`;
  const unit = replay ? "event" : "step";

  const stage = <div className={cn("studio-card overflow-hidden", replay && !clock.playing && "is-paused")}>
    <div className="flex items-center gap-2 border-b px-4 py-1.5">
      <h3 className="text-xs font-semibold">Flow</h3>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">who holds the data at the selected point</span>
      <button type="button" aria-pressed={panels} onClick={() => { setPanels(!panels); writePref("journey-panels", !panels); }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
        {panels ? <PanelTopClose className="size-3.5" /> : <PanelTopOpen className="size-3.5" />}{panels ? "Hide actor panels" : "Actor panels"}</button>
    </div>
    <StudioStage run={run} steps={steps} step={stageStep} seen={seen} animate={animate} speed={replay ? clock.speed : 1}
      liveEdge={liveEdge} now={now} detailed={panels} />
  </div>;

  const inspector = <Inspector run={run} steps={steps} sections={sections} section={section} step={step} upto={upto}
    eventLevel={eventLevel} revealed={revealed} seen={seen} liveEdge={liveEdge} now={now} onSelectEvent={selectEvent} />;

  const list = <JourneyList run={run} sections={sections} selected={selected} eventLevel={eventLevel} revealed={revealed}
    liveIndex={running ? last : null} liveText={liveText} onSelectSection={selectSection} onSelectEvent={selectEvent}
    inline={wide ? undefined : <div className="p-3 sm:p-4">{inspector}</div>} />;

  return <section ref={box} aria-label="Agent journey" className="scroll-mt-2 space-y-3">
    {/* ── Toolbar ── */}
    <div className="studio-card z-10 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 lg:sticky lg:top-2">
      {running ? <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
        <Radio className={cn("size-4", connected ? "text-destructive" : "text-muted-foreground")} />Live
        {!connected && <span className="text-xs font-normal text-warning">· reconnecting…</span>}
      </span> : <div className="studio-segment" role="group" aria-label="View mode">
        <button type="button" aria-pressed={!replay} onClick={() => { setMode("explore"); clock.pause(); setLevel("step"); }}><Compass className="size-3.5" />Explore</button>
        <button type="button" aria-pressed={replay} disabled={!historyLoaded || order.length < 2}
          onClick={() => { if (!replay) { setMode("replay"); clock.restart(); } }}><RotateCcw className="size-3.5" />Replay</button>
      </div>}

      <p className="min-w-0 flex-1 basis-48 truncate text-[13px] text-muted-foreground" aria-live={replay || following ? "polite" : "off"}>
        {replay && <span className="mr-1.5 rounded bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">Replay · read-only</span>}
        {following && <span className="mr-1.5 rounded bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">Following live</span>}
        {position}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {running && !follow && <Button size="sm" onClick={() => { setFollow(true); setPicked(null); setLevel("step"); }}><LocateFixed />Follow live</Button>}
        <Button variant="outline" size="sm" onClick={() => goPrev?.()} disabled={!goPrev} aria-label={`Previous ${unit}`}><ChevronLeft />Prev</Button>
        <Button variant="outline" size="sm" onClick={() => goNext?.()} disabled={!goNext} aria-label={`Next ${unit}`}>Next<ChevronRight /></Button>
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
                Replay plays the recorded events one by one (Prev/Next move by event). It reads the stored log and file snapshots
                only: no model calls, no code runs. Timestamps are original; waits are shortened to {REPLAY_MIN_MS / 1000}–{REPLAY_MAX_MS / 1000}s at 1×
                (at least {REPLAY_TRANSFER_MIN_MS / 1000}s after a hand-off). Technical events are skipped.
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
      recorded events (older version, or the end was not logged). Events marked “rebuilt” come from the run record.</p>}

    <div ref={area} className="@container">
      {wide ? <div className="grid grid-cols-[minmax(300px,380px)_minmax(0,1fr)] items-start gap-3">
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
    <h2 className="text-sm font-semibold">Journey <span className="font-normal text-muted-foreground">· select a step</span></h2>
    <ActorLegend />
  </div>;
}
