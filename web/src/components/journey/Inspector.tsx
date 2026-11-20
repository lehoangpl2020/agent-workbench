import { ArrowRight, ChevronLeft, ChevronRight, Download, ExternalLink, FileCode2, FileImage, Gauge, Info, LogIn, LogOut, Scale } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { formatMs, isImage, providerLabel } from "@/lib/format";
import {
  CHECK_RULE, checkDecision, FALSE_SUCCESS_NOTE, feedbackTarget, lastErrorLine, modelOutcome, previousCode, sectionLead,
  sectionSummary, stepAccount, type JourneySection,
} from "@/lib/journey";
import { codeRunNumber } from "@/lib/result";
import { explain, iterFile, stepTime, type Seen, type StudioStep, type VisibleFile } from "@/lib/studio";
import { cn } from "@/lib/utils";
import { CodeView } from "../CodeView";
import { ArtifactList, ProcessOutputPanel } from "../ResultPanels";
import { FILE_ACTION, NOTE } from "../styles";
import { ActorChip } from "./ActorChip";
import { CodeCompare } from "./CodeCompare";
import { Disclosure } from "./Disclosure";
import { ModelInput } from "./ModelInput";
import { Reasoning, type ReasoningState } from "./Reasoning";
import { StepAccount } from "./StepAccount";

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
  /** Select another step of the journey (from a "Go to" link). */
  onGotoSection: (key: string) => void;
  /** The flow diagram, shown as a band right under the step's header (wide layouts). */
  stage?: React.ReactNode;
}

const TONE = { ok: "text-success", bad: "text-destructive", warn: "text-warning", muted: "text-muted-foreground" } as const;

/**
 * The selected step as a short technical document: what it is and what came of it (header), the flow, what this run
 * recorded for it (who, input, output, next), then the evidence itself. Supporting material (full input, reasoning,
 * timings, the raw log entry) opens on demand so the returned code or the process output is never far down.
 */
export function Inspector(props: Props) {
  const { run, step, section, upto, eventLevel, revealed, onSelectEvent } = props;
  if (!step || !section) return <div className="space-y-4">
    {props.stage && <div className="inspector-bleed">{props.stage}</div>}
    <Empty text={run.status === "running" || run.status === "pending"
      ? "Waiting for the first event from the backend." : "No recorded activity for this run."} />
  </div>;
  const summary = sectionSummary(section, run, upto, props.sections);
  const outcome = modelOutcome(section, run, upto);
  const events = section.steps.filter(s => s.index <= revealed);
  const k = events.indexOf(step);
  return <div className="ins [overflow-wrap:anywhere]">
    <header className="space-y-2 pb-5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <ActorChip actor={section.actor} />
        {section.finalReview && <span className="tag border-warning/40 text-warning">Final review</span>}
      </div>
      <h3 className="text-[24px] leading-tight font-semibold tracking-[-0.02em]">{section.title}</h3>
      <p className="text-[16px] leading-snug">
        <span className="text-muted-foreground">{section.purpose}</span>
        {summary && <>
          <span className="text-muted-foreground"> · </span>
          <span className={cn("font-semibold", TONE[summary.tone], summary.tone === "muted" && "text-foreground")}>
            {outcome?.kind === "code" ? outcome.text : summary.text}</span>
          {outcome?.kind === "code" && <span className="font-mono text-[14px] text-muted-foreground"> · {iterFile(section.iteration)}</span>}
        </>}
      </p>
      <p className="max-w-[72ch] text-[13.5px] leading-relaxed text-muted-foreground">{sectionLead(section, run)}</p>
      {eventLevel && <div className="mt-3 flex items-start gap-2 rounded-xs border border-l-[3px] border-border border-l-brand bg-brand-soft px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">Event {k + 1} of {events.length} in this step</span>
            <time dateTime={step.ts} className="font-mono text-[12px]">{stepTime(step.ts)}</time>
            <span>· evidence below is as of this event</span>
          </p>
          <p className={cn("text-sm font-semibold", step.level === "ERROR" && "text-destructive", step.level === "WARN" && step.beat !== "send" && "text-warning")}>{step.title}</p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{explain(step, run)}</p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <button type="button" className="rounded-xs p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40"
            disabled={k <= 0} onClick={() => onSelectEvent(events[k - 1].index)} aria-label="Previous event in this step"><ChevronLeft className="size-4" /></button>
          <button type="button" className="rounded-xs p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40"
            disabled={k >= events.length - 1} onClick={() => onSelectEvent(events[k + 1].index)} aria-label="Next event in this step"><ChevronRight className="size-4" /></button>
        </div>
      </div>}
      {step.synthetic && <p className="flex gap-1.5 text-[13px] text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />
        Rebuilt from the run record; no detailed log entry exists for this event (partial history).</p>}
    </header>
    {props.stage && <div className="inspector-bleed border-y">{props.stage}</div>}
    <div className="space-y-6 pt-5">
      <StepAccount rows={stepAccount(section, props.sections, run, upto, revealed)} onGoto={props.onGotoSection} />
      <Body {...props} step={step} section={section} n={section.iteration} />
      {eventLevel && step.log && <RecordedEntry step={step} />}
    </div>
  </div>;
}

function Body({ run, steps, sections, section, upto, revealed, seen, liveEdge, now, onSelectEvent, onGotoSection, n }: Props & { section: JourneySection; step: StudioStep; n: number | null }) {
  const it = run.iterations.find(i => i.number === n);
  const reached = section.steps.filter(s => s.index <= upto);
  const has = (...beats: string[]) => reached.some(s => beats.includes(s.beat));
  const atLiveEdge = liveEdge && upto === steps.length - 1;
  const live = atLiveEdge && run.status === "running";

  switch (section.kind) {
    case "setup": {
      const d = section.steps[0]?.log?.data ?? {};
      return <Block icon={LogIn} label="Input" aside="your task and the run settings">
        <p className="rounded-xs border-l-2 border-rule bg-muted px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap">{run.prompt}</p>
        <Meta rows={[["Provider", String(d.provider ?? run.provider_name ?? run.provider ?? "not recorded")],
          ["Model", String(d.model ?? run.model ?? "—")], ["Sandbox", String(d.executor ?? run.executor ?? "—")],
          ["Max code runs", String(d.max_iterations ?? run.max_iterations)], ["Timeout", `${d.timeout_seconds ?? run.timeout_seconds} s per code run`]]} />
      </Block>;
    }

    case "model": {
      const streaming = atLiveEdge && it?.status === "planning" && run.activity_phase === "streaming";
      const response = reached.filter(s => s.beat === "response").at(-1);
      const errors = reached.filter(s => s.level === "ERROR");
      const outcome = modelOutcome(section, run, upto);
      const done = outcome?.kind === "done";
      const returned = outcome?.kind === "code" || outcome?.kind === "not_executed";
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
      // A finished call leads with what it returned; a call in progress reads in time order (input, reasoning, reply)
      const answered = done || returned || errors.length > 0 || partialCode;

      const responseBlock = <Block key="response" icon={LogOut} label="Response" aside="what the model returned">
        {done ? <p className="rounded-xs border-l-[3px] border-success bg-success-soft px-3 py-2.5 text-sm text-success">
            Replied <strong>DONE</strong>. No code was returned, so nothing more runs.</p>
        : returned && it ? <>
          {outcome?.kind === "not_executed" && <p className="rounded-xs border-l-[3px] border-warning bg-warning-soft px-3 py-2 text-[13.5px] leading-relaxed text-warning">
            The runtime did not run this code: no code runs were left (limit: {run.max_iterations}).</p>}
          {it.explanation && <Quote text={it.explanation} />}
          {it.code ? <CodeCompare current={it} previous={previousCode(run, n)}
              title={`${iterFile(n)}${section.finalReview ? " · not executed" : ""}`} />
            : <Empty text="No code was returned." />}
        </> : streaming && it?.code ? <>
          {it.explanation && <Quote text={it.explanation} streaming />}
          <CodeView code={it.code} language={it.language} title={`${iterFile(n)} · streaming…`} follow />
          <p className="text-[13px] text-muted-foreground">Shown live as it streams. The runtime only uses it after the full reply is parsed.</p>
        </> : partialCode && it ? <>
          <p className="rounded-xs border-l-[3px] border-warning bg-warning-soft px-3 py-2 text-[13.5px] leading-relaxed text-warning">
            Partial code: this is what streamed before the call ended. It was never parsed and never ran.</p>
          {it.explanation && <Quote text={it.explanation} streaming />}
          <CodeView code={it.code} language={it.language} title={`${iterFile(n)} · partial, not run`} />
        </> : errors.length ? null : <Waiting live={live} text={live
          ? run.activity_phase === "reasoning" ? `The model is reasoning first${waited != null ? ` · ${waited}s` : ""}. Code appears when it starts writing its answer.`
          : `Waiting for the model${waited != null ? ` · ${waited}s` : ""}. Code appears as soon as the model starts writing it.`
          : section.steps.some(s => s.index > upto && (s.beat === "accepted" || s.beat === "done_reply"))
            ? "Not returned yet at this event." : "No reply was recorded for this call."} />}
        {errors.map(e => <p key={e.key} className="rounded-xs border-l-[3px] border-destructive bg-danger-soft px-2.5 py-1.5 font-mono text-[12.5px] text-destructive">{e.title}</p>)}
      </Block>;

      const inputBlock = <Block key="input" icon={LogIn} label="Input" aside="what the model received">
        {section.formatRetries > 0 && <p className="text-[13px] text-warning">The first reply was not valid JSON, so the runtime asked again in the same model call.</p>}
        <ModelInput key={section.key} run={run} section={section} upto={upto} onSelect={onSelectEvent} />
      </Block>;

      const supporting = <div key="supporting" className="space-y-0">
        {run.reasoning && <Reasoning key={section.key} state={reasoningState} text={it?.reasoning ?? ""} calling={calling} retried={section.formatRetries > 0}
          kind={run.reasoning_kind ?? "text"} provider={providerLabel(run)} firstReasoningMs={num(response?.log?.data.first_reasoning_ms)}
          firstAnswerMs={num(response?.log?.data.first_token_ms)} />}
        {response && <Disclosure icon={Gauge} label="Call details"
          meta={`${formatMs(num(response.log?.data.duration_ms))} · ${num(response.log?.data.input_tokens) ?? "—"} in / ${num(response.log?.data.output_tokens) ?? "—"} out tokens`}>
          <Meta rows={[
            ["Response time", formatMs(num(response.log?.data.duration_ms))],
            ...(num(response.log?.data.first_reasoning_ms) != null
              ? [["First reasoning token", formatMs(num(response.log?.data.first_reasoning_ms))] as [string, string]] : []),
            [run.reasoning ? "First answer token" : "First token", formatMs(num(response.log?.data.first_token_ms))],
            ["Stop reason", String(response.log?.data.stop_reason ?? "—")],
            ["Tokens in / out", `${num(response.log?.data.input_tokens) ?? "—"} / ${num(response.log?.data.output_tokens) ?? "—"}`],
          ]} />
        </Disclosure>}
      </div>;

      return <>{answered ? [responseBlock, inputBlock, supporting] : [inputBlock, supporting, responseBlock]}</>;
    }

    case "code": {
      const exited = has("exited", "snapshot") && it?.exit_code != null;
      const killed = has("killed") && !exited;
      const running = live && !exited && !killed;
      const files = n == null ? [] : seen.files.filter(f => f.iteration === n);
      const installs = reached.filter(s => s.beat === "install");
      const failed = exited && it && it.exit_code !== 0 && !it.false_success;
      const errorLine = failed && it ? lastErrorLine(it.stderr) : null;
      const target = exited ? feedbackTarget(section, sections, section.last <= upto ? Math.max(upto, revealed) : upto) : null;
      return <>
        <Block icon={LogOut} label="Result" aside="what the sandbox returned">
          {installs.map(s => <p key={s.key} className="text-[13px] text-warning">{s.title}</p>)}
          {exited && it ? <>
            {it.false_success && <p className="text-[13px] text-warning">The process exited with code 0; the runtime overruled it in the check that follows.</p>}
            {(errorLine || it.timed_out) && <div className="rounded-xs border-l-[3px] border-destructive bg-danger-soft px-3 py-2.5">
              <p className="text-[13px] font-medium text-destructive">{it.timed_out ? `Timed out: killed at the ${run.timeout_seconds} s limit` : "Recorded error · the last line of stderr"}</p>
              {errorLine && <p className="mt-0.5 font-mono text-[14px] leading-snug text-destructive">{errorLine}</p>}
            </div>}
            <ProcessOutputPanel run={run} iteration={it} />
          </> : killed ? <Empty text="The process was killed before it produced a result." />
            : <Waiting live={running} text={running ? `${run.activity || "Running"}${run.activity_at ? ` · ${Math.max(0, Math.floor((now - Date.parse(run.activity_at)) / 1000))}s` : ""}. stdout and stderr arrive when the process exits (timeout ${run.timeout_seconds}s).`
              : "No result yet at this event."} />}
          {files.length > 0 ? <FileGallery files={files} /> : has("no_files") ? <p className="text-[13px] text-muted-foreground">No new or changed files in /workspace/output.</p> : null}
          {target && it && <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t pt-3 text-[13.5px] leading-relaxed">
            <p className="min-w-0 flex-1 basis-72">
              {failed || it.false_success || it.timed_out
                ? <>This result went back to the model as the newest message of <strong className="font-semibold">{target.title}</strong>, which then returned its reply.</>
                : <>This output went back to the model as the newest message of <strong className="font-semibold">{target.title}</strong>, which decided what to do next.</>}</p>
            <button type="button" className="text-link inline-flex items-center gap-1" onClick={() => onGotoSection(target.key)}>
              See what {target.title} received and returned<ArrowRight className="size-3.5" aria-hidden /></button>
          </div>}
        </Block>
        <Disclosure icon={FileCode2} label={exited || killed ? "Code that ran" : "Code to run"}
          meta={it?.code ? `${iterFile(n)} · ${it.code.replace(/\n$/, "").split("\n").length} lines · returned by Model call ${n}` : "not recorded"}>
          {it?.code ? <CodeView code={it.code} language={it.language} title={`code/${iterFile(n)}`} />
            : <Empty text="No code is recorded for this code run." />}
        </Disclosure>
      </>;
    }

    case "check": {
      const done = has("result", "snapshot") && it?.exit_code != null;
      const decision = done ? checkDecision(run, n) : null;
      return <Block icon={Scale} label="Rule applied" aside="by the runtime, not the model">
        {done && it ? <>
          <p className={cn("rounded-xs border-l-[3px] px-3 py-2.5 text-sm leading-relaxed", it.exit_code === 0 ? "border-success bg-success-soft text-success" : "border-destructive bg-danger-soft text-destructive")}>
            {decision}</p>
          {it.false_success && <p className="text-[13px] leading-relaxed text-warning">{FALSE_SUCCESS_NOTE}</p>}
        </> : <Waiting live={live} text={live ? "The runtime is reading the exit code." : "Not recorded yet at this event."} />}
        <details className="group text-[13px]">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xs font-medium hover:text-primary">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />The full rule</summary>
          <p className="mt-1 max-w-[78ch] leading-relaxed text-muted-foreground">{CHECK_RULE}</p>
        </details>
      </Block>;
    }

    case "stop":
      return <Block icon={LogOut} label="Result"><Empty text="The runtime cancelled the agent task; if code was running, its process was killed." /></Block>;

    case "end":
      return <EndBody run={run} steps={steps} />;
  }
}

function EndBody({ run, steps }: { run: RunDetail; steps: StudioStep[] }) {
  const finished = [...steps].reverse().find(s => s.beat === "finished");
  const kept = [...run.iterations].reverse().find(i => i.exit_code === 0);
  return <Block icon={LogOut} label="Why the run stopped">
    {finished && <p className="max-w-[78ch] text-sm leading-relaxed">{explain(finished, run)}</p>}
    <p className="max-w-[78ch] text-sm leading-relaxed">
      {kept ? <>The kept output is the stdout of code run {codeRunNumber(run, kept.number)}{run.status === "success" ? "" : " (a partial result)"}.</>
        : <>No code run succeeded, so no output was kept.</>}{" "}
      <button type="button" className="text-link"
        onClick={() => document.getElementById("run-result")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}>
        Show it in the run result</button>
    </p>
  </Block>;
}

function RecordedEntry({ step }: { step: StudioStep }) {
  const log = step.log!;
  const data = Object.entries(log.data).filter(([k]) => k !== "request");
  return <Disclosure label="Recorded log entry" meta={<span className="font-mono text-[12px]">#{log.id} · {log.source} · {log.level}</span>}>
    <div className="space-y-2 rounded-xs border bg-background px-3 py-2.5 text-[13px]">
      <p className="font-mono text-[12.5px] break-words">{log.message}</p>
      {data.length > 0 && <Meta rows={data.map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])} />}
      {"request" in log.data && <p className="text-muted-foreground">request: shown under Input.</p>}
    </div>
  </Disclosure>;
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
    <p className="text-[13px] text-muted-foreground">A model only sees what its recorded input contains: file names and sizes, never the pixels.</p>
  </div>;
}

function Block({ icon: Icon, label, aside, children }: { icon: typeof Info; label: string; aside?: string; children: React.ReactNode }) {
  return <section className="space-y-3">
    <h4 className="ins-h"><Icon className="size-4 text-muted-foreground" aria-hidden />{label}
      {aside && <span className="font-normal text-muted-foreground">· {aside}</span>}</h4>
    {children}
  </section>;
}

function Quote({ text, streaming }: { text: string; streaming?: boolean }) {
  return <figure className="space-y-1">
    <blockquote className="border-l-2 border-model pl-3 text-[15px] leading-relaxed">{text}</blockquote>
    <figcaption className="pl-3.5 text-[12.5px] text-muted-foreground">The model’s short explanation (the <code className="font-mono">thinking</code> field of its answer){streaming ? " · streaming" : ""}, not its reasoning</figcaption>
  </figure>;
}

function Meta({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return null;
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 border-t pt-2 text-[13px]">
    {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono text-[12.5px] break-words">{v}</dd></div>)}
  </dl>;
}

/** A "not yet" state. Only a live run, at its live edge, gets the moving mark: history never looks like it is running. */
function Waiting({ text, live }: { text: string; live: boolean }) {
  return <p className={cn("flex items-start gap-2 rounded-xs border-l-2 bg-muted px-3 py-2 text-[13.5px] leading-relaxed text-muted-foreground", live ? "border-brand" : "border-border")}>
    {live && <span className="studio-dot mt-1.5 animate-pulse bg-brand" aria-hidden />}{text}</p>;
}

function Empty({ text }: { text: string }) {
  return <p className={NOTE}>{text}</p>;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
