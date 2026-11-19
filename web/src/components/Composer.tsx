import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, BrainCircuit, CheckCircle2, Loader2, Play, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, type AppConfig, type ProvidersResponse, type RunDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

// Clicking only fills in the prompt; the user presses Run themselves.
const EXAMPLES = [
  {
    label: "Draw a cute bee",
    prompt:
      "Draw a cute cartoon bee with matplotlib: yellow oval body with black stripes, two light-blue translucent wings, a round head with big eyes and a smile, two antennae and a small stinger. Save it as /workspace/output/bee.png (dpi=150) and print the file path.",
  },
  { label: "Calculate pi", prompt: "Calculate pi to 50 decimal places and print the result." },
  {
    label: "Plot sin(x)",
    prompt:
      "Plot sin(x) for x from 0 to 4π with matplotlib, with labeled axes, a grid and a title. Save it as /workspace/output/sin.png and print the file path.",
  },
];

export interface ComposerDraft {
  prompt: string;
  maxIterations?: number;
  timeoutSeconds?: number;
  provider?: string | null;
  model?: string;
}

interface Props {
  config: AppConfig | null;
  activeRunId: string | null;
  draft: ComposerDraft | null;
  onStarted: (run: RunDetail) => void;
  onOpenRun: (id: string) => void;
}

export function Composer({ config, activeRunId, draft, onStarted, onOpenRun }: Props) {
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const [maxIterations, setMaxIterations] = useState<number | "">(draft?.maxIterations ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState<number | "">(draft?.timeoutSeconds ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; activeRunId?: string } | null>(null);
  // The catalog comes from the backend (model_catalog.py); the frontend keeps no list of its own.
  const [catalog, setCatalog] = useState<ProvidersResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // "Edit & re-run" carries over the exact provider/model of the old run; a new run leaves it empty → the backend default
  const [provider, setProvider] = useState<string>(draft?.provider ?? "");
  const [model, setModel] = useState<string>(draft?.provider ? (draft.model ?? "") : "");

  useEffect(() => {
    if (!config) return;
    setMaxIterations((v) => (v === "" ? config.defaults.max_iterations : v));
    setTimeoutSeconds((v) => (v === "" ? config.defaults.timeout_seconds : v));
  }, [config]);

  async function loadCatalog() {
    setChecking(true);
    try {
      const data = await api.providers();
      setCatalog(data);
      setCatalogError(null);
      if (!provider) {
        // New run: the backend default (Claude Sonnet 4.6)
        setProvider(data.default.provider);
        setModel(data.default.model);
      }
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  const providerInfo = catalog?.providers.find((p) => p.id === provider) ?? null;
  const modelInfo = providerInfo?.models.find((m) => m.id === model) ?? null;
  // A draft from an old run may point to a model that was removed from the catalog → say so clearly, do not switch silently
  const unknownSelection = !catalog
    ? null
    : provider && !providerInfo
      ? `Provider "${provider}" is not in the model catalog. Choose another provider.`
      : model && !modelInfo
        ? `${provider} / ${model} is not in the model catalog anymore. Choose another model.`
        : null;
  const notReady = modelInfo && !modelInfo.ready ? modelInfo.message || providerInfo?.message || "Not ready." : null;

  function chooseProvider(id: string) {
    setProvider(id);
    const p = catalog?.providers.find((x) => x.id === id);
    const def = p?.models.find((m) => m.provider_default) ?? p?.models[0];
    setModel(def?.id ?? "");
  }

  const [minIter, maxIter] = config?.limits.max_iterations ?? [1, 20];
  const [minTimeout, maxTimeout] = config?.limits.timeout_seconds ?? [1, 300];
  const busy = Boolean(activeRunId);
  const canSubmit =
    prompt.trim().length > 0 && !submitting && !busy && maxIterations !== "" && timeoutSeconds !== "" &&
    Boolean(modelInfo?.ready);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.createRun({
        message: prompt.trim(),
        max_iterations: Number(maxIterations),
        timeout_seconds: Number(timeoutSeconds),
        provider,
        model,
      });
      onStarted(run);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const detail = e.detail as { active_run_id?: string } | undefined;
        setError({ message: e.message, activeRunId: detail?.active_run_id });
      } else {
        setError({ message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="p-4 pb-3 sm:p-5 sm:pb-3">
        <Label htmlFor="prompt" className="mb-2 text-sm font-semibold">
          What should the agent do?
        </Label>
        <Textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Describe a task. The agent writes Python, runs it in the sandbox, reads the output and iterates until done."
          className="min-h-28 resize-y border-input bg-background text-[15px] leading-relaxed"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="size-3.5" /> Try:
          </span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() => setPrompt(ex.prompt)}
              className="rounded-full border bg-background px-3 py-1 text-xs font-medium text-foreground/80 transition hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 border-t px-4 py-3 sm:px-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
          <div className="space-y-1">
            <Label htmlFor="provider" className="text-xs text-muted-foreground">
              Provider
            </Label>
            <select
              id="provider"
              value={providerInfo ? provider : ""}
              disabled={!catalog}
              onChange={(e) => chooseProvider(e.target.value)}
              className={SELECT}
            >
              {!providerInfo && <option value="">{catalog ? "Choose a provider" : "Loading…"}</option>}
              {catalog?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.configured ? "" : " — not configured"}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="model" className="text-xs text-muted-foreground">
              Model
            </Label>
            <select
              id="model"
              value={modelInfo ? model : ""}
              disabled={!providerInfo}
              onChange={(e) => setModel(e.target.value)}
              className={SELECT}
            >
              {!modelInfo && <option value="">Choose a model</option>}
              {providerInfo?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.id}
                  {m.ready ? "" : " — not ready"}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ModelStatus
          loading={!catalog && !catalogError}
          checking={checking}
          error={catalogError ?? unknownSelection}
          providerName={providerInfo?.name}
          model={modelInfo}
          notReady={notReady}
          onRecheck={() => void loadCatalog()}
        />
      </div>

      <div className="flex flex-col gap-3 border-t bg-muted/40 px-4 py-3 sm:flex-row sm:items-end sm:px-5">
        <div className="grid flex-1 grid-cols-2 gap-3 sm:max-w-md">
          <div className="space-y-1">
            <Label htmlFor="max-iter" className="text-xs text-muted-foreground"
              title="Maximum number of code executions. If the last run succeeds, the model gets one more call to review the output and reply DONE (no code runs in that call).">
              Max code runs
            </Label>
            <Input
              id="max-iter"
              type="number"
              min={minIter}
              max={maxIter}
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value === "" ? "" : clamp(+e.target.value, minIter, maxIter))}
              className="h-9 bg-background"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="timeout" className="text-xs text-muted-foreground">
              Execution timeout (s)
            </Label>
            <Input
              id="timeout"
              type="number"
              min={minTimeout}
              max={maxTimeout}
              value={timeoutSeconds}
              onChange={(e) =>
                setTimeoutSeconds(e.target.value === "" ? "" : clamp(+e.target.value, minTimeout, maxTimeout))
              }
              className="h-9 bg-background"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 sm:ml-auto">
          <span className="hidden text-xs text-muted-foreground lg:inline">Ctrl + Enter</span>
          <Button size="lg" onClick={submit} disabled={!canSubmit} className="w-full sm:w-auto">
            {submitting ? <Loader2 className="animate-spin" /> : <Play />}
            Run
          </Button>
        </div>
      </div>

      {(busy || error) && (
        <div className="border-t px-4 py-3 sm:px-5">
          {error ? (
            <Alert variant="destructive" className="border-destructive/30 bg-danger-soft">
              <AlertCircle />
              <AlertDescription className="flex flex-wrap items-center gap-x-3 text-destructive">
                {error.message}
                {error.activeRunId && (
                  <button className="font-medium underline" onClick={() => onOpenRun(error.activeRunId!)}>
                    Open running run
                  </button>
                )}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" />
              One run at a time — another run is in progress.
              <button
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                onClick={() => onOpenRun(activeRunId!)}
              >
                View it <ArrowRight className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

/** The model that will be used for the run (shown BEFORE pressing Run) + the real readiness status from the backend. */
function ModelStatus({
  loading,
  checking,
  error,
  providerName,
  model,
  notReady,
  onRecheck,
}: {
  loading: boolean;
  checking: boolean;
  error: string | null;
  providerName?: string;
  model: { id: string; name: string; note: string } | null;
  notReady: string | null;
  onRecheck: () => void;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading models…
      </p>
    );
  }
  const warn = Boolean(error || notReady || !model);
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md px-2.5 py-2 text-xs",
        warn ? "bg-warning-soft text-warning" : "bg-muted/60 text-muted-foreground",
      )}
    >
      {warn ? <TriangleAlert className="mt-px size-3.5 shrink-0" /> : <BrainCircuit className="mt-px size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">
        {error ? (
          error
        ) : model ? (
          <>
            Runs with <span className="font-semibold text-foreground">{model.name}</span>{" "}
            <span className="font-mono">{model.id}</span> · {providerName}
            {model.note && <span className="text-muted-foreground"> · {model.note}</span>}
            {notReady ? (
              <span className="mt-0.5 block font-medium">{notReady}</span>
            ) : (
              <span className="ml-1.5 inline-flex items-center gap-0.5 whitespace-nowrap text-success">
                <CheckCircle2 className="size-3" /> ready
              </span>
            )}
          </>
        ) : (
          "Choose a model to run."
        )}
      </span>
      <button
        type="button"
        onClick={onRecheck}
        disabled={checking}
        title="Check provider status again (does not download models)"
        className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3", checking && "animate-spin")} /> Re-check
      </button>
    </div>
  );
}

function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
