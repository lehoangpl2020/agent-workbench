import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AlertCircle, ArrowRight, Brain, BrainCircuit, CheckCircle2, ImagePlus, ListChecks, Loader2, Play, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, type AppConfig, type ProvidersResponse, type RunDetail } from "@/lib/api";
import { EXAMPLES, QUICK_EXAMPLES, type PromptExample } from "@/lib/examples";
import { cn } from "@/lib/utils";
import { ExamplesSheet } from "./ExamplesSheet";

export interface ComposerDraft {
  prompt: string;
  maxIterations?: number;
  timeoutSeconds?: number;
  provider?: string | null;
  model?: string;
  imageTool?: boolean;
  reasoning?: boolean;
}

// One image call takes 20-120 s and the code is killed at the execution timeout, so a shorter one cannot work.
const IMAGE_TOOL_MIN_TIMEOUT = 120;

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
  // Off by default: every image is billed by OpenAI, so each run has to ask for it
  const [imageTool, setImageTool] = useState<boolean>(draft?.imageTool ?? false);
  // Off by default: reasoning makes every model call several times slower, so each run has to ask for it
  const [reasoning, setReasoning] = useState<boolean>(draft?.reasoning ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; activeRunId?: string } | null>(null);
  // The catalog comes from the backend (llm/catalog.py); the frontend keeps no list of its own.
  const [catalog, setCatalog] = useState<ProvidersResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // "Edit & re-run" carries over the exact provider/model of the old run; a new run leaves it empty → the backend default
  const [provider, setProvider] = useState<string>(draft?.provider ?? "");
  const [model, setModel] = useState<string>(draft?.provider ? (draft.model ?? "") : "");

  // Examples only ever write to `prompt`. Provider, model and limits are separate state, and Composer is never
  // remounted to load an example, so they are left exactly as the user set them.
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const focusPromptOnClose = useRef(false);
  // The latest example load. `previous` is the prompt it replaced (null if that was empty); it powers Undo.
  // Any manual edit clears this, so Undo can never silently throw those edits away.
  const [loaded, setLoaded] = useState<{ title: string; prompt: string; previous: string | null; observe: string } | null>(null);

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
        // New run: the backend default from llm/catalog.py (currently Ollama / qwen3.5:4b)
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

  // Call after the new value has been committed (see flushSync below), so the caret lands after the loaded text
  function focusPrompt() {
    const el = promptRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function loadExample(example: PromptExample) {
    if (prompt === example.prompt) return; // nothing is replaced, so there is nothing to announce or undo
    const previous = prompt.trim() === "" ? null : prompt;
    flushSync(() => {
      setPrompt(example.prompt);
      setLoaded({ title: example.title, prompt: example.prompt, previous, observe: example.observe });
    });
  }

  function pickQuick(example: PromptExample) {
    loadExample(example);
    focusPrompt();
  }

  function pickFromSheet(example: PromptExample) {
    loadExample(example);
    focusPromptOnClose.current = true;
    setExamplesOpen(false);
  }

  function undoExample() {
    if (!loaded || loaded.previous === null) return;
    const previous = loaded.previous;
    flushSync(() => {
      setPrompt(previous);
      setLoaded(null);
    });
    focusPrompt();
  }

  const [minIter, maxIter] = config?.limits.max_iterations ?? [1, 20];
  const [minTimeout, maxTimeout] = config?.limits.timeout_seconds ?? [1, 300];
  const busy = Boolean(activeRunId);
  const imageCfg = config?.image_tool;
  // "Edit & re-run" can carry a ticked box while the server no longer offers the tool: say so, never tick or drop it silently
  const imageBlocked = imageTool && imageCfg ? !imageCfg.available : false;
  const imageTimeoutTooShort = imageTool && timeoutSeconds !== "" && Number(timeoutSeconds) < IMAGE_TOOL_MIN_TIMEOUT;
  const canReason = Boolean(modelInfo?.reasoning);
  // A ticked box with a model that cannot show reasoning (another model chosen, or an old draft): say so, never drop it
  const reasoningBlocked = reasoning && Boolean(modelInfo) && !canReason;
  const canSubmit =
    prompt.trim().length > 0 && !submitting && !busy && maxIterations !== "" && timeoutSeconds !== "" &&
    Boolean(modelInfo?.ready) && !imageBlocked && !reasoningBlocked;

  function chooseImageTool(on: boolean) {
    setImageTool(on);
    // Ticking the box raises a too-short timeout for the user; it never lowers one and never changes it when unticked
    if (on && timeoutSeconds !== "" && Number(timeoutSeconds) < IMAGE_TOOL_MIN_TIMEOUT) {
      setTimeoutSeconds(clamp(IMAGE_TOOL_MIN_TIMEOUT, minTimeout, maxTimeout));
    }
  }

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
        image_tool: imageTool,
        reasoning,
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
    <div className="surface-strong">
      <Step n={1} title={<Label htmlFor="prompt" className="text-[15px] leading-snug font-semibold">What should the agent do?</Label>}
        hint="Plain language. Ctrl + Enter runs it.">
        <Textarea
          id="prompt"
          ref={promptRef}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (loaded && e.target.value !== loaded.prompt) setLoaded(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Describe a task. The agent writes Python, runs it in the sandbox, reads the output and iterates until done."
          className="min-h-32 resize-y px-3.5 py-3 text-[15px] leading-relaxed md:text-[15px]"
        />
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden /> Try
          </span>
          {QUICK_EXAMPLES.map((ex) => (
            <button
              key={ex.id}
              type="button"
              onClick={() => pickQuick(ex)}
              className={PILL}
            >
              {ex.title}
            </button>
          ))}
          <ExamplesSheet
            trigger={
              <button type="button" className={cn(PILL, "inline-flex items-center gap-1")}>
                <ListChecks className="size-3.5" /> All examples ({EXAMPLES.length})
              </button>
            }
            open={examplesOpen}
            onOpenChange={(open) => {
              if (open) focusPromptOnClose.current = false;
              setExamplesOpen(open);
            }}
            onUse={pickFromSheet}
            onCloseAutoFocus={(event) => {
              // After choosing an example the prompt box gets focus; any other close returns focus to the trigger
              if (!focusPromptOnClose.current) return;
              focusPromptOnClose.current = false;
              event.preventDefault();
              focusPrompt();
            }}
          />
        </div>
        {/* Always rendered so assistive tech announces changes to it */}
        <div role="status" aria-live="polite" className="empty:hidden">
          {loaded && (
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-success" />
              <span>
                Loaded “{loaded.title}”.{loaded.previous !== null && " Replaced the previous prompt."}
              </span>
              {loaded.previous !== null && (
                <button
                  type="button"
                  onClick={undoExample}
                  className="text-link"
                >
                  Undo
                </button>
              )}
            </p>
          )}
        </div>
        {loaded && <p className="mt-2 border-l-2 border-rule bg-muted px-3 py-2 text-xs leading-relaxed">
          <span className="font-semibold">What to watch: </span>{loaded.observe}</p>}
      </Step>

      <Step n={2} title={<h2 className="text-[15px] font-semibold">Model</h2>} hint="Fixed for the whole run.">
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
        <div className="mt-4 flex items-start gap-2.5 border-t pt-4">
          <input
            id="reasoning"
            type="checkbox"
            checked={reasoning}
            // Unsupported and unticked: nothing to turn on. Unsupported but ticked: it must stay untickable.
            disabled={!modelInfo || (!canReason && !reasoning)}
            onChange={(e) => setReasoning(e.target.checked)}
            aria-describedby="reasoning-help"
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="min-w-0 text-xs">
            <Label htmlFor="reasoning" className="inline-flex items-center gap-1.5 text-sm font-medium">
              <Brain className="size-4 text-muted-foreground" aria-hidden /> Reasoning
            </Label>
            <p id="reasoning-help" className="mt-1 leading-relaxed text-muted-foreground">
              {modelInfo && !canReason
                ? `${modelInfo.name} cannot show its reasoning in this app.`
                : modelInfo?.reasoning_kind === "summary"
                  ? `Shows, live under each model call, the summary ${providerInfo?.name ?? "the provider"} writes of the model's reasoning; the reasoning itself is never returned. Billed as output tokens. Off unless you tick it.`
                  : "The model thinks before it answers, and you can read that reasoning live under each model call. Much slower, and the reasoning counts toward a larger output limit. Off unless you tick it."}
            </p>
            {reasoningBlocked && (
              <p className="mt-1 flex items-start gap-1 font-medium text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" /> This model cannot show reasoning. Untick it, or choose another model.
              </p>
            )}
          </div>
        </div>
      </Step>

      <Step n={3} title={<h2 className="text-[15px] font-semibold">Limits and tools</h2>} hint="Applied by the runtime, not the model.">
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <div className="space-y-1.5">
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
              className="h-9 font-mono tabular-nums"
            />
          </div>
          <div className="space-y-1.5">
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
              className="h-9 font-mono tabular-nums"
            />
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2.5 border-t pt-4">
          <input
            id="image-tool"
            type="checkbox"
            checked={imageTool}
            // Unavailable and unticked: nothing to turn on. Unavailable but ticked (old draft): it must stay untickable.
            disabled={!imageCfg || (!imageCfg.available && !imageTool)}
            onChange={(e) => chooseImageTool(e.target.checked)}
            aria-describedby="image-tool-help"
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="min-w-0 text-xs">
            <Label htmlFor="image-tool" className="inline-flex flex-wrap items-center gap-1.5 text-sm font-medium">
              <ImagePlus className="size-4 text-muted-foreground" aria-hidden /> Image tool
              {imageCfg?.model && <span className="tag font-mono">{imageCfg.model}</span>}
            </Label>
            <p id="image-tool-help" className="mt-1 leading-relaxed text-muted-foreground">
              {imageCfg && !imageCfg.available
                ? imageCfg.reason
                : `Lets the agent make photos and illustrations that code cannot draw. Billed per image by OpenAI, at most ${
                    imageCfg?.max_per_run ?? "a few"
                  } per run. Off unless you tick it.`}
            </p>
            {imageBlocked && (
              <p className="mt-1 flex items-start gap-1 font-medium text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" /> The server cannot offer it now. Untick it to run.
              </p>
            )}
            {imageTimeoutTooShort && !imageBlocked && (
              <p className="mt-1 flex items-start gap-1 font-medium text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" /> An image takes 20–120 s. Set the execution timeout
                to at least {IMAGE_TOOL_MIN_TIMEOUT} s or the code is killed first.
              </p>
            )}
          </div>
        </div>
      </Step>

      <div className="flex flex-col gap-3 bg-background px-4 py-4 sm:flex-row sm:items-center sm:px-6">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          Nothing runs until you press Run. The model, the limits and the image tool cannot change during the run.
        </p>
        <div className="flex items-center gap-3">
          <kbd className="hidden rounded-xs border border-input bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground lg:inline">Ctrl + Enter</kbd>
          <Button size="lg" onClick={submit} disabled={!canSubmit} className="w-full px-8 sm:w-auto">
            {submitting ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
            Run
          </Button>
        </div>
      </div>

      {(busy || error) && (
        <div className="border-t px-4 py-3 sm:px-6">
          {error ? (
            <Alert variant="destructive">
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
              <Loader2 className="size-4 animate-spin text-brand" aria-hidden />
              One run at a time — another run is in progress.
              <button
                className="text-link inline-flex items-center gap-1"
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

/** One numbered part of the form: number and title in a label column on wide screens, stacked on phones. */
function Step({ n, title, hint, children }: { n: number; title: React.ReactNode; hint: string; children: React.ReactNode }) {
  return <section className="grid gap-3 border-b px-4 py-5 sm:grid-cols-[176px_minmax(0,1fr)] sm:gap-6 sm:px-6 sm:py-6">
    <div className="flex items-baseline gap-2.5 sm:block">
      <span className="idx text-brand sm:block">{String(n).padStart(2, "0")}</span>
      <div className="sm:mt-1.5">
        {title}
        <p className="mt-1 hidden text-xs leading-relaxed text-muted-foreground sm:block">{hint}</p>
      </div>
    </div>
    <div className="min-w-0">{children}</div>
  </section>;
}

const PILL =
  "h-7 rounded-xs border border-input bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:border-foreground hover:bg-accent";

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-field bg-card px-2.5 text-sm transition-colors focus-visible:border-foreground focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50";

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
        "mt-3 flex items-start gap-2 rounded-xs border-l-2 px-3 py-2 text-xs leading-relaxed",
        warn ? "border-warning bg-warning-soft text-warning" : "border-model bg-muted text-muted-foreground",
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
        className="inline-flex shrink-0 items-center gap-1 rounded-xs font-medium text-foreground underline decoration-brand underline-offset-3 hover:text-primary disabled:opacity-50"
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
