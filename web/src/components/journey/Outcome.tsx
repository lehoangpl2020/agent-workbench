import { CheckCircle2, CircleDashed, CircleSlash, TriangleAlert, XCircle } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import { outcomeOf, type Fact, type FactTone } from "@/lib/journey";
import { cn } from "@/lib/utils";

const ICON: Record<FactTone, typeof CheckCircle2> = { ok: CheckCircle2, bad: XCircle, warn: TriangleAlert, muted: CircleSlash };
const TONE: Record<FactTone, string> = { ok: "text-success", bad: "text-destructive", warn: "text-warning", muted: "text-muted-foreground" };

/**
 * The outcome of a finished run as three separate facts. Exit code 0, the model's DONE and task correctness are
 * different things; nothing here validates the task, and the runtime's false-success heuristic is not a validation.
 */
export function Outcome({ run, onOpenEnd }: { run: RunDetail; onOpenEnd?: () => void }) {
  const meta = RUN_STATUS[run.status];
  const o = outcomeOf(run);
  return <section aria-label="Outcome" className="studio-card overflow-hidden">
    <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b px-4 py-2.5 text-[13px]", TONE_CLASSES[meta.tone])}>
      <span className="font-semibold">{meta.label}.</span>
      <span className="min-w-0 flex-1 line-clamp-2 break-words" title={run.message}>{run.message || "No reason was recorded."}</span>
      {o.partial && <span className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium">Partial result kept</span>}
      {onOpenEnd && <button type="button" onClick={onOpenEnd} className="shrink-0 text-xs font-medium underline-offset-2 hover:underline">
        Why it stopped & evidence</button>}
    </div>
    <dl className="grid divide-y @2xl:grid-cols-3 @2xl:divide-x @2xl:divide-y-0">
      {[o.execution, o.signal, o.validation].map(f => <FactCell key={f.label} fact={f} />)}
    </dl>
  </section>;
}

function FactCell({ fact }: { fact: Fact }) {
  const Icon = fact.label === "Task validation" ? CircleDashed : ICON[fact.tone];
  return <div className="min-w-0 px-4 py-2.5">
    <dt className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{fact.label}</dt>
    <dd className={cn("mt-0.5 flex items-center gap-1.5 text-[13px] font-semibold", TONE[fact.tone])}>
      <Icon className="size-3.5 shrink-0" aria-hidden /><span className="min-w-0 truncate">{fact.value}</span></dd>
    <dd className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{fact.detail}</dd>
  </div>;
}
