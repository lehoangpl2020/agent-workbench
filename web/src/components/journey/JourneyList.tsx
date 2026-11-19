import { useState } from "react";
import { ChevronRight, CornerDownRight } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { sectionSummary, type JourneySection } from "@/lib/journey";
import { stepTime, type StudioStep } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { ACTOR_ICON } from "./ActorChip";

interface Props {
  run: RunDetail;
  steps: StudioStep[];
  sections: JourneySection[];
  selected: number;
  /** Steps after this index are not shown (replay has not reached them). */
  revealed: number;
  /** The live edge: the section that is happening right now, if any. */
  liveIndex: number | null;
  liveText?: string;
  onSelect: (index: number) => void;
  /** Narrow layouts render the inspector right below the selected section. */
  inline?: React.ReactNode;
}

const TONE = { ok: "text-success", bad: "text-destructive", warn: "text-warning", muted: "text-muted-foreground" } as const;

export function JourneyList({ run, steps, sections, selected, revealed, liveIndex, liveText, onSelect, inline }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const visible = sections.filter(s => s.first <= revealed);
  const hidden = steps.length - 1 - revealed;
  const selectedSection = sections.find(s => s.steps.some(st => st.index === selected));

  function onKey(e: React.KeyboardEvent<HTMLOListElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-journey-item]")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    const target = items[next];
    if (!target) return;
    e.preventDefault();
    target.focus();
    target.click();
  }

  return <ol className="space-y-2" aria-label="Agent journey" onKeyDown={onKey}>
    {visible.map(section => {
      const Icon = ACTOR_ICON[section.actor];
      const isSel = section === selectedSection;
      const live = liveIndex != null && section.steps.some(s => s.index === liveIndex) && section === visible.at(-1);
      const summary = sectionSummary(section, run, revealed, sections);
      const main = section.main.filter(s => s.index <= revealed);
      const technical = section.technical.filter(s => s.index <= revealed);
      const open = expanded.has(section.key);
      const selStep = steps[selected];
      const selHidden = isSel && selStep && !main.includes(selStep) && !(open && technical.includes(selStep));
      return <li key={section.key} className={cn("journey-section", `is-${section.actor}`, isSel && "is-selected")}>
        <button type="button" data-journey-item data-step={section.focus} onClick={() => onSelect(section.focus <= revealed ? section.focus : section.last)}
          aria-current={selHidden ? "step" : undefined}
          className={cn("journey-head", selHidden && "is-current")}>
          <span className="journey-icon" aria-hidden><Icon className="size-3.5" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] leading-snug font-semibold">
              {section.title}<span className="font-normal text-muted-foreground"> — {section.purpose}</span>
            </span>
            {summary && <span className={cn("mt-0.5 block truncate font-mono text-[11px]", TONE[summary.tone])}>{summary.text}</span>}
            {selHidden && <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">Selected: {selStep.title}</span>}
            {live && liveText && !selHidden && <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-primary">
              <span className="studio-dot bg-primary animate-pulse" aria-hidden />{liveText}</span>}
          </span>
        </button>
        {(main.length > 0 || technical.length > 0) && <div className="journey-rows">
          {main.map(s => <Row key={s.key} step={s} selected={s.index === selected} onSelect={onSelect} />)}
          {technical.length > 0 && <>
            <button type="button" aria-expanded={open} className="journey-more"
              onClick={() => setExpanded(prev => { const next = new Set(prev); if (next.has(section.key)) next.delete(section.key); else next.add(section.key); return next; })}>
              <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
              {open ? "Hide" : "Show"} {technical.length} technical event{technical.length === 1 ? "" : "s"}
              {section.formatRetries > 0 && <span className="text-warning"> · resent after invalid JSON</span>}
            </button>
            {open && technical.map(s => <Row key={s.key} step={s} technical selected={s.index === selected} onSelect={onSelect} />)}
          </>}
        </div>}
        {isSel && inline && <div className="journey-inline">{inline}</div>}
      </li>;
    })}
    {hidden > 0 && <li className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      {hidden} more recorded step{hidden === 1 ? "" : "s"} · not played yet</li>}
  </ol>;
}

function Row({ step, selected, technical, onSelect }: { step: StudioStep; selected: boolean; technical?: boolean; onSelect: (i: number) => void }) {
  const feedback = step.beat === "send" && (step.intent === "fix" || step.intent === "review");
  return <button type="button" data-journey-item data-step={step.index} onClick={() => onSelect(step.index)}
    aria-current={selected ? "step" : undefined}
    className={cn("journey-row", selected && "is-current", technical && "is-technical",
      step.level === "ERROR" && "is-error", step.level === "WARN" && step.beat !== "send" && "is-warn", feedback && `is-feedback tone-${step.intent}`)}>
    {feedback ? <CornerDownRight className="size-3 shrink-0" aria-hidden /> : <span className="journey-dot" aria-hidden />}
    <span className="min-w-0 flex-1 truncate">{step.title}</span>
    <time dateTime={step.ts} className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{stepTime(step.ts).slice(0, 8)}</time>
  </button>;
}
