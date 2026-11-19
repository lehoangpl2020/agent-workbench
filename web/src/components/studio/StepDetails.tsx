import { Download, ExternalLink, FileImage, Info } from "lucide-react";
import type { Iteration, RunDetail } from "@/lib/api";
import { isImage, RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import { explain, filesOf, iterFile, stepTime, type Seen, type StudioStep, type VisibleFile } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { CodeView, TerminalBlock } from "../CodeView";
import { ArtifactList, ProcessOutputPanel } from "../ResultPanels";

interface Props {
  run: RunDetail;
  steps: StudioStep[];
  step?: StudioStep;
  seen: Seen;
  /** Live and caught up with the backend: streaming code / current activity may be shown. */
  liveEdge: boolean;
  now: number;
}

const ACTOR_LABEL = { model: "Model", runtime: "Agent runtime", sandbox: "Python sandbox" };

export function StepDetails({ run, steps, step, seen, liveEdge, now }: Props) {
  if (!step) return <Empty text={run.status === "running" || run.status === "pending"
    ? "Waiting for the first event from the backend." : "No recorded activity for this run."} />;
  return <div className="space-y-3 [overflow-wrap:anywhere]">
    <header className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className={cn("studio-actor-chip", `is-${step.actor}`)}>{ACTOR_LABEL[step.actor]}</span>
        {step.iteration != null && <span>Iteration {step.iteration}{step.iteration > run.max_iterations && " · final review"}</span>}
        <time dateTime={step.ts} className="ml-auto font-mono">{stepTime(step.ts)}</time>
      </p>
      <h3 className={cn("text-[15px] font-semibold leading-snug break-words", step.level === "ERROR" && "text-destructive",
        step.level === "WARN" && step.beat !== "send" && "text-warning")}>{step.title}</h3>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{explain(step, run)}</p>
    </header>
    <Body run={run} steps={steps} step={step} seen={seen} liveEdge={liveEdge} now={now} />
    {step.synthetic && <p className="flex gap-1.5 text-[11px] text-muted-foreground"><Info className="mt-px size-3 shrink-0" />
      Rebuilt from the run record; no detailed log entry exists for this step.</p>}
  </div>;
}

function Body({ run, steps, step, seen, liveEdge, now }: Props & { step: StudioStep }) {
  const n = step.iteration;
  const it = run.iterations.find(i => i.number === n);
  const prev = n != null ? run.iterations.find(i => i.number === n - 1) : undefined;
  const data = step.log?.data ?? {};
  const streaming = liveEdge && step.index === steps.length - 1 && it?.status === "planning" && run.activity_phase === "streaming";

  switch (step.beat) {
    case "start":
      return <>
        <Field label="Task">{<p className="text-sm whitespace-pre-wrap break-words">{run.prompt}</p>}</Field>
        <Meta rows={[["Provider", String(data.provider ?? run.provider_name ?? run.provider ?? "not recorded")],
          ["Model", String(data.model ?? run.model ?? "—")], ["Executor", String(data.executor ?? run.executor ?? "—")],
          ["Max code runs", String(data.max_iterations ?? run.max_iterations)], ["Timeout", `${data.timeout_seconds ?? run.timeout_seconds}s per execution`]]} />
      </>;

    case "iteration":
    case "send":
      return <Request run={run} step={step} it={it} prev={prev} />;

    case "calling":
    case "first_token":
    case "response":
    case "parsed": {
      const call = steps.slice(0, step.index + 1).filter(s => s.iteration === n && s.beat === "calling").at(-1);
      const resp = steps.slice(0, step.index + 1).filter(s => s.iteration === n && s.beat === "response").at(-1);
      const waited = liveEdge && step.index === steps.length - 1 && run.activity_at ? Math.max(0, Math.floor((now - Date.parse(run.activity_at)) / 1000)) : null;
      return <>
        {streaming && it?.code ? <>
          {it.explanation && <Field label="Model’s explanation (streaming)"><p className="text-sm">{it.explanation}</p></Field>}
          <CodeView code={it.code} language={it.language} title={`${iterFile(n)} · streaming…`} follow />
        </> : step.beat === "calling" || step.beat === "first_token" ? <Waiting text={step.beat === "calling"
          ? `Waiting for the response${waited != null ? ` · ${waited}s` : ""}. No partial output yet.`
          : liveEdge && step.index === steps.length - 1 ? "The model is streaming. Code appears here as soon as it starts."
          : "Streamed text is not stored per step. The final code appears once the response is parsed."} /> : null}
        <Meta rows={[
          ["Provider", String(call?.log?.data.provider ?? run.provider_name ?? run.provider ?? "not recorded")],
          ["Model", String(call?.log?.data.model ?? run.model ?? "—")],
          ...(call ? [["Messages sent", String(call.log?.data.messages ?? "—")], ["Max output tokens", String(call.log?.data.max_tokens ?? "—")]] as [string, string][] : []),
          ...(resp ? [["Response", resp.title.replace(/^Response received /, "")],
            ["Stop reason", String(resp.log?.data.stop_reason ?? "—")],
            ...(typeof resp.log?.data.input_tokens === "number" ? [["Input tokens", String(resp.log.data.input_tokens)]] as [string, string][] : []),
            ...(typeof resp.log?.data.output_tokens === "number" ? [["Output tokens", String(resp.log.data.output_tokens)]] as [string, string][] : []),
          ] as [string, string][] : []),
        ]} />
      </>;
    }

    case "accepted":
    case "handoff":
    case "executing":
    case "install":
      if (!it?.code) return <Empty text="No code is recorded for this iteration." />;
      return <>
        {step.beat === "executing" || step.beat === "install" ? <Waiting text={liveEdge && step.index === steps.length - 1 && run.status === "running"
          ? `${run.activity || "Running"}${run.activity_at ? ` · ${Math.max(0, Math.floor((now - Date.parse(run.activity_at)) / 1000))}s` : ""}. stdout and stderr arrive when the process exits.`
          : `Started at ${stepTime(step.ts)} with a ${run.timeout_seconds}s timeout. Output arrives when the process exits.`} /> : null}
        {it.intent === "fix" && it.intent_detail && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-xs break-words text-destructive">
          Fixing: {it.intent_detail}</p>}
        {it.explanation && step.beat === "accepted" && <Field label="Model’s explanation"><p className="text-sm">{it.explanation}</p></Field>}
        {step.beat === "handoff" && <Meta rows={[["File", `code/${iterFile(n)}`], ["Lines", String(data.lines ?? "—")], ["Characters", String(data.chars ?? "—")]]} />}
        <CodeView code={it.code} language={it.language} title={iterFile(n)} />
      </>;

    case "exited":
    case "killed":
    case "result":
    case "checking":
      if (!it || (!seen.exited.has(it.number) && step.beat !== "killed")) return <Empty text="No process result recorded at this step." />;
      if (step.beat === "killed") return <Empty text="The process was stopped before it produced a result." />;
      return <>
        {step.beat === "checking" && <p className="text-xs text-muted-foreground">
          Rule: exit code 0 → the output goes back to the model to decide DONE or another step. Any other exit code → the error goes back to the model to fix, while iterations remain.</p>}
        {it.false_success && <p className="text-xs text-warning">Exit code 0, but the output looked like an error, so the runtime treated it as failed.</p>}
        <ProcessOutputPanel run={run} iteration={it} />
      </>;

    case "artifact": {
      const shown = Object.keys(filesOf(step.log)).map(p => seen.files.find(f => f.path === p)).filter((f): f is VisibleFile => !!f);
      return <FileGallery files={shown} />;
    }

    case "no_files":
      return <Empty text="Nothing new in /workspace/output after this execution." />;

    case "done_reply":
      return <>
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">The model reviewed the output of iteration {(n ?? 1) - 1} and confirmed the request is satisfied.</p>
        {it?.explanation && <Field label="Model reply"><p className="font-mono text-sm">{it.explanation}</p></Field>}
      </>;

    case "stop":
      return <Empty text="The runtime cancels the agent task. If code is running, the sandbox process is killed." />;

    case "snapshot":
      return it ? <>
        {it.code && <CodeView code={it.code} language={it.language} title={iterFile(it.number)} />}
        {it.exit_code != null && <ProcessOutputPanel run={run} iteration={it} />}
        {it.artifacts.length > 0 && <FileGallery files={seen.files.filter(f => f.iteration === it.number)} />}
      </> : <Empty text="No iteration data recorded." />;

    case "finished": {
      const meta = RUN_STATUS[run.status];
      return <>
        <div className={cn("max-h-48 overflow-auto rounded-lg border px-3 py-2.5 text-sm", TONE_CLASSES[meta.tone])}>
          <strong className="font-semibold">{meta.label}.</strong> {run.message || "No reason was recorded."}
        </div>
        {run.answer && run.answer.trim() !== run.message.trim() && <TerminalBlock label={run.status === "success" ? "Final result" : "Latest successful output"} text={run.answer.trimEnd()} empty="(no text output)" />}
        {seen.files.length > 0 && <FileGallery files={seen.files} />}
      </>;
    }

    default:
      return Object.keys(data).length ? <Meta rows={Object.entries(data).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])} /> : null;
  }
}

/** What the runtime sends to the model. Only data the run actually stores is shown. */
function Request({ run, step, it, prev }: { run: RunDetail; step: StudioStep; it?: Iteration; prev?: Iteration }) {
  const intent = step.intent ?? it?.intent ?? "write";
  const note = <p className="text-[11px] text-muted-foreground">The full message list and system prompt are built in core/planner.py and are not stored with the run.</p>;
  if (intent === "fix" && prev) return <>
    <p className="rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-xs break-words text-destructive">{it?.intent_detail || "The previous execution failed."}</p>
    <TerminalBlock label={`stderr from ${iterFile(prev.number)} · exit ${prev.exit_code ?? "—"}`} text={prev.stderr.trimEnd()} tone="error" />
    {note}
  </>;
  if (intent === "review" && prev) return <>
    <TerminalBlock label={`stdout from ${iterFile(prev.number)}`} text={prev.stdout.trimEnd()} empty="(no stdout)" />
    {Array.isArray(step.log?.data.files) && <p className="text-xs text-muted-foreground">Files reported: <span className="font-mono">{(step.log.data.files as string[]).join(", ")}</span></p>}
    {note}
  </>;
  return <>
    <Field label="User task"><p className="text-sm whitespace-pre-wrap break-words">{run.prompt}</p></Field>
    {note}
  </>;
}

function FileGallery({ files }: { files: VisibleFile[] }) {
  if (!files.length) return <Empty text="No files recorded at this step." />;
  const images = files.filter(f => isImage(f.mime) && f.snapshot_available !== false);
  const others = files.filter(f => !images.includes(f));
  return <div className="space-y-3">
    {images.map(f => <figure key={`${f.path}-${f.iteration}`} className="overflow-hidden rounded-lg border bg-card">
      <div className="checker flex justify-center p-2"><img src={f.url} alt={f.path} className="max-h-80 max-w-full rounded object-contain" /></div>
      <figcaption className="flex items-center gap-2 border-t px-3 py-2">
        <FileImage className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}<span className="text-muted-foreground"> · iter {f.iteration}</span></span>
        <a href={f.url} target="_blank" rel="noreferrer" title="Open" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink className="size-3.5" /></a>
        <a href={f.download} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"><Download className="size-3.5" /> Download</a>
      </figcaption>
    </figure>)}
    {others.length > 0 && <ArtifactList files={others.map(f => ({ ...f, download_url: f.download }))} caption="Files saved at this step" />}
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1">
    <p className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
    {children}
  </div>;
}

function Meta({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return null;
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
    {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="truncate font-mono" title={v}>{v}</dd></div>)}
  </dl>;
}

function Waiting({ text }: { text: string }) {
  return <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
    <span className="studio-dot mt-1 bg-primary" aria-hidden />{text}</p>;
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">{text}</p>;
}

