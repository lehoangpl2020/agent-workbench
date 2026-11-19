import { useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail } from "@/lib/api";
import { groupSteps, stepTime, type Seen, type StudioStep } from "@/lib/studio";
import { cn } from "@/lib/utils";

interface Props {
  run: RunDetail;
  steps: StudioStep[];
  /** Step shown on the stage. */
  current: number;
  /** Steps after this index have not happened yet in the replay: no labels, no data. */
  revealed: number;
  /** Step shown in the detail panel (may differ from `current` while following live). */
  selected: number;
  seen: Seen;
  onSelect: (index: number) => void;
}

const ACTOR = { model: "Model", runtime: "Runtime", sandbox: "Sandbox" };

export function StudioTimeline({ run, steps, current, revealed, selected, seen, onSelect }: Props) {
  const groups = useMemo(() => groupSteps(steps), [steps]);
  const [hover, setHover] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ticks = useRef(new Map<number, HTMLButtonElement>());

  // Keep the selected tick visible inside the strip (long runs) without moving the page.
  useEffect(() => {
    const box = scroller.current;
    const tick = ticks.current.get(selected);
    if (!box || !tick) return;
    const top = tick.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    if (top < box.scrollTop || top + tick.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 2);
    }
  }, [selected]);

  const shown = hover ?? selected;
  const caption = steps[shown];
  function onKey(e: React.KeyboardEvent) {
    const next = e.key === "ArrowRight" ? selected + 1 : e.key === "ArrowLeft" ? selected - 1
      : e.key === "Home" ? 0 : e.key === "End" ? steps.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const clamped = Math.max(0, Math.min(steps.length - 1, next));
    onSelect(clamped);
    ticks.current.get(clamped)?.focus();
  }

  return <section className="studio-timeline" aria-label="Timeline">
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 sm:px-5">
      <h3 className="text-sm font-semibold">Timeline</h3>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {(["model", "runtime", "sandbox"] as const).map(a => <span key={a} className="inline-flex items-center gap-1">
          <span className={cn("studio-tick !h-2.5 !w-2.5 !rounded-[3px]", `is-${a}`)} aria-hidden />{ACTOR[a]}</span>)}
        <span className="text-xs">{steps.length ? `Step ${current + 1} of ${steps.length}` : "No steps yet"}</span>
      </span>
    </div>
    <div ref={scroller} className="max-h-64 overflow-y-auto px-4 pt-2 pb-2 sm:px-5" role="toolbar" aria-label="Recorded steps" onKeyDown={onKey}>
      <div className="flex flex-wrap gap-2">
        {groups.map(g => {
          const known = g.steps[0].index <= revealed;
          const n = g.iteration;
          const it = run.iterations.find(i => i.number === n);
          const outcome = n == null ? null : seen.done.has(n) ? { text: "DONE", tone: "text-success" }
            : seen.result.has(n) && it?.exit_code != null ? { text: it.timed_out ? "timed out" : `exit ${it.exit_code}`,
              tone: it.exit_code === 0 ? "text-success" : "text-destructive" } : null;
          return <div key={g.key} className={cn("studio-group", !known && "is-future")} style={{ flexGrow: g.steps.length }}>
            <div className="flex h-5 items-center gap-1.5 text-[11px] whitespace-nowrap">
              {known ? <>
                <span className="font-semibold">{g.label}</span>
                {n != null && it && <span className="studio-intent">{it.intent}</span>}
                {outcome && <span className={cn("font-mono", outcome.tone)}>{outcome.text}</span>}
              </> : <span className="text-muted-foreground/70">·</span>}
            </div>
            <div className="flex gap-[3px]">
              {g.steps.map(s => {
                const future = s.index > revealed;
                return <button key={s.key} type="button" ref={el => { if (el) ticks.current.set(s.index, el); else ticks.current.delete(s.index); }}
                  className={cn("studio-tick", `is-${s.actor}`, future && "is-future", s.index === current && "is-current",
                    s.index === selected && "is-selected", !future && s.level === "ERROR" && "is-error", !future && s.level === "WARN" && "is-warn",
                    !future && s.transfer && "is-transfer")}
                  tabIndex={s.index === selected ? 0 : -1}
                  aria-label={future ? `Step ${s.index + 1} (not played yet)` : `Step ${s.index + 1}: ${ACTOR[s.actor]} · ${s.title}`}
                  aria-current={s.index === selected ? "step" : undefined}
                  onMouseEnter={() => setHover(s.index)} onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(null)} onClick={() => onSelect(s.index)} />;
              })}
            </div>
          </div>;
        })}
      </div>
    </div>
    <p className="flex min-h-9 items-center gap-2 border-t px-4 py-2 text-xs sm:px-5" aria-live="off">
      {caption && (caption.index > revealed ? <span className="text-muted-foreground">Step {caption.index + 1} · not played yet — click to jump there</span> : <>
        <time dateTime={caption.ts} className="shrink-0 font-mono text-muted-foreground">{stepTime(caption.ts)}</time>
        <span className={cn("studio-actor-chip shrink-0", `is-${caption.actor}`)}>{ACTOR[caption.actor]}</span>
        <span className="min-w-0 truncate">{caption.title}</span>
      </>)}
    </p>
  </section>;
}
