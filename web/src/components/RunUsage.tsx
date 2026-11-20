import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { formatMs } from "@/lib/format";
import { callsNote, costLabel, modelTimeShare, NO_DATA, tokensLabel } from "@/lib/usage";
import { cn } from "@/lib/utils";

function Stat({ label, value, sub, title, muted }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; muted?: boolean }) {
  return (
    <div className="min-w-0 border-l pl-3" title={title}>
      <dt className="text-[12px] font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 font-mono text-[15px] font-semibold tabular-nums", muted && "font-sans text-sm font-normal text-muted-foreground")}>{value}</dd>
      {sub && <dd className="mt-0.5 text-[11px] leading-snug text-muted-foreground tabular-nums">{sub}</dd>}
    </div>
  );
}

/** Model calls, tokens, time in the model and in the sandbox, and the estimated cost of one run (backend runs/metrics.py). */
export function RunUsage({ run }: { run: RunDetail }) {
  const { llm, sandbox, wall_ms, cost } = run.summary;
  const running = run.status === "running" || run.status === "pending";

  if (!llm && !sandbox) {
    return (
      <p className="surface px-4 py-3 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Usage &amp; cost:</span>{" "}
        {running ? "waiting for the first model response…"
          : "no data. This run has no measured model calls (for example, it was stored before usage was tracked)."}
      </p>
    );
  }

  const c = costLabel(cost);
  const modelMs = llm?.duration_ms ?? null;
  const sandboxMs = sandbox?.duration_ms ?? null;
  const share = modelTimeShare(modelMs, sandboxMs);
  const tokens = tokensLabel(llm);
  const tokensUnknown = !llm || llm.calls_with_usage === 0;

  return (
    <section className="surface px-4 py-3.5 sm:px-5" aria-label="Usage and cost">
      <h2 className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 text-sm font-semibold">
        Usage &amp; cost
        {running && <span className="text-xs font-normal text-muted-foreground">updating live</span>}
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Model calls" value={llm ? llm.calls : NO_DATA} muted={!llm} sub={callsNote(llm)}
          title="Includes calls resent after invalid JSON, and failed calls" />
        <Stat label="Tokens in / out" value={tokens} muted={tokensUnknown}
          sub={llm && !tokensUnknown && !llm.usage_complete ? "floor: some calls reported no usage" : undefined}
          title="Token counts exactly as the provider reported them" />
        <Stat label="Model time" value={modelMs == null ? NO_DATA : formatMs(modelMs)} muted={modelMs == null}
          sub={llm?.first_token_ms_avg != null ? `first token avg ${formatMs(llm.first_token_ms_avg)}` : undefined}
          title="Time spent waiting for the model, summed over all calls" />
        <Stat label="Sandbox time" value={sandbox ? formatMs(sandboxMs) : NO_DATA} muted={!sandbox}
          sub={sandbox ? `${sandbox.runs} code run${sandbox.runs === 1 ? "" : "s"}` : undefined}
          title="Time the executor measured while running code (includes an automatic pip install)" />
        <Stat label="Total" value={running ? "running…" : formatMs(wall_ms)} muted={running || wall_ms == null}
          sub={share != null ? `model ${share}% · sandbox ${100 - share}% of measured` : undefined}
          title="Wall-clock time from the start of the run to its end" />
        <Stat label="Est. cost" value={c.value} muted={!c.known} title={c.hint} />
      </dl>
    </section>
  );
}

/** One line for the run header: the numbers a learner needs, with the full card behind "Details". */
export function UsageSummary({ run }: { run: RunDetail }) {
  const [open, setOpen] = useState(false);
  const { llm, sandbox, wall_ms, cost } = run.summary;
  const running = run.status === "running" || run.status === "pending";
  const c = costLabel(cost);
  const parts = !llm && !sandbox ? [running ? "waiting for the first model response" : "no data for this run"] : [
    llm ? `${llm.calls} model call${llm.calls === 1 ? "" : "s"}` : `model calls: ${NO_DATA}`,
    `tokens ${tokensLabel(llm)}`,
    `model ${formatMs(llm?.duration_ms ?? null)}`,
    `sandbox ${sandbox ? formatMs(sandbox.duration_ms) : NO_DATA}`,
    running ? "running…" : `total ${formatMs(wall_ms)}`,
    `cost ${c.value}`,
  ];
  return <div className="text-xs text-muted-foreground">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-[12px] font-semibold">Usage</span>
      <span className="min-w-0 font-mono text-[11.5px] tabular-nums">{parts.join(" · ")}</span>
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
        className="text-link inline-flex items-center gap-0.5">
        {open ? "Hide usage details" : "Usage details"}<ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
    </div>
    {open && <div className="mt-2"><RunUsage run={run} /></div>}
  </div>;
}
