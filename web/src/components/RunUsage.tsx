import type { ReactNode } from "react";
import type { RunDetail } from "@/lib/api";
import { formatMs } from "@/lib/format";
import { callsNote, costLabel, modelTimeShare, NO_DATA, tokensLabel } from "@/lib/usage";
import { cn } from "@/lib/utils";

function Stat({ label, value, sub, title, muted }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; muted?: boolean }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn("mt-0.5 text-sm font-semibold tabular-nums", muted && "font-normal text-muted-foreground")}>{value}</dd>
      {sub && <dd className="text-[11px] text-muted-foreground tabular-nums">{sub}</dd>}
    </div>
  );
}

/** Model calls, tokens, time in the model and in the sandbox, and the estimated cost of one run (backend runs/metrics.py). */
export function RunUsage({ run }: { run: RunDetail }) {
  const { llm, sandbox, wall_ms, cost } = run.summary;
  const running = run.status === "running" || run.status === "pending";

  if (!llm && !sandbox) {
    return (
      <p className="rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
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
    <section className="rounded-xl border bg-card px-4 py-3 sm:px-5" aria-label="Usage and cost">
      <h2 className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 text-sm font-semibold">
        Usage &amp; cost
        {running && <span className="text-xs font-normal text-muted-foreground">updating live</span>}
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
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
