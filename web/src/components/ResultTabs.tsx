import { Eye, FileCode2, FolderOpen, ScrollText, Workflow } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Iteration, LogEntry, RunDetail } from "@/lib/api";
import { ActivityLog } from "./ActivityLog";
import { CodePanel, FilesPanel, PreviewPanel } from "./ResultPanels";

interface Props {
  run: RunDetail;
  iteration: Iteration | null;
  logs: LogEntry[];
  logError: boolean;
  retryLogs: () => void;
  timeline: React.ReactNode;
  flow: React.ReactNode;
  tab: string;
  onTabChange: (t: string) => void;
}

export function ResultTabs({ run, iteration, logs, logError, retryLogs, tab, onTabChange, timeline, flow }: Props) {
  return (
    <Tabs value={tab} onValueChange={onTabChange} className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList className="h-auto max-w-full flex-wrap justify-start sm:h-9 [&_svg]:hidden min-[440px]:[&_svg]:block">
          <TabsTrigger value="preview" className="px-1.5 sm:px-3">
            <Eye /> Preview
          </TabsTrigger>
          <TabsTrigger value="code" className="px-1.5 sm:px-3">
            <FileCode2 /> Code
          </TabsTrigger>
          <TabsTrigger value="logs" className="px-1.5 sm:px-3">
            <ScrollText /> Logs
          </TabsTrigger>
          <TabsTrigger value="files" className="px-1.5 sm:px-3">
            <FolderOpen /> Files
            {run.artifacts.length > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                {run.artifacts.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="flow" className="px-1.5 sm:px-3"><Workflow /> Live Flow</TabsTrigger>
        </TabsList>
        {iteration && tab !== "files" && tab !== "flow" && (
          <span className="text-xs text-muted-foreground">Showing iteration {iteration.number}</span>
        )}
      </div>

      <TabsContent value="flow" className="min-w-0">{flow}</TabsContent>
      {tab !== "flow" && <div className="grid gap-5 lg:grid-cols-[minmax(175px,28%)_minmax(0,1fr)]">
        {timeline}
        <div className="min-w-0">
          <TabsContent value="preview">
            <PreviewPanel run={run} iteration={iteration} />
          </TabsContent>
          <TabsContent value="code">
            <CodePanel run={run} iteration={iteration} />
          </TabsContent>
          <TabsContent value="logs">
            <ActivityLog run={run} logs={logs} selected={iteration} logError={logError} onRetry={retryLogs} />
          </TabsContent>
          <TabsContent value="files">
            <FilesPanel run={run} iteration={iteration} />
          </TabsContent>
        </div>
      </div>}
    </Tabs>
  );
}
