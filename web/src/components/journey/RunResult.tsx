import { useState } from "react";
import {
  CheckCircle2, ChevronDown, CircleDashed, CircleSlash, Download, ExternalLink, File, FileImage, FileText, Search, TriangleAlert, XCircle,
} from "lucide-react";
import type { RunArtifact, RunDetail } from "@/lib/api";
import { formatBytes, formatMs, isImage, RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import { outcomeOf, type Fact, type FactTone } from "@/lib/journey";
import { codeRunNumber, isShortOutput, runResult, sourceLabel, type RunResultView } from "@/lib/result";
import { cn } from "@/lib/utils";
import { CopyButton } from "../CodeView";

interface Props {
  run: RunDetail;
  /** Select this code run in the journey. */
  onInspect?: (iteration: number) => void;
  /** Select the run's end in the journey (why it stopped). */
  onWhyStopped?: () => void;
}

const ICON: Record<FactTone, typeof CheckCircle2> = { ok: CheckCircle2, bad: XCircle, warn: TriangleAlert, muted: CircleSlash };
const TONE: Record<FactTone, string> = { ok: "text-success", bad: "text-destructive", warn: "text-warning", muted: "text-muted-foreground" };

/**
 * What a finished run produced: the recorded stdout (or error) of one named code run and the run's files, plus the
 * three separate facts (exit code, the model's DONE, task validation). Nothing here summarizes or validates the output.
 */
export function RunResult({ run, onInspect, onWhyStopped }: Props) {
  const view = runResult(run);
  if (view.kind === "running") return null;
  const meta = RUN_STATUS[run.status];
  return <section id="run-result" aria-labelledby="run-result-title" className="studio-card @container scroll-mt-4 overflow-hidden">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5 sm:px-5">
      <h2 id="run-result-title" className="text-sm font-semibold">Run result</h2>
      <span className={cn("rounded-full border px-2 py-0.5 text-[11.5px] font-medium", TONE_CLASSES[meta.tone])}>{meta.label}</span>
      <span className="min-w-0 flex-1 basis-52 text-[13px] text-muted-foreground line-clamp-2 break-words" title={run.message}>
        {run.message || "No reason was recorded."}</span>
      {onWhyStopped && <button type="button" onClick={onWhyStopped}
        className="shrink-0 rounded text-xs font-medium text-primary underline-offset-2 hover:underline">Why it stopped</button>}
    </header>
    <div className={cn("grid gap-4 px-4 py-3.5 sm:px-5", run.artifacts.length > 0 && "@3xl:grid-cols-[minmax(0,1fr)_minmax(220px,0.75fr)]")}>
      <Output run={run} view={view} onInspect={onInspect} />
      {run.artifacts.length > 0 && <Files run={run} files={run.artifacts} />}
    </div>
    <Evidence run={run} />
  </section>;
}

function Output({ run, view, onInspect }: { run: RunDetail; view: RunResultView; onInspect?: (n: number) => void }) {
  const it = view.source;
  const failed = view.kind === "failed";
  const text = it ? (failed ? (it.stderr || it.stdout) : it.stdout) : "";
  const stream = failed && it?.stderr ? "stderr" : "stdout";
  const short = isShortOutput(text);
  const [all, setAll] = useState(false);
  return <div className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h3 className={cn("text-[13px] font-semibold", view.kind === "partial" && "text-warning", failed && "text-destructive")}>{view.title}</h3>
      {it && <span className="font-mono text-[11.5px] text-muted-foreground">{sourceLabel(view, stream, formatMs)}</span>}
      {it && onInspect && <button type="button" onClick={() => onInspect(it.number)}
        className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary underline-offset-2 hover:underline">
        <Search className="size-3" aria-hidden />Inspect code run {view.codeRun}</button>}
    </div>
    {(view.kind !== "final" || !it) && <p className="text-xs leading-relaxed text-muted-foreground">{view.note}</p>}
    {it && (text.trim() === "" ? <p className="rounded-lg border border-dashed px-3 py-2.5 text-[13px] text-muted-foreground">
        This code run printed nothing{run.artifacts.length ? "; see its files" : ""}.</p>
      : short ? <div className={cn("flex items-start gap-3 rounded-lg border px-3.5 py-2.5",
          failed ? "border-destructive/25 bg-danger-soft" : view.kind === "partial" ? "border-warning/30 bg-warning-soft/60" : "bg-muted/40")}>
          <output className={cn("min-w-0 flex-1 font-mono text-[15px] leading-relaxed break-all whitespace-pre-wrap", failed && "text-destructive")}
            aria-label={`${stream} of code run ${view.codeRun}`}>{text.trim()}</output>
          <CopyButton text={text.trim()} light />
        </div>
      : <div className="overflow-hidden rounded-lg border border-code-border bg-code">
          <div className="flex items-center justify-between gap-2 border-b border-code-border px-3 py-1.5">
            <span className={cn("font-mono text-xs", failed ? "text-red-300" : "text-code-muted")}>
              {stream} · {text.split("\n").length.toLocaleString()} lines</span>
            <span className="flex items-center gap-1.5">
              <button type="button" onClick={() => setAll(v => !v)} aria-expanded={all}
                className="rounded-md px-2 py-1 text-xs font-medium text-code-foreground/90 hover:bg-white/10">{all ? "Collapse" : "Show all"}</button>
              <CopyButton text={text} />
            </span>
          </div>
          <pre className={cn("overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap",
            failed ? "text-red-200" : "text-code-foreground", all ? "max-h-[70vh]" : "max-h-56")}>{text}</pre>
        </div>)}
    {it && !failed && it.stderr.trim() && <details className="group text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronDown className="size-3 transition-transform group-open:rotate-180" />The same code run also wrote to stderr ({it.stderr.length.toLocaleString()} chars)</summary>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-code-border bg-code px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap text-red-200">{it.stderr}</pre>
    </details>}
  </div>;
}

function Files({ run, files }: { run: RunDetail; files: RunArtifact[] }) {
  const images = files.filter(f => isImage(f.mime));
  const others = files.filter(f => !isImage(f.mime));
  const from = (f: RunArtifact) => { const k = codeRunNumber(run, f.iteration); return k ? ` · code run ${k}` : ""; };
  return <div className="min-w-0 space-y-2">
    <h3 className="text-[13px] font-semibold">Files <span className="font-normal text-muted-foreground">· latest version of each, from the output folder</span></h3>
    {images.length > 0 && <ul className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
      {images.map(f => <li key={f.path} className="overflow-hidden rounded-lg border bg-card">
        <a href={f.url} target="_blank" rel="noreferrer" className="checker block" aria-label={`Open ${f.path} in a new tab`}>
          <img src={f.url} alt={f.path} loading="lazy" className="mx-auto h-28 w-full object-contain p-1" /></a>
        <div className="flex items-center gap-1 border-t px-2 py-1">
          <FileImage className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={`${f.path} · ${formatBytes(f.size)}${from(f)}`}>{f.path}</span>
          <a href={f.download_url} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Download ${f.path}`}>
            <Download className="size-3.5" /></a>
        </div>
      </li>)}
    </ul>}
    {others.length > 0 && <ul className="divide-y rounded-lg border bg-card">
      {others.map(f => {
        const Icon = f.mime.startsWith("text/") ? FileText : File;
        return <li key={f.path} className="flex items-center gap-2 px-2.5 py-1.5">
          <Icon className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={f.path}>{f.path}
            <span className="text-muted-foreground"> · {formatBytes(f.size)}{from(f)}</span></span>
          <a href={f.url} target="_blank" rel="noreferrer" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Open ${f.path}`}>
            <ExternalLink className="size-3.5" /></a>
          <a href={f.download_url} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Download ${f.path}`}>
            <Download className="size-3.5" /></a>
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
  return <div className="border-t bg-muted/25 px-4 py-2 text-xs sm:px-5">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <dl className="contents">{facts.map(f => <FactInline key={f.label} fact={f} />)}</dl>
      <button type="button" aria-expanded={open} aria-controls="run-evidence" onClick={() => setOpen(v => !v)}
        className="ml-auto inline-flex items-center gap-0.5 rounded font-medium text-primary hover:underline">
        {open ? "Hide explanation" : "What these mean"}<ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} /></button>
    </div>
    {open && <ul id="run-evidence" className="mt-2 space-y-1 pb-1 leading-relaxed text-muted-foreground">
      {facts.map(f => <li key={f.label}><span className="font-medium text-foreground">{f.label}:</span> {f.detail}</li>)}
    </ul>}
  </div>;
}

function FactInline({ fact }: { fact: Fact }) {
  const Icon = fact.label === "Task validation" ? CircleDashed : ICON[fact.tone];
  return <div className="flex min-w-0 items-center gap-1.5">
    <dt className="text-muted-foreground">{fact.label}:</dt>
    <dd className={cn("flex items-center gap-1 font-medium", TONE[fact.tone])}><Icon className="size-3.5 shrink-0" aria-hidden />{fact.value}</dd>
  </div>;
}
