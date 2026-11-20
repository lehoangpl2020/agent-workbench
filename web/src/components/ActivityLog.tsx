import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDownToLine, ChevronRight, Download, Radio } from "lucide-react";
import type { Iteration, LogEntry, RunDetail } from "@/lib/api";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CopyButton } from "./CodeView";
import { ProcessOutputPanel } from "./ResultPanels";

// Source of the entry: who did this (see observability/runlog.py in the backend)
const SOURCES: Record<string, { label: string; cls: string; title: string }> = {
  // Dark-terminal versions of the actor colors: runtime graphite, model violet (the API call and its text), sandbox teal
  runtime: { label: "RUNTIME", cls: "bg-white/10 text-stone-200", title: "Agent loop (application) action" },
  llm: { label: "LLM CALL", cls: "bg-violet-400/15 text-violet-200", title: "Model API request/response" },
  model: { label: "MODEL", cls: "border border-violet-300/40 text-violet-200", title: "Short explanation written by the model" },
  sandbox: { label: "SANDBOX", cls: "bg-teal-400/15 text-teal-200", title: "Executor / sandbox action" },
};

const LEVEL_CLS: Record<string, string> = {
  INFO: "text-code-muted",
  WARN: "text-amber-300",
  ERROR: "text-[#f3a3b5]",
};

function time(ts: string) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatData(data: Record<string, unknown>) {
  return Object.entries(data)
    // "files": a file name that appears in the message · "flow": internal key for the Live Flow tab
    // "metric": internal tag that runs/metrics.py counts by (duration_ms, tokens... stay visible)
    .filter(([k]) => k !== "files" && k !== "flow" && k !== "metric")
    // "request": the model call's full input; the Journey inspector shows it, one log line cannot
    .map(([k, v]) => k === "request" ? "request=<recorded input, see Journey>"
      : `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

function toText(entries: LogEntry[]) {
  return entries
    .map((e) => {
      const data = formatData(e.data);
      const it = e.iteration ? `iter ${e.iteration}` : "run";
      return `${e.ts}  ${it.padEnd(7)} ${e.level.padEnd(5)} ${e.source.padEnd(7)} ${e.message}${data ? `  [${data}]` : ""}`;
    })
    .join("\n");
}

interface Props {
  run: RunDetail;
  logs: LogEntry[];
  /** Iteration selected in the Timeline (used for the stdout/stderr area when filtering "All") */
  selected: Iteration | null;
  logError?: boolean;
  onRetry?: () => void;
}

export function ActivityLog({ run, logs, selected, logError, onRetry }: Props) {
  const [filter, setFilter] = useState<number | "all">("all");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [follow, setFollow] = useState(true);
  const [outputOpen, setOutputOpen] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const running = run.status === "running";

  const iterations = useMemo(() => {
    const nums = new Set<number>(run.iterations.map((i) => i.number));
    logs.forEach((l) => l.iteration && nums.add(l.iteration));
    return [...nums].sort((a, b) => a - b);
  }, [run.iterations, logs]);

  const visible = useMemo(
    () =>
      logs.filter(
        (l) => (filter === "all" || l.iteration === filter) && (!onlyProblems || l.level !== "INFO"),
      ),
    [logs, filter, onlyProblems],
  );
  const problems = logs.filter((l) => l.level !== "INFO").length;

  // Auto-scroll to the newest entry (turned off when the user scrolls up)
  useEffect(() => {
    const box = boxRef.current;
    if (follow && box) box.scrollTop = box.scrollHeight;
  }, [visible.length, follow]);

  const outputIteration =
    filter === "all" ? selected : (run.iterations.find((i) => i.number === filter) ?? null);

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border border-code-border bg-code">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-code-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              Whole run
            </FilterChip>
            {iterations.map((n) => (
              <FilterChip key={n} active={filter === n} onClick={() => setFilter(n)}>
                Call {n}
              </FilterChip>
            ))}
            <FilterChip active={onlyProblems} onClick={() => setOnlyProblems((v) => !v)} tone="warn">
              WARN/ERROR {problems > 0 && `(${problems})`}
            </FilterChip>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {running && (
              <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#ff9a86]">
                <Radio className="size-3.5 animate-pulse" aria-hidden /> live
              </span>
            )}
            <button
              type="button"
              onClick={() => setFollow((v) => !v)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors",
                follow
                  ? "border-white bg-white text-[#191919]"
                  : "border-white/15 text-code-foreground/80 hover:border-white/40",
              )}
              title="Auto-scroll to the newest entry"
              aria-pressed={follow}
            >
              <ArrowDownToLine className="size-3.5" /> Auto-scroll
            </button>
            <CopyButton text={toText(visible)} label="Copy" />
            <a
              href={api.logsDownloadUrl(run.id, filter === "all" ? null : filter)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/15 px-2 text-xs font-medium text-code-foreground/90 transition-colors hover:border-white/40 hover:bg-white/5"
            >
              <Download className="size-3.5" /> Download
            </a>
          </div>
        </div>

        {logError && (
          <div className="flex items-center gap-2 border-b border-code-border bg-[#b42347]/20 px-3 py-1.5 text-xs text-[#f6c3cf]">
            <AlertCircle className="size-3.5" /> Could not load part of the log.
            {onRetry && <button className="underline" onClick={onRetry}>Retry</button>}
          </div>
        )}

        {/* Entries */}
        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && follow) setFollow(false);
            if (atBottom && !follow) setFollow(true);
          }}
          className="max-h-[520px] min-h-40 overflow-auto py-1.5 font-mono text-[12.5px] leading-relaxed"
          role="log"
          aria-live="polite"
        >
          {visible.length === 0 && (
            <p className="px-3 py-6 text-center text-code-muted">
              {logs.length === 0 ? (running ? "Waiting for the first event…" : "No activity recorded for this run.") : "No entries match this filter."}
            </p>
          )}
          {visible.map((e) => (
            <LogRow key={e.id} entry={e} />
          ))}
          {running && visible.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1 text-code-muted/70">
              <span className="size-1.5 animate-pulse rounded-[1px] bg-[#ff9a86]" aria-hidden /> listening for events…
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-code-border px-3 py-1.5 text-[10.5px] text-code-muted">
          {Object.entries(SOURCES).map(([k, s]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={cn("rounded-xs px-1 font-semibold", s.cls)}>{s.label}</span> {s.title}
            </span>
          ))}
        </div>
      </div>

      {/* Python stdout/stderr — a separate, collapsible area */}
      <div className="surface">
        <button
          type="button"
          onClick={() => setOutputOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-md px-4 py-2.5 text-left text-sm font-semibold hover:bg-accent focus-visible:outline-offset-[-2px]"
          aria-expanded={outputOpen}
        >
          <ChevronRight className={cn("size-4 transition-transform", outputOpen && "rotate-90")} />
          Process output
          <span className="font-normal text-muted-foreground">
            · stdout / stderr {outputIteration ? `of iteration ${outputIteration.number}` : ""}
          </span>
        </button>
        {outputOpen && (
          <div className="space-y-3 border-t px-4 py-3">
            <ProcessOutputPanel run={run} iteration={outputIteration} />
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "warn";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-xs px-2 text-xs font-medium transition-colors",
        active
          ? tone === "warn"
            ? "bg-amber-300 text-[#191919]"
            : "bg-white text-[#191919]"
          : "text-code-muted hover:bg-white/10 hover:text-code-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LogRow({ entry: e }: { entry: LogEntry }) {
  const src = SOURCES[e.source] ?? { label: e.source.toUpperCase(), cls: "bg-white/10 text-code-foreground", title: "" };
  const data = formatData(e.data);
  const isModel = e.source === "model";
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_auto_auto_auto_1fr] items-baseline gap-x-2.5 px-3 py-[3px] hover:bg-white/[0.03]",
        e.level === "ERROR" && "bg-[#b42347]/15",
        e.level === "WARN" && "bg-amber-400/[0.05]",
      )}
    >
      <span className="text-code-muted/70 tabular-nums">{time(e.ts)}</span>
      <span className="w-11 text-code-muted">{e.iteration ? `it ${e.iteration}` : "run"}</span>
      <span className={cn("w-10 font-semibold", LEVEL_CLS[e.level])}>{e.level}</span>
      <span className={cn("rounded-xs px-1 text-[10.5px] font-semibold", src.cls)} title={src.title}>
        {src.label}
      </span>
      <span className="min-w-0 break-words whitespace-pre-wrap">
        <span className={cn(isModel ? "text-violet-100 italic" : "text-code-foreground", e.level === "ERROR" && "text-[#f6c3cf]")}>
          {isModel ? `“${e.message}”` : e.message}
        </span>
        {data && <span className="ml-2 text-code-muted">{data}</span>}
      </span>
    </div>
  );
}
