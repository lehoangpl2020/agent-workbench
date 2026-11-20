import { ArrowRight, Brain, ChevronLeft, ChevronRight, Download, ExternalLink, FileImage, Info, LogIn, LogOut, Scale } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { formatMs, isImage, providerLabel, RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import {
  CHECK_RULE, checkDecision, FALSE_SUCCESS_NOTE, nextTransition, sectionLead, sectionSummary, type JourneySection,
} from "@/lib/journey";
import { codeRunNumber } from "@/lib/result";
import { explain, iterFile, stepTime, type Seen, type StudioStep, type VisibleFile } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { CodeView, TerminalBlock } from "../CodeView";
import { ArtifactList, ProcessOutputPanel } from "../ResultPanels";
import { FILE_ACTION, NOTE } from "../styles";
import { ActorChip } from "./ActorChip";
import { ModelInput } from "./ModelInput";
import { Reasoning, type ReasoningState } from "./Reasoning";

interface Props {
  run: RunDetail;
  steps: StudioStep[];
  sections: JourneySection[];
  section?: JourneySection;
  /** The selected event (for a whole step: its result-carrying event). */
  step?: StudioStep;
  /** Evidence is shown as of this step index: the whole step so far, or the selected event. Nothing later leaks in. */
  upto: number;
  /** One event is selected rather than the whole step. */
  eventLevel: boolean;
  /** Events after this index are not shown yet (replay / live). */
  revealed: number;
  seen: Seen;
  /** Live and caught up with the backend: streaming code / the current activity may be shown. */
  liveEdge: boolean;
  now: number;
  onSelectEvent: (index: number) => void;
  /** The flow diagram, shown as a band right under the step's header (wide layouts). */
  stage?: React.ReactNode;
}

const TONE = { ok: "text-success", bad: "text-destructive", warn: "text-warning", muted: "text-muted-foreground" } as const;

export function Inspector(props: Props) {
  const { run, step, section, upto, eventLevel, revealed, onSelectEvent } = props;
  if (!step || !section) return <div className="space-y-4">
    {props.stage && <div className="inspector-bleed">{props.stage}</div>}
    <Empty text={run.status === "running" || run.status === "pending"
      ? "Waiting for the first event from the backend." : "No recorded activity for this run."} />
  </div>;
  const summary = sectionSummary(section, run, upto, props.sections);
  const events = section.steps.filter(s => s.index <= revealed);
  const k = events.indexOf(step);
  return <div className="divide-y [overflow-wrap:anywhere] [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
    <header className="space-y-2">
      <p className="eyebrow">{eventLevel ? "Selected event" : "Selected step"} · evidence recorded up to this point</p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <ActorChip actor={section.actor} />
        <h3 className="text-xl leading-snug font-semibold tracking-[-0.015em]">{section.title}
          <span className="font-normal text-muted-foreground"> · {section.purpose}</span></h3>
        {summary && <span className={cn("ml-auto font-mono text-[13px]", TONE[summary.tone])}>{summary.text}</span>}
      </div>
      <p className="max-w-[78ch] text-sm leading-relaxed text-muted-foreground">{sectionLead(section, run)}</p>
      {eventLevel && <div className="flex items-start gap-2 rounded-xs border border-l-[3px] border-border border-l-brand bg-brand-soft px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
            <span className="font-semibold tracking-wide uppercase">Event {k + 1} of {events.length} in this step</span>
            <time dateTime={step.ts} className="font-mono">{stepTime(step.ts)}</time>
          </p>
          <p className={cn("text-sm font-medium", step.level === "ERROR" && "text-destructive", step.level === "WARN" && step.beat !== "send" && "text-warning")}>{step.title}</p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{explain(step, run)}</p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <button type="button" className="rounded-xs p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40"
            disabled={k <= 0} onClick={() => onSelectEvent(events[k - 1].index)} aria-label="Previous event in this step"><ChevronLeft className="size-4" /></button>
          <button type="button" className="rounded-xs p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40"
            disabled={k >= events.length - 1} onClick={() => onSelectEvent(events[k + 1].index)} aria-label="Next event in this step"><ChevronRight className="size-4" /></button>
        </div>
      </div>}
      {step.synthetic && <p className="flex gap-1.5 text-[11.5px] text-muted-foreground"><Info className="mt-px size-3 shrink-0" />
        Rebuilt from the run record; no detailed log entry exists for this event (partial history).</p>}
    </header>
    {props.stage && <div className="inspector-bleed py-0!">{props.stage}</div>}
    <Body {...props} step={step} section={section} n={section.iteration} />
    {section.kind !== "end" && <Block icon={ArrowRight} label="Next · why the loop moves on">
      <p className="text-sm leading-relaxed">{nextTransition(section, props.sections, run, upto)}</p>
    </Block>}
    {eventLevel && step.log && <RecordedEntry step={step} />}
  </div>;
}

function Body({ run, steps, section, upto, seen, liveEdge, now, onSelectEvent, n }: Props & { section: JourneySection; step: StudioStep; n: number | null }) {
  const it = run.iterations.find(i => i.number === n);
  const reached = section.steps.filter(s => s.index <= upto);
  const has = (...beats: string[]) => reached.some(s => beats.includes(s.beat));
  const atLiveEdge = liveEdge && upto === steps.length - 1;

  switch (section.kind) {
    case "setup": {
      const d = section.steps[0]?.log?.data ?? {};
      return <Block icon={LogIn} label="Input">
        <p className="text-xs text-muted-foreground">Your task</p>
        <p className="rounded-xs border-l-2 border-rule bg-muted px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap">{run.prompt}</p>
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
      // The call is still running at the live edge (no response yet)
      const calling = atLiveEdge && run.status === "running" && it?.status === "planning" && !response;
      // The call never got a response (Stop or an error ended it), so whatever streamed before that is partial
      const unanswered = !calling && !section.steps.some(s => s.beat === "response");
      const reasoningStarted = has("reasoning");
      const reasoningState: ReasoningState = calling
        ? run.activity_phase === "reasoning" ? "live" : reasoningStarted || it?.reasoning ? "complete" : "waiting"
        : response ? "complete"
        : !reasoningStarted ? "waiting"
        : unanswered ? "partial" : "later";
      const partialCode = unanswered && has("first_token") && !returned && !streaming && !!it?.code;
      return <>
        <Block icon={LogIn} label="Input · what the model received">
          {section.formatRetries > 0 && <p className="mb-2 text-xs text-warning">The first reply was not valid JSON, so the runtime asked again in the same model call.</p>}
          <ModelInput key={section.key} run={run} section={section} upto={upto} onSelect={onSelectEvent} />
        </Block>
        {run.reasoning && <Block icon={Brain} label={run.reasoning_kind === "summary"
            ? `Reasoning summary · written by ${providerLabel(run)}` : "Reasoning · streamed before the answer"}>
          <Reasoning state={reasoningState} text={it?.reasoning ?? ""} calling={calling} retried={section.formatRetries > 0}
            kind={run.reasoning_kind ?? "text"}
            provider={providerLabel(run)} firstReasoningMs={num(response?.log?.data.first_reasoning_ms)}
            firstAnswerMs={num(response?.log?.data.first_token_ms)} />
        </Block>}
        <Block icon={LogOut} label="Output · what the model returned">
          {done ? <p className="rounded-xs border-l-[3px] border-success bg-success-soft px-3 py-2 text-sm text-success">Replied <strong>DONE</strong>: no code was returned, so nothing more runs.</p>
          : returned && it ? <>
            {it.explanation && <Quote text={it.explanation} />}
            {it.code ? <CodeView code={it.code} language={it.language} title={`${iterFile(n)}${section.finalReview ? " · not executed" : ""}`} />
              : <Empty text="No code was returned." />}
          </> : streaming && it?.code ? <>
            {it.explanation && <Quote text={it.explanation} streaming />}
            <CodeView code={it.code} language={it.language} title={`${iterFile(n)} · streaming…`} follow />
            <p className="text-[11.5px] text-muted-foreground">Streamed text is shown live but not stored per event; the runtime only uses it after the full reply is parsed.</p>
          </> : partialCode && it ? <>
            <p className="rounded-xs border-l-[3px] border-warning bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning">
              Partial code: this is what streamed before the call ended. It was never parsed and never ran.</p>
            {it.explanation && <Quote text={it.explanation} streaming />}
            <CodeView code={it.code} language={it.language} title={`${iterFile(n)} · partial, not run`} />
          </> : errors.length ? null : <Waiting text={atLiveEdge && run.status === "running"
            ? run.activity_phase === "reasoning" ? `The model is reasoning first${waited != null ? ` · ${waited}s` : ""}. Code appears when it starts writing its answer.`
            : `Waiting for the model${waited != null ? ` · ${waited}s` : ""}. Code appears as soon as the model starts writing it.`
            : section.steps.some(s => s.index > upto && (s.beat === "accepted" || s.beat === "done_reply"))
              ? "Not returned yet at this event." : "No reply was recorded for this call."} />}
          {errors.map(e => <p key={e.key} className="rounded-xs border-l-[3px] border-destructive bg-danger-soft px-2.5 py-1.5 font-mono text-xs text-destructive">{e.title}</p>)}
          {response && <Meta rows={[
            ["Response time", formatMs(num(response.log?.data.duration_ms))],
            ...(num(response.log?.data.first_reasoning_ms) != null
              ? [["First reasoning token", formatMs(num(response.log?.data.first_reasoning_ms))] as [string, string]] : []),
            [run.reasoning ? "First answer token" : "First token", formatMs(num(response.log?.data.first_token_ms))],
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
          <p className="text-[13px] text-muted-foreground">Written by the model in Model call {n}; the runtime saved it as <code className="font-mono">code/{iterFile(n)}</code>.</p>
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
              : "No result yet at this event."} />}
          {files.length > 0 ? <FileGallery files={files} /> : has("no_files") ? <p className="text-xs text-muted-foreground">No new or changed files in /workspace/output.</p> : null}
        </Block>
      </>;
    }

    case "check": {
      const done = has("result", "snapshot") && it?.exit_code != null;
      const decision = done ? checkDecision(run, n) : null;
      const used = run.iterations.filter(i => i.exit_code !== null && i.number <= (n ?? 0)).length;
      return <>
        <Block icon={LogIn} label="Input · from the sandbox">
          {it && it.exit_code != null && (has("checking", "result", "snapshot")) ? <Meta rows={[
            ["Exit code", it.false_success ? "0 (from the process)" : String(it.exit_code)],
            ["Timed out", it.timed_out ? "yes" : "no"],
            ["stdout", `${it.stdout.length.toLocaleString()} chars`],
            ["stderr", `${it.stderr.length.toLocaleString()} chars`],
            ["Files", String(it.artifacts.length)],
          ]} /> : <Waiting text="Waiting for the process result." />}
        </Block>
        <Block icon={Scale} label="Rule applied · by the runtime, not the model">
          {done && it ? <>
            <p className={cn("rounded-xs border-l-[3px] px-3 py-2 text-sm leading-relaxed", it.exit_code === 0 ? "border-success bg-success-soft text-success" : "border-destructive bg-danger-soft text-destructive")}>
              {decision}</p>
            {it.false_success && <p className="text-xs leading-relaxed text-warning">{FALSE_SUCCESS_NOTE}</p>}
          </> : <Waiting text="Not recorded yet at this event." />}
          <p className="text-[13px] text-muted-foreground">Code runs used: {used} of {run.max_iterations}.</p>
          <details className="group text-xs">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xs font-medium hover:text-primary">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" />The full rule</summary>
            <p className="mt-1 leading-relaxed text-muted-foreground">{CHECK_RULE}</p>
          </details>
          {done && it && it.exit_code !== 0 && it.stderr && <TerminalBlock label="stderr · the next model call’s input shows exactly what was sent" text={it.stderr.trimEnd()} tone="error" />}
        </Block>
      </>;
    }

    case "stop":
      return <Block icon={LogOut} label="Output"><Empty text="The runtime cancelled the agent task; if code was running, its process was killed." /></Block>;

    case "end":
      return <EndBody run={run} steps={steps} />;
  }
}

function EndBody({ run, steps }: { run: RunDetail; steps: StudioStep[] }) {
  const meta = RUN_STATUS[run.status];
  const finished = [...steps].reverse().find(s => s.beat === "finished");
  const kept = [...run.iterations].reverse().find(i => i.exit_code === 0);
  return <>
    <Block icon={LogOut} label="Why the run stopped">
      <div className={cn("max-h-48 overflow-auto rounded-xs border border-l-[3px] border-l-current px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap", TONE_CLASSES[meta.tone])}>
        <strong className="font-semibold">{meta.label}.</strong> {run.message || "No reason was recorded."}
      </div>
      {finished && <p className="text-sm leading-relaxed">{explain(finished, run)}</p>}
    </Block>
    <Block icon={ArrowRight} label="Result">
      <p className="text-sm leading-relaxed">
        {kept ? <>The kept output is the stdout of code run {codeRunNumber(run, kept.number)}{run.status === "success" ? "" : " (a partial result)"}.</>
          : <>No code run succeeded, so no output was kept.</>}{" "}
        <button type="button" className="text-link"
          onClick={() => document.getElementById("run-result")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}>
          Show it in Run result</button>
      </p>
    </Block>
  </>;
}

function RecordedEntry({ step }: { step: StudioStep }) {
  const log = step.log!;
  const data = Object.entries(log.data).filter(([k]) => k !== "request");
  return <details className="group text-[13px]">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 rounded-xs py-1 font-medium text-muted-foreground hover:text-foreground">
      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />Recorded log entry
      <span className="ml-auto font-mono text-xs font-normal">#{log.id} · {log.source} · {log.level}</span>
    </summary>
    <div className="mt-2 space-y-2 rounded-xs border bg-background px-3 py-2.5">
      <p className="font-mono text-[12.5px] break-words">{log.message}</p>
      {data.length > 0 && <Meta rows={data.map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])} />}
      {"request" in log.data && <p className="text-muted-foreground">request: shown above under Input.</p>}
    </div>
  </details>;
}

export function FileGallery({ files }: { files: VisibleFile[] }) {
  if (!files.length) return <Empty text="No files recorded at this event." />;
  const images = files.filter(f => isImage(f.mime) && f.snapshot_available !== false);
  const others = files.filter(f => !images.includes(f));
  return <div className="space-y-3">
    {images.map(f => <figure key={`${f.path}-${f.iteration}`} className="overflow-hidden rounded-md border bg-card">
      <div className="checker flex justify-center p-2"><img src={f.url} alt={f.path} className="max-h-80 max-w-full object-contain" /></div>
      <figcaption className="flex items-center gap-2 border-t px-3 py-2">
        <FileImage className="size-4 shrink-0 text-sandbox" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}<span className="text-muted-foreground"> · snapshot from this code run</span></span>
        <a href={f.url} target="_blank" rel="noreferrer" aria-label={`Open ${f.path}`} className="rounded-xs p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><ExternalLink className="size-3.5" /></a>
        <a href={f.download} className={FILE_ACTION} aria-label={`Download ${f.path}`}><Download className="size-3.5" aria-hidden /> Download</a>
      </figcaption>
    </figure>)}
    {others.length > 0 && <ArtifactList files={others.map(f => ({ ...f, download_url: f.download }))} caption="Files saved by this code run" />}
    <p className="text-xs text-muted-foreground">A model only sees what its recorded input contains: file names and sizes, never the pixels.</p>
  </div>;
}

function Block({ icon: Icon, label, children }: { icon: typeof Info; label: string; children: React.ReactNode }) {
  return <section className="space-y-2.5">
    <h4 className="eyebrow flex items-center gap-1.5 text-foreground"><Icon className="size-3.5 text-muted-foreground" aria-hidden />{label}</h4>
    {children}
  </section>;
}

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="group">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-input bg-card px-3 py-2 font-mono text-[13px] hover:border-foreground">
      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />{label}</summary>
    <div className="mt-2">{children}</div>
  </details>;
}

function Quote({ text, streaming }: { text: string; streaming?: boolean }) {
  return <figure className="space-y-1">
    <figcaption className="text-xs text-muted-foreground">The model’s short explanation (the <code className="font-mono">thinking</code> field of its JSON answer){streaming ? " · streaming" : ""}, not its reasoning</figcaption>
    <blockquote className="border-l-2 border-model pl-3 text-sm leading-relaxed">{text}</blockquote>
  </figure>;
}

function Meta({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return null;
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 border-t pt-2 text-[13px]">
    {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono text-[12.5px] break-words">{v}</dd></div>)}
  </dl>;
}

function Waiting({ text }: { text: string }) {
  return <p className="flex items-start gap-2 rounded-xs border-l-2 border-brand bg-muted px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
    <span className="studio-dot mt-1.5 animate-pulse bg-brand" aria-hidden />{text}</p>;
}

function Empty({ text }: { text: string }) {
  return <p className={NOTE}>{text}</p>;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
