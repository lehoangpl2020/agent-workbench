import { useMemo, useState } from "react";
import type { Iteration } from "@/lib/api";
import { diffStats, foldDiff, lineDiff } from "@/lib/diff";
import { iterFile } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { CodeView, CopyButton } from "../CodeView";

/**
 * The code a model call returned, with an optional view of the line differences from the previous file. A diff is a
 * comparison of two recorded texts: it shows what changed, never why it changed.
 */
export function CodeCompare({ current, previous, title, follow }: {
  current: Iteration;
  previous: Iteration | null;
  title: string;
  follow?: boolean;
}) {
  const [view, setView] = useState<"code" | "diff">("code");
  // Computed once per pair of files; the counts on the toggle tell the size of the change before it is opened
  const diff = useMemo(() => previous ? lineDiff(previous.code, current.code) : null, [previous, current.code]);
  const stats = diff ? diffStats(diff) : null;

  return <div className="space-y-2">
    {previous && <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div className="studio-segment max-w-full [&>button]:whitespace-nowrap" role="group" aria-label="Code view">
        <button type="button" aria-pressed={view === "code"} onClick={() => setView("code")}>{iterFile(current.number)}</button>
        <button type="button" aria-pressed={view === "diff"} onClick={() => setView("diff")}
          aria-label={`Changes since ${iterFile(previous.number)}`}>
          Changes<span className="hidden sm:inline"> since {iterFile(previous.number)}</span>
          {stats && <span className="font-mono text-[12px] tabular-nums">
            <span className={view === "diff" ? "" : "text-success"}>+{stats.added}</span>{" "}
            <span className={view === "diff" ? "" : "text-destructive"}>−{stats.removed}</span></span>}
        </button>
      </div>
      {view === "diff" && <p className="min-w-0 flex-1 basis-60 text-[13px] leading-snug text-muted-foreground">
        A comparison of the two recorded files. It shows what changed, not why.</p>}
    </div>}
    {view === "code" || !previous
      ? <CodeView code={current.code} language={current.language} title={title} follow={follow} />
      : diff ? <DiffView diff={diff} from={iterFile(previous.number)} to={iterFile(current.number)} text={current.code} />
      : <p className="text-[13px] text-muted-foreground">These files are too large to compare here. Both are shown in their own code runs.</p>}
  </div>;
}

function DiffView({ diff, from, to, text }: { diff: NonNullable<ReturnType<typeof lineDiff>>; from: string; to: string; text: string }) {
  const [all, setAll] = useState(false);
  const rows = all ? diff : foldDiff(diff);
  const { added, removed } = diffStats(diff);
  return <div className="overflow-hidden rounded-md border border-code-border bg-code">
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-code-border px-3 py-1.5">
      <span className="min-w-0 flex-1 basis-40 font-mono text-xs text-code-muted">{from} → {to} · {added} added, {removed} removed</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={() => setAll(v => !v)} aria-pressed={all}
          className="rounded-xs px-2 py-1 text-xs font-medium whitespace-nowrap text-code-foreground/90 hover:bg-white/10">{all ? "Changes only" : "Whole file"}</button>
        <CopyButton text={text} label={`Copy ${to}`} />
      </span>
    </div>
    {added + removed === 0
      ? <p className="px-3 py-3 font-mono text-[13px] text-code-muted">The two files are identical.</p>
      : <pre className="max-h-[560px] overflow-auto py-2 font-mono text-[13px] leading-relaxed" aria-label={`Line differences from ${from} to ${to}`}>
        {rows.map((r, k) => r.kind === "gap"
          ? <div key={k} className="px-3 py-0.5 text-[12px] text-code-muted/80 select-none">··· {r.hidden} unchanged line{r.hidden === 1 ? "" : "s"}</div>
          : <div key={k} className={cn("flex", r.kind === "add" && "bg-emerald-400/10", r.kind === "del" && "bg-rose-400/10")}>
            <span className="w-10 shrink-0 pr-2 text-right text-code-muted/70 select-none">{r.a ?? ""}</span>
            <span className="w-10 shrink-0 pr-2 text-right text-code-muted/70 select-none">{r.b ?? ""}</span>
            <span className={cn("w-5 shrink-0 text-center select-none", r.kind === "add" ? "text-emerald-300" : r.kind === "del" ? "text-[#f3a3b5]" : "text-code-muted/50")}
              aria-label={r.kind === "add" ? "added" : r.kind === "del" ? "removed" : undefined}>
              {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
            <span className={cn("min-w-0 flex-1 pr-4 whitespace-pre", r.kind === "add" ? "text-emerald-100" : r.kind === "del" ? "text-[#f6c3cf]" : "text-code-foreground/80")}>{r.text || " "}</span>
          </div>)}
      </pre>}
  </div>;
}
