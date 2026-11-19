import { Box, Plus, Terminal, TriangleAlert } from "lucide-react";
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
}

export function Sidebar({ runs, selectedId, activeRunId, config, error, onNewRun, onSelect }: Props) {
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <Terminal className="size-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Agent Workbench</div>
          <div className="text-xs text-muted-foreground">Code Execution Agent</div>
        </div>
      </div>

      <div className="px-3 pb-3">
        <Button className="w-full justify-start" onClick={onNewRun}>
          <Plus /> New run
        </Button>
      </div>

      <div className="px-4 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">History</div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-2 pb-3">
          {runs === null && !error &&
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="mx-1 my-2 h-10 animate-pulse rounded-md bg-muted" />
            ))}
          {error && <p className="px-2 py-3 text-xs text-destructive">{error}</p>}
          {runs?.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">No runs yet. Start one with a prompt.</p>
          )}
          {runs?.map((r) => {
            const meta = RUN_STATUS[r.status];
            const live = r.id === activeRunId;
            return (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                className={cn(
                  "group flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition",
                  r.id === selectedId ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
              >
                <span className="line-clamp-1 text-[13px] font-medium">{r.prompt}</span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={cn("size-1.5 rounded-full", TONE_DOT[meta?.tone ?? "neutral"], live && "animate-pulse")} />
                  {meta?.label ?? r.status}
                  <span>·</span>
                  {relativeTime(r.created_at)}
                  <span>·</span>
                  <span className="truncate" title={`${r.provider ?? "provider not recorded"} / ${r.model || "—"}`}>
                    {modelLabel(r)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <div className="space-y-2 border-t px-4 py-3 text-[11px] text-muted-foreground">
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
