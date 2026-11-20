import { useMemo, useState } from "react";
import { Box, ImagePlus, PanelLeftClose, Plus, Search, Terminal, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AppConfig, RunSummary } from "@/lib/api";
import { RUN_STATUS, TONE_DOT, modelLabel, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  runs: RunSummary[] | null;
  selectedId: string | null;
  activeRunId: string | null;
  config: AppConfig | null;
  error: string | null;
  onNewRun: () => void;
  onSelect: (id: string) => void;
  /** Wide screens: hide the history column. */
  onCollapse?: () => void;
}

/** Text a search matches: the prompt and the recorded metadata shown in the row (nothing generated). */
function haystack(r: RunSummary) {
  return [r.prompt, RUN_STATUS[r.status]?.label ?? r.status, r.model, r.model_name, r.provider, r.provider_name, r.id.slice(0, 8)]
    .filter(Boolean).join(" ").toLowerCase();
}

export function Sidebar({ runs, selectedId, activeRunId, config, error, onNewRun, onSelect, onCollapse }: Props) {
  const [query, setQuery] = useState("");
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const shown = useMemo(() => runs?.filter(r => { const h = haystack(r); return terms.every(t => h.includes(t)); }) ?? null,
    [runs, terms]);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Terminal className="size-4" />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold">Agent Workbench</div>
          <div className="text-xs text-muted-foreground">Code Execution Agent</div>
        </div>
        {onCollapse && <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Hide run history" title="Hide run history">
          <PanelLeftClose /></Button>}
      </div>

      <div className="px-3 pb-3">
        <Button className="w-full justify-start" onClick={onNewRun}>
          <Plus /> New run
        </Button>
      </div>

      <div className="eyebrow flex items-baseline justify-between px-4 pb-1.5">
        History
        {runs && runs.length > 0 && <span className="font-normal normal-case">{terms.length ? `${shown?.length ?? 0} of ${runs.length}` : runs.length}</span>}
      </div>
      {runs && runs.length > 0 && <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search task, status, model…"
          aria-label="Search run history"
          className="h-8 w-full rounded-md border border-input bg-card pr-7 pl-7 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden" />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"
          className="absolute top-1/2 right-4.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>}
      </div>}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-2 pb-3">
          {runs === null && !error &&
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="mx-1 my-2 h-12 animate-pulse rounded-md bg-muted" />
            ))}
          {error && <p className="px-2 py-3 text-xs text-destructive">{error}</p>}
          {runs?.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">No runs yet. Start one with a prompt.</p>
          )}
          {shown?.length === 0 && runs && runs.length > 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">No run matches “{query.trim()}”.</p>
          )}
          {shown?.map((r) => {
            const meta = RUN_STATUS[r.status];
            const live = r.id === activeRunId;
            const created = new Date(r.created_at);
            return (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                aria-current={r.id === selectedId ? "page" : undefined}
                title={r.prompt}
                className={cn(
                  "group flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                  r.id === selectedId ? "bg-accent text-accent-foreground shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-muted",
                )}
              >
                <span className="line-clamp-2 text-[13px] leading-snug font-medium">{r.prompt}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[meta?.tone ?? "neutral"], live && "animate-pulse")} />
                  <span className="shrink-0">{meta?.label ?? r.status}</span>
                  <span>·</span>
                  <span className="truncate" title={`${r.provider ?? "provider not recorded"} / ${r.model || "—"}`}>{modelLabel(r)}</span>
                  {r.image_tool && <ImagePlus className="size-3 shrink-0" aria-label="Image tool" />}
                </span>
                <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                  <time dateTime={r.created_at} title={created.toLocaleString()}>{relativeTime(r.created_at)}</time>
                  <span>·</span>
                  <span className="truncate">{r.iteration_count} model call{r.iteration_count === 1 ? "" : "s"}</span>
                  <span className="ml-auto font-mono text-[10.5px]" title={`Run ${r.id}`}>#{r.id.slice(0, 6)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <div className="space-y-2 border-t px-4 py-3 text-xs text-muted-foreground">

        {config && (
          <div className="flex items-center gap-1.5">
            {config.sandboxed === false ? <TriangleAlert className="size-3.5 text-warning" /> : <Box className="size-3.5" />}
            <span className={cn("truncate", config.sandboxed === false && "text-warning")}
              title={config.sandboxed === false ? "Local executor: code runs on this machine without isolation" : config.executor}>
              {config.executor}{config.sandboxed === false && " · not isolated"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
