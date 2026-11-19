import { useCallback, useEffect, useState } from "react";
import { Cpu, FileImage, Menu, RotateCcw, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Composer, type ComposerDraft } from "@/components/Composer";
import { RunView } from "@/components/RunView";
import { Sidebar } from "@/components/Sidebar";
import { api, type AppConfig, type RunSummary } from "@/lib/api";

// Routing tối giản bằng URL hash: #/ = New run, #/runs/<id> = xem 1 run.
function readRoute(): string | null {
  const m = window.location.hash.match(/^#\/runs\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

export default function App() {
  const [runId, setRunId] = useState<string | null>(readRoute);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setRunId(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((id: string | null) => {
    window.location.hash = id ? `#/runs/${id}` : "#/";
    setRunId(id);
    setMenuOpen(false);
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const data = await api.listRuns();
      setRuns(data.runs);
      setActiveRunId(data.active_run_id);
      setRunsError(null);
    } catch (e) {
      setRunsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
    api.config().then(setConfig).catch(() => setConfig(null));
  }, [refreshRuns]);

  // Khi có run đang chạy: làm mới sidebar định kỳ (trạng thái, run kết thúc)
  useEffect(() => {
    if (!activeRunId) return;
    const t = window.setInterval(() => void refreshRuns(), 4000);
    return () => window.clearInterval(t);
  }, [activeRunId, refreshRuns]);

  const sidebar = (
    <Sidebar
      runs={runs}
      selectedId={runId}
      activeRunId={activeRunId}
      config={config}
      error={runsError}
      onNewRun={() => {
        setDraft(null);
        setDraftKey((k) => k + 1);
        navigate(null);
      }}
      onSelect={navigate}
    />
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-72 shrink-0 border-r lg:block">{sidebar}</aside>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu />
          </Button>
          <span className="text-sm font-semibold">Agent Workbench</span>
        </div>

        <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
          {runId ? (
            <RunView
              key={runId}
              runId={runId}
              onChanged={refreshRuns}
              onEdit={(d) => {
                setDraft(d);
                setDraftKey((k) => k + 1);
                navigate(null);
              }}
            />
          ) : (
            <div className="space-y-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  The agent writes Python, runs it, reads the result and keeps iterating until the model
                  confirms the task is done.
                </p>
              </div>
              {config?.sandboxed === false && <LocalModeWarning />}
              <Composer
                key={draftKey}
                config={config}
                activeRunId={activeRunId}
                draft={draft}
                onStarted={(run) => {
                  setActiveRunId(run.id);
                  void refreshRuns();
                  navigate(run.id);
                }}
                onOpenRun={navigate}
              />
              <EmptyState sandboxed={config?.sandboxed !== false} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function LocalModeWarning() {
  return (
    <Alert className="border-warning/40 bg-warning-soft text-warning">
      <TriangleAlert />
      <AlertTitle>Local mode: code is not isolated</AlertTitle>
      <AlertDescription className="text-foreground/80">
        This server uses the local executor. Code written by the model runs directly on this machine with your
        user's permissions, and only the packages installed in this Python environment are available. Use Docker
        Compose for the sandboxed setup.
      </AlertDescription>
    </Alert>
  );
}

function EmptyState({ sandboxed }: { sandboxed: boolean }) {
  const steps = [
    { icon: Cpu, title: "Plan", text: "The model writes a complete Python script for your request." },
    { icon: FileImage, title: "Execute", text: sandboxed
      ? "The script runs in a Docker sandbox with a real timeout. Files land in this run's output folder."
      : "The script runs as a local process with a real timeout (not isolated). Files land in this run's output folder." },
    { icon: RotateCcw, title: "Evaluate", text: "Errors and output go back to the model. It fixes the code or replies DONE." },
  ];
  return (
    <div className="rounded-xl border border-dashed bg-card/50 p-5 sm:p-6">
      <div className="text-sm font-medium">Results will appear here</div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {steps.map((s, i) => (
          <div key={s.title} className="flex gap-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
              <s.icon className="size-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                {i + 1}. {s.title}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
