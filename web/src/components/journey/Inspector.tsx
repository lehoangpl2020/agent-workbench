import { ArrowRight, ChevronRight, Download, ExternalLink, FileImage, Info, LogIn, LogOut, Scale } from "lucide-react";
import type { Iteration, RunDetail } from "@/lib/api";
import { formatMs, isImage, RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import {
  ACTOR_NAME, ACTOR_ROLE, CHECK_RULE, FALSE_SUCCESS_NOTE, nextTransition, outcomeOf, type JourneySection,
} from "@/lib/journey";
import { explain, iterFile, stepTime, type Seen, type StudioStep, type VisibleFile } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { CodeView, TerminalBlock } from "../CodeView";
import { ArtifactList, ProcessOutputPanel } from "../ResultPanels";
import { ActorChip } from "./ActorChip";
import { ModelInput } from "./ModelInput";

interface Props {
  run: RunDetail;
  steps: StudioStep[];
  sections: JourneySection[];
  section?: JourneySection;
  step?: StudioStep;
  /** What is known at the selected step. Nothing recorded later is shown. */
  seen: Seen;
  /** Live and caught up with the backend: streaming code / the current activity may be shown. */
  liveEdge: boolean;
  now: number;
  onSelect: (index: number) => void;
}

export function Inspector(props: Props) {
  const { run, step, section } = props;
  if (!step || !section) return <Empty text={run.status === "running" || run.status === "pending"
    ? "Waiting for the first event from the backend." : "No recorded activity for this run."} />;
  const n = section.iteration;
  return <div className="space-y-4 [overflow-wrap:anywhere]">
    <header className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
        <ActorChip actor={step.actor} />
        <span className="font-semibold text-foreground">{section.title}</span>
        <span>— {section.purpose}</span>
        <span className="ml-auto font-mono">step {step.index + 1}/{props.steps.length} · <time dateTime={step.ts}>{stepTime(step.ts)}</time></span>
      </p>
      <h3 className={cn("text-base font-semibold leading-snug", step.level === "ERROR" && "text-destructive",
        step.level === "WARN" && step.beat !== "send" && "text-warning")}>{step.title}</h3>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{explain(step, run)}</p>
      <p className="text-[11.5px] text-muted-foreground"><span className="font-medium text-foreground/80">Who:</span> {ACTOR_NAME[step.actor]} — {ACTOR_ROLE[step.actor].charAt(0).toLowerCase() + ACTOR_ROLE[step.actor].slice(1)}.</p>
      {step.synthetic && <p className="flex gap-1.5 text-[11.5px] text-muted-foreground"><Info className="mt-px size-3 shrink-0" />
        Rebuilt from the run record; no detailed log entry exists for this step (partial history).</p>}
    </header>
    <Body {...props} step={step} section={section} n={n} />
    <Block icon={ArrowRight} label="What happens next">
      <p className="text-[13px] leading-relaxed">{nextTransition(section, props.sections, run, step.index)}</p>
    </Block>
    {step.log && <RecordedEntry step={step} />}
  </div>;
}

function Body({ run, steps, section, step, seen, liveEdge, now, onSelect, n }: Props & { section: JourneySection; step: StudioStep; n: number | null }) {
  const it = run.iterations.find(i => i.number === n);
  const upto = step.index;
  const reached = section.steps.filter(s => s.index <= upto);
  const has = (...beats: string[]) => reached.some(s => beats.includes(s.beat));
  const atLiveEdge = liveEdge && upto === steps.length - 1;

  switch (section.kind) {
    case "setup": {
      const d = section.steps[0]?.log?.data ?? {};
      return <Block icon={LogIn} label="Input">
        <p className="mb-1 text-xs text-muted-foreground">Your task</p>
        <p className="rounded-md bg-muted/60 px-2.5 py-2 text-[13px] break-words whitespace-pre-wrap">{run.prompt}</p>
        <Meta rows={[["Provider", String(d.provider ?? run.provider_name ?? run.provider ?? "not recorded")],
          ["Model", String(d.model ?? run.model ?? "—")], ["Sandbox", String(d.executor ?? run.executor ?? "—")],
          ["Max code runs", String(d.max_iterations ?? run.max_iterations)], ["Timeout", `${d.timeout_seconds ?? run.timeout_seconds}s per code run`]]} />
      </Block>;
    }

    case "model": {
      const streaming = atLiveEdge && it?.status === "planning" && run.activity_phase === "streaming";
      const response = reached.filter(s => s.beat === "response").at(-1);
      const errors = reached.filter(s => s.level === "ERROR");
      const modelNote = reached.find(s => s.log?.source === "model" && s.beat === "note");
      const done = has("done_reply") || (has("snapshot") && it?.status === "done");
      const returned = has("accepted") || !!modelNote || (has("snapshot") && !!it?.code);
      const waited = atLiveEdge && run.activity_at ? Math.max(0, Math.floor((now - Date.parse(run.activity_at)) / 1000)) : null;
      return <>
        <Block icon={LogIn} label="Input · what the model received">
          {section.formatRetries > 0 && <p className="mb-2 text-xs text-warning">The first reply was not valid JSON, so the runtime asked again in the same model call.</p>}
          <ModelInput key={section.key} run={run} section={section} upto={upto} onSelect={onSelect} />
        </Block>
        <Block icon={LogOut} label="Output · what the model returned">
          {done ? <>
            <p className="rounded-md bg-success-soft px-3 py-2 text-[13px] text-success">The model replied DONE: it judged the previous output to satisfy the task. No code is returned.</p>
          </> : returned && it ? <>
            {it.explanation && <Quote text={it.explanation} />}
            {it.code ? <CodeView code={it.code} language={it.language} title={`${iterFile(n)}${section.finalReview ? " · not executed" : ""}`} />
              : <Empty text="No code was returned." />}
          </> : streaming && it?.code ? <>
            {it.explanation && <Quote text={it.explanation} streaming />}
            <CodeView code={it.code} language={it.language} title={`${iterFile(n)} · streaming…`} follow />
            <p className="text-[11.5px] text-muted-foreground">Streamed text is shown live but not stored per step; the runtime only uses it after the full reply is parsed.</p>
          </> : errors.length ? null : <Waiting text={atLiveEdge && run.status === "running"
            ? `Waiting for the model${waited != null ? ` · ${waited}s` : ""}. Code appears as soon as the model starts writing it.`
            : section.steps.some(s => s.index > upto && (s.beat === "accepted" || s.beat === "done_reply"))
              ? "Not returned yet at this step." : "No reply was recorded for this call."} />}
          {errors.map(e => <p key={e.key} className="rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-xs text-destructive">{e.title}</p>)}
          {response && <Meta rows={[
            ["Response time", formatMs(num(response.log?.data.duration_ms))],
            ["First token", formatMs(num(response.log?.data.first_token_ms))],
            ["Stop reason", String(response.log?.data.stop_reason ?? "—")],
            ["Tokens in / out", `${num(response.log?.data.input_tokens) ?? "—"} / ${num(response.log?.data.output_tokens) ?? "—"}`],
          ]} />}
        </Block>
      </>;
    }

    case "code": {
      const exited = has("exited", "snapshot") && it?.exit_code != null;
      const killed = has("killed") && !exited;
      const running = atLiveEdge && run.status === "running" && !exited && !killed;
      const files = n == null ? [] : seen.files.filter(f => f.iteration === n);
      const installs = reached.filter(s => s.beat === "install");
      return <>
        <Block icon={LogIn} label="Input · the code to run">
          <p className="mb-2 text-xs text-muted-foreground">Written by the model in Model call {n}; the runtime saved it as <code className="font-mono">code/{iterFile(n)}</code>.</p>
          {it?.code ? <Collapsible label={`${iterFile(n)} · ${it.code.split("\n").length} lines`}>
            <CodeView code={it.code} language={it.language} title={iterFile(n)} /></Collapsible>
            : <Empty text="No code is recorded for this code run." />}
        </Block>
        <Block icon={LogOut} label="Output · what the sandbox produced">
          {installs.map(s => <p key={s.key} className="text-xs text-warning">{s.title}</p>)}
          {exited && it ? <>
            {it.false_success && <p className="text-xs text-warning">The process exited with code 0; the runtime overruled it in the check that follows.</p>}
            <ProcessOutputPanel run={run} iteration={it} />
          </> : killed ? <Empty text="The process was killed before it produced a result." />
            : <Waiting text={running ? `${run.activity || "Running"}${run.activity_at ? ` · ${Math.max(0, Math.floor((now - Date.parse(run.activity_at)) / 1000))}s` : ""}. stdout and stderr arrive when the process exits (timeout ${run.timeout_seconds}s).`
              : "No result yet at this step."} />}
          {files.length > 0 ? <FileGallery files={files} /> : has("no_files") ? <p className="text-xs text-muted-foreground">No new or changed files in /workspace/output.</p> : null}
        </Block>
      </>;
    }

    case "check": {
      const done = has("result", "snapshot") && it?.exit_code != null;
      const used = run.iterations.filter(i => i.exit_code !== null && i.number <= (n ?? 0)).length;
      return <>
        <Block icon={LogIn} label="Input · from the sandbox">
          {it && it.exit_code != null && (has("checking", "result")) ? <Meta rows={[
            ["Exit code", it.false_success ? "0 (from the process)" : String(it.exit_code)],
            ["Timed out", it.timed_out ? "yes" : "no"],
            ["stdout", `${it.stdout.length.toLocaleString()} chars`],
            ["stderr", `${it.stderr.length.toLocaleString()} chars`],
            ["Files", String(it.artifacts.length)],
          ]} /> : <Waiting text="Waiting for the process result." />}
        </Block>
        <Block icon={Scale} label="Rule · decided by the runtime, not the model">
          <p className="text-[13px] leading-relaxed">{CHECK_RULE}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">Code runs used so far: {used} of {run.max_iterations}.</p>
        </Block>
        <Block icon={LogOut} label="Output · recorded result">
          {done && it ? <>
            <p className={cn("rounded-md px-3 py-2 text-[13px]", it.exit_code === 0 ? "bg-success-soft text-success" : "bg-danger-soft text-destructive")}>
              {it.exit_code === 0 ? "Success: the output will be sent to the model for review." : `Failure${it.timed_out ? " (timed out)" : ""}: the error will be sent to the model.`}
            </p>
            {it.false_success && <p className="text-xs leading-relaxed text-warning">{FALSE_SUCCESS_NOTE}</p>}
            {it.exit_code !== 0 && it.stderr && <TerminalBlock label="stderr · the next model call’s input shows exactly what was sent" text={it.stderr.trimEnd()} tone="error" />}
          </> : <Waiting text="Not recorded yet at this step." />}
        </Block>
      </>;
    }

    case "stop":
      return <Block icon={LogOut} label="Output"><Empty text="You pressed Stop. The runtime cancelled the agent task; if code was running, its process was killed." /></Block>;

    case "end":
      return <EndBody run={run} seen={seen} />;
  }
}

function EndBody({ run, seen }: { run: RunDetail; seen: Seen }) {
  const meta = RUN_STATUS[run.status];
  const o = outcomeOf(run);
  const lastOk = [...run.iterations].reverse().find((i: Iteration) => i.exit_code === 0);
  return <>
    <Block icon={LogOut} label="Outcome">
      <div className={cn("max-h-48 overflow-auto rounded-lg border px-3 py-2.5 text-[13px]", TONE_CLASSES[meta.tone])}>
        <strong className="font-semibold">{meta.label}.</strong> {run.message || "No reason was recorded."}
      </div>
      <ul className="mt-2 space-y-1.5 text-[13px]">
        {[o.execution, o.signal, o.validation].map(f => <li key={f.label}>
          <span className="font-medium">{f.label}:</span> {f.value}. <span className="text-muted-foreground">{f.detail}</span></li>)}
      </ul>
    </Block>
    {run.answer && run.answer.trim() !== run.message.trim() && <Block icon={LogOut}
      label={run.status === "success" ? `Final output${lastOk ? ` · stdout of code run ${lastOk.number}` : ""}` : "Partial result · latest successful output"}>
      <TerminalBlock label="stdout" text={run.answer.trimEnd()} empty="(no text output)" />
    </Block>}
    {seen.files.length > 0 && <Block icon={FileImage} label="Files from this run">
      <FileGallery files={seen.files} />
      <p className="text-[11.5px] text-muted-foreground">Images are shown here for you. A model only sees what is in its recorded input: file names and sizes, never the pixels.</p>
    </Block>}
  </>;
}

function RecordedEntry({ step }: { step: StudioStep }) {
  const log = step.log!;
  const data = Object.entries(log.data).filter(([k]) => k !== "request");
  return <details className="group rounded-lg border bg-muted/30 text-xs">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-medium text-muted-foreground hover:text-foreground">
      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />Recorded log entry
      <span className="ml-auto font-mono font-normal">#{log.id} · {log.source} · {log.level}</span>
    </summary>
    <div className="space-y-1.5 border-t px-3 py-2">
      <p className="font-mono break-words">{log.message}</p>
      {data.length > 0 && <Meta rows={data.map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])} />}
      {"request" in log.data && <p className="text-muted-foreground">request: shown above under Input.</p>}
    </div>
  </details>;
}

export function FileGallery({ files }: { files: VisibleFile[] }) {
  if (!files.length) return <Empty text="No files recorded at this step." />;
  const images = files.filter(f => isImage(f.mime) && f.snapshot_available !== false);
  const others = files.filter(f => !images.includes(f));
  return <div className="space-y-3">
    {images.map(f => <figure key={`${f.path}-${f.iteration}`} className="overflow-hidden rounded-lg border bg-card">
      <div className="checker flex justify-center p-2"><img src={f.url} alt={f.path} className="max-h-80 max-w-full rounded object-contain" /></div>
      <figcaption className="flex items-center gap-2 border-t px-3 py-2">
        <FileImage className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}<span className="text-muted-foreground"> · code run {f.iteration}</span></span>
        <a href={f.url} target="_blank" rel="noreferrer" aria-label={`Open ${f.path}`} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink className="size-3.5" /></a>
        <a href={f.download} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"><Download className="size-3.5" /> Download</a>
      </figcaption>
    </figure>)}
    {others.length > 0 && <ArtifactList files={others.map(f => ({ ...f, download_url: f.download }))} caption="Files saved at this step" />}
  </div>;
}

function Block({ icon: Icon, label, children }: { icon: typeof Info; label: string; children: React.ReactNode }) {
  return <section className="space-y-2">
    <h4 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      <Icon className="size-3.5" />{label}</h4>
    {children}
  </section>;
}

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="group">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border px-3 py-2 font-mono text-xs hover:bg-muted/50">
      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />{label}</summary>
    <div className="mt-2">{children}</div>
  </details>;
}

function Quote({ text, streaming }: { text: string; streaming?: boolean }) {
  return <figure className="space-y-1">
    <figcaption className="text-[11px] text-muted-foreground">Short explanation returned with the reply (its <code className="font-mono">thinking</code> field){streaming ? " · streaming" : ""}. It is not the model’s internal reasoning.</figcaption>
    <blockquote className="border-l-2 border-[var(--model)]/40 pl-2.5 text-[13px] leading-relaxed">{text}</blockquote>
  </figure>;
}

function Meta({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return null;
  return <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
    {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="truncate font-mono" title={v}>{v}</dd></div>)}
  </dl>;
}

function Waiting({ text }: { text: string }) {
  return <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
    <span className="studio-dot mt-1 bg-primary" aria-hidden />{text}</p>;
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-3 py-2.5 text-[13px] text-muted-foreground">{text}</p>;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
