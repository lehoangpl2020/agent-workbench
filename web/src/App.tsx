import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, Menu, PanelLeftOpen, SquareTerminal, TriangleAlert, Workflow } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Composer, type ComposerDraft } from "@/components/Composer";
import { RunView } from "@/components/RunView";
import { BrandMark, Sidebar } from "@/components/Sidebar";
import { api, type AppConfig, type RunSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

// Minimal routing via the URL hash: #/ = New run, #/runs/<id> = view one run.
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
  // Wide screens can hide the history so a run gets the full width; remembered per browser
  const [historyOpen, setHistoryOpen] = useState(() => {
    try { return localStorage.getItem("history-open") !== "0"; } catch { return true; }
  });
  const toggleHistory = useCallback((open: boolean) => {
    setHistoryOpen(open);
    try { localStorage.setItem("history-open", open ? "1" : "0"); } catch { /* storage blocked */ }
  }, []);

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

  // While a run is active: refresh the sidebar periodically (status, finished runs)
  useEffect(() => {
    if (!activeRunId) return;
    const t = window.setInterval(() => void refreshRuns(), 4000);
    return () => window.clearInterval(t);
  }, [activeRunId, refreshRuns]);

  const sidebar = (collapsible: boolean) => (
    <Sidebar
      onCollapse={collapsible ? () => toggleHistory(false) : undefined}
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
      {historyOpen && <aside className="hidden w-72 shrink-0 border-r bg-sidebar lg:block">{sidebar(true)}</aside>}
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar(false)}
        </SheetContent>
      </Sheet>

      {/* relative: absolutely positioned descendants (sr-only labels) stay inside this scroller, not the page */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b bg-card px-3 py-2 lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu />
          </Button>
          <BrandMark className="size-6" />
          <span className="text-[15px] font-semibold tracking-tight">Agent Workbench</span>
        </div>

        {!historyOpen && <Button variant="outline" size="sm" className="fixed top-3 left-3 z-20 hidden lg:inline-flex"
          onClick={() => toggleHistory(true)} aria-label="Show run history"><PanelLeftOpen /> History</Button>}
        <div className={cn("mx-auto w-full px-4 py-5 sm:px-6 sm:py-7 lg:px-10", runId ? "max-w-[1480px]" : "max-w-[1040px]",
          !historyOpen && "lg:pt-14")}>
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
            <div className="space-y-8 sm:space-y-10">
              <header className="max-w-[62ch]">
                <p className="eyebrow flex items-center gap-2"><span className="mark bg-brand" aria-hidden />Code execution agent</p>
                <h1 className="mt-3 text-[36px] leading-[1.05] font-semibold tracking-[-0.025em] sm:text-[48px]">New run</h1>
                <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground sm:text-base">
                  The agent writes Python, runs it, reads the result and keeps iterating until the model
                  confirms the task is done.
                </p>
              </header>
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
    <Alert className="border-warning/35 bg-warning-soft text-warning">
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
    { icon: BrainCircuit, who: "Model", cls: "text-model",
      text: "Decides what Python to write for your task, how to fix it after an error, and when to reply DONE." },
    { icon: Workflow, who: "Runtime", cls: "text-runtime",
      text: "Application code that runs the loop: sends the task and every result to the model, and applies the stop rules." },
    { icon: SquareTerminal, who: "Sandbox", cls: "text-sandbox",
      text: sandboxed ? "Runs each script in Docker with a real timeout and returns stdout, stderr, the exit code and files."
        : "Runs each script as a local process (not isolated) with a real timeout and returns stdout, stderr, the exit code and files." },
  ];
  return (
    <section aria-labelledby="who-does-what">
      <div className="rule-head">
        <h2 id="who-does-what" className="text-[15px] font-semibold tracking-tight">Who does what in a run</h2>
        <p className="text-[13px] text-muted-foreground">Every recorded step on the run page names the actor that performed it.</p>
      </div>
      <ol className="mt-5 grid gap-6 sm:grid-cols-3 sm:gap-0 sm:divide-x">
        {steps.map((s, i) => (
          <li key={s.who} className="sm:px-5 sm:first:pl-0 sm:last:pr-0">
            <div className="flex items-center gap-2">
              <span className="idx">{String(i + 1).padStart(2, "0")}</span>
              <s.icon className={cn("size-4", s.cls)} aria-hidden />
              <span className="text-sm font-semibold">{s.who}</span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
