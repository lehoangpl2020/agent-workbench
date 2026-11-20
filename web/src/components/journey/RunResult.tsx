import { useState } from "react";
import {
  CheckCircle2, ChevronDown, CircleDashed, CircleSlash, Download, ExternalLink, EyeOff, File, FileImage, FileText, Search, TriangleAlert, XCircle,
} from "lucide-react";
import type { RunArtifact, RunDetail } from "@/lib/api";
import { formatBytes, formatMs, isImage } from "@/lib/format";
import { outcomeOf, type Fact, type FactTone } from "@/lib/journey";
import { codeRunNumber, isShortOutput, runResult, sourceLabel, type RunResultView } from "@/lib/result";
import { cn } from "@/lib/utils";
import { CopyButton } from "../CodeView";
import { FILE_ACTION } from "../styles";

interface Props {
  run: RunDetail;
  /** Select this code run in the journey. */
  onInspect?: (iteration: number) => void;
  /** Select the run's end in the journey (why it stopped). */
  onWhyStopped?: () => void;
  /** Replay is on: the end-of-run output is folded away so it does not appear before the step that produced it. */
  concealed?: boolean;
}

const ICON: Record<FactTone, typeof CheckCircle2> = { ok: CheckCircle2, bad: XCircle, warn: TriangleAlert, muted: CircleSlash };
const TONE: Record<FactTone, string> = { ok: "text-success", bad: "text-destructive", warn: "text-warning", muted: "text-muted-foreground" };

/**
 * What a finished run produced: the recorded stdout (or error) of one named code run and the run's files, plus the
 * three separate facts (exit code, the model's DONE, task validation). Nothing here summarizes or validates the output.
 */
export function RunResult({ run, onInspect, onWhyStopped, concealed }: Props) {
  const view = runResult(run);
  const [reveal, setReveal] = useState(false);
  if (view.kind === "running") return null;
  const hidden = concealed && !reveal;
  return <section id="run-result" aria-labelledby="run-result-title" className="surface-strong @container scroll-mt-4 overflow-hidden">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3.5 sm:px-6">
      <h2 id="run-result-title" className="eyebrow text-foreground">Result of the whole run</h2>
      {concealed && <span className="tag tag-ink">Replay in progress</span>}
      {onWhyStopped && !hidden && <button type="button" onClick={onWhyStopped} className="text-link ml-auto text-[13px]">Why it stopped</button>}
    </header>
    {hidden ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-4 sm:px-6">
      <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 basis-64 text-sm leading-relaxed text-muted-foreground">Hidden during replay: this is the output at the end of the run,
        so it would show results the replay has not reached yet. The selected step’s evidence is in the journey below.</p>
      <button type="button" onClick={() => setReveal(true)} className="text-link text-[13px]">Show it anyway</button>
    </div> : <>
      <div className={cn("grid gap-6 px-4 pt-3 pb-5 sm:px-6", run.artifacts.length > 0 && "@3xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)] @3xl:gap-8")}>
        <Output run={run} view={view} onInspect={onInspect} />
        {run.artifacts.length > 0 && <Files run={run} files={run.artifacts} />}
      </div>
      <Evidence run={run} />
    </>}
  </section>;
}

function Output({ run, view, onInspect }: { run: RunDetail; view: RunResultView; onInspect?: (n: number) => void }) {
  const it = view.source;
  const failed = view.kind === "failed";
  const text = it ? (failed ? (it.stderr || it.stdout) : it.stdout) : "";
  const stream = failed && it?.stderr ? "stderr" : "stdout";
  const short = isShortOutput(text);
  const [all, setAll] = useState(false);
  return <div className="min-w-0 space-y-3">
    <div className="space-y-1">
      <h3 className={cn("text-lg font-semibold tracking-tight", view.kind === "partial" && "text-warning", failed && "text-destructive")}>{view.title}</h3>
      {it && <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-mono text-[12px] text-muted-foreground">{sourceLabel(view, stream, formatMs)}</span>
        {onInspect && <button type="button" onClick={() => onInspect(it.number)} className="text-link inline-flex items-center gap-1 text-[13px]">
          <Search className="size-3.5" aria-hidden />Inspect code run {view.codeRun}</button>}
      </p>}
    </div>
    {(view.kind !== "final" || !it) && <p className="max-w-[75ch] text-[13px] leading-relaxed text-muted-foreground">{view.note}</p>}
    {run.status !== "success" && run.message && <StopReason message={run.message} />}
    {it && (text.trim() === "" ? <p className="border-l-2 border-border py-1 pl-3 text-sm text-muted-foreground">
        This code run printed nothing{run.artifacts.length ? "; see its files" : ""}.</p>
      : short ? <div className={cn("flex items-start gap-4 border-l-[3px] py-1 pl-4 sm:pl-5",
          failed ? "border-destructive" : view.kind === "partial" ? "border-warning" : "border-brand")}>
          {/* The exact recorded text, full precision; only its size adapts to its length */}
          <output className={cn("min-w-0 flex-1 font-mono font-medium tracking-[-0.01em] whitespace-pre-wrap [overflow-wrap:anywhere]",
            answerSize(text.trim()), failed && "text-destructive")}
            aria-label={`${stream} of code run ${view.codeRun}`}>{text.trim()}</output>
          <CopyButton text={text.trim()} light />
        </div>
      : <div className="overflow-hidden rounded-md border border-code-border bg-code">
          <div className="flex items-center justify-between gap-2 border-b border-code-border px-3 py-1.5">
            <span className={cn("font-mono text-xs", failed ? "text-[#f3a3b5]" : "text-code-muted")}>
              {stream} · {text.split("\n").length.toLocaleString()} lines</span>
            <span className="flex items-center gap-1.5">
              <button type="button" onClick={() => setAll(v => !v)} aria-expanded={all}
                className="rounded-xs px-2 py-1 text-xs font-medium text-code-foreground/90 hover:bg-white/10">{all ? "Collapse" : "Show all"}</button>
              <CopyButton text={text} />
            </span>
          </div>
          <pre tabIndex={0} aria-label={`${stream} of code run ${view.codeRun}`}
            className={cn("overflow-auto px-3.5 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-offset-[-2px]",
            failed ? "text-[#f6c3cf]" : "text-code-foreground", all ? "max-h-[70vh]" : "max-h-72")}>{text}</pre>
        </div>)}
    {it && !failed && it.stderr.trim() && <details className="group text-[13px]">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xs text-muted-foreground hover:text-foreground">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />The same code run also wrote to stderr ({it.stderr.length.toLocaleString()} chars)</summary>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded-md border border-code-border bg-code px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap [overflow-wrap:anywhere] text-[#f6c3cf]">{it.stderr}</pre>
    </details>}
  </div>;
}

/** A short answer is set as a figure: the fewer characters, the larger, so "42" never sits tiny in an empty box. */
function answerSize(text: string) {
  const longest = Math.max(...text.split("\n").map(l => l.length));
  if (longest <= 14) return "text-[40px] leading-[1.1] sm:text-[52px]";
  if (longest <= 32) return "text-[28px] leading-[1.15] sm:text-[36px]";
  if (longest <= 64) return "text-[19px] leading-[1.35] sm:text-[24px]";
  return "text-[15px] leading-relaxed sm:text-[17px]";
}

/** The runtime's recorded reason for ending (it can repeat a long error, so it opens on demand). */
function StopReason({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  const long = message.length > 180 || message.includes("\n");
  return <div className="max-w-[90ch] text-[13px] leading-relaxed">
    <p className={cn("break-words whitespace-pre-wrap", !open && long && "line-clamp-2")}>
      <span className="font-medium">Reason recorded by the runtime: </span><span className="text-muted-foreground">{message}</span></p>
    {long && <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="text-link text-[13px]">
      {open ? "Show less" : "Show the full reason"}</button>}
  </div>;
}

function Files({ run, files }: { run: RunDetail; files: RunArtifact[] }) {
  const images = files.filter(f => isImage(f.mime));
  const others = files.filter(f => !isImage(f.mime));
  const from = (f: RunArtifact) => { const k = codeRunNumber(run, f.iteration); return k ? `code run ${k}` : null; };
  return <div className="min-w-0 space-y-3">
    <h3 className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold tracking-tight">Files
      <span className="font-mono text-[12px] font-normal text-muted-foreground">{files.length} · latest version of each, from the output folder</span></h3>
    {images.length > 0 && <ul className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
      {images.map(f => <li key={f.path} className="overflow-hidden rounded-md border bg-card">
        <a href={f.url} target="_blank" rel="noreferrer" className="checker block focus-visible:outline-offset-[-2px]" aria-label={`Open ${f.path} in a new tab`}>
          <img src={f.url} alt={f.path} loading="lazy" className="mx-auto max-h-80 min-h-40 w-full object-contain p-2" /></a>
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 font-mono text-[12.5px]"><FileImage className="size-3.5 shrink-0 text-sandbox" aria-hidden />
              <span className="min-w-0 break-all">{f.path}</span></p>
            <p className="text-xs text-muted-foreground tabular-nums">{formatBytes(f.size)}{from(f) && ` · ${from(f)}`}</p>
          </div>
          <a href={f.download_url} className={FILE_ACTION} aria-label={`Download ${f.path}`}>
            <Download className="size-3.5" aria-hidden />Download</a>
        </div>
      </li>)}
    </ul>}
    {others.length > 0 && <ul className="divide-y rounded-md border bg-card">
      {others.map(f => {
        const Icon = f.mime.startsWith("text/") ? FileText : File;
        return <li key={f.path} className="flex items-center gap-2 px-3 py-2">
          <Icon className="size-4 shrink-0 text-sandbox" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[12.5px] break-all">{f.path}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{formatBytes(f.size)}{from(f) && ` · ${from(f)}`}</p>
          </div>
          <a href={f.url} target="_blank" rel="noreferrer" className="rounded-xs p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`Open ${f.path} in a new tab`}>
            <ExternalLink className="size-4" /></a>
          <a href={f.download_url} className={FILE_ACTION} aria-label={`Download ${f.path}`}>
            <Download className="size-3.5" aria-hidden />Download</a>
        </li>;
      })}
    </ul>}
  </div>;
}

/** Exit code, the model's DONE and task validation, kept apart. The explanations open on demand. */
function Evidence({ run }: { run: RunDetail }) {
  const o = outcomeOf(run);
  const [open, setOpen] = useState(false);
  const facts = [o.execution, o.signal, o.validation];
  return <div className="border-t bg-background text-[13px]">
    <div className="grid @xl:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
      <dl className="contents">{facts.map(f => <FactCell key={f.label} fact={f} />)}</dl>
      <div className="flex items-center px-4 py-2.5 sm:px-6 @xl:justify-end">
        <button type="button" aria-expanded={open} aria-controls="run-evidence" onClick={() => setOpen(v => !v)}
          className="text-link inline-flex items-center gap-0.5 whitespace-nowrap">
          {open ? "Hide explanation" : "What these mean"}<ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden /></button>
      </div>
    </div>
    {open && <ul id="run-evidence" className="space-y-1.5 border-t px-4 py-3 leading-relaxed text-muted-foreground sm:px-6">
      {facts.map(f => <li key={f.label}><span className="font-semibold text-foreground">{f.label}:</span> {f.detail}</li>)}
    </ul>}
  </div>;
}

/** One of the three facts, as a labelled cell; the cells are separated by hairlines. */
function FactCell({ fact }: { fact: Fact }) {
  const Icon = fact.label === "Task validation" ? CircleDashed : ICON[fact.tone];
  return <div className="min-w-0 border-b px-4 py-2.5 sm:px-6 @xl:border-r @xl:border-b-0">
    <dt className="text-[12px] font-medium text-muted-foreground">{fact.label}</dt>
    <dd className={cn("mt-0.5 flex items-center gap-1.5 font-medium", TONE[fact.tone])}><Icon className="size-3.5 shrink-0" aria-hidden />{fact.value}</dd>
  </div>;
}
