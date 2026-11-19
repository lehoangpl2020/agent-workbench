import { useLayoutEffect, useRef, useState } from "react";
import { BrainCircuit, Check, FileText, Minus, SquareTerminal, Workflow } from "lucide-react";
import type { Intent, RunDetail } from "@/lib/api";
import { isImage, RUN_STATUS, TONE_CLASSES } from "@/lib/format";
import { iterFile, type Actor, type Seen, type StudioStep, type Transfer } from "@/lib/studio";
import { cn } from "@/lib/utils";

interface Props {
  run: RunDetail;
  steps: StudioStep[];
  step?: StudioStep;
  seen: Seen;
  /** Play this step's motion (a new live event or replay playback), otherwise show it settled. */
  animate: boolean;
  speed: number;
  /** Live and caught up with the backend: the run's current activity snapshot applies. */
  liveEdge: boolean;
  now: number;
}

const LIVE_ACTOR: Record<string, Actor> = {
  write: "model", fix: "model", review: "model", streaming: "model",
  executing: "sandbox", installing: "sandbox", rerunning: "sandbox", install_failed: "sandbox", collecting: "sandbox",
  checking: "runtime",
};

type Geo = Record<Actor, { l: number; r: number; c: number }> & { y: number };

function seconds(ms: number) {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

export function StudioStage({ run, steps, step, seen, animate, speed, liveEdge, now }: Props) {
  const running = run.status === "running" || run.status === "pending";
  const live = liveEdge && running;
  const upto = steps.slice(0, seen.index + 1);
  const n = seen.iteration;
  const iterSteps = upto.filter(s => s.iteration === n && n != null);
  const it = run.iterations.find(i => i.number === n);

  let active: Actor | null = step && step.beat !== "finished" ? step.transfer?.to ?? step.actor : null;
  if (live && LIVE_ACTOR[run.activity_phase]) active = LIVE_ACTOR[run.activity_phase];
  const streaming = live && run.activity_phase === "streaming" && it?.status === "planning";
  const sinceActivity = live && run.activity_at ? now - Date.parse(run.activity_at) : null;

  // ── Station geometry, measured so packets travel between the real icon edges ──
  const rail = useRef<HTMLDivElement>(null);
  const icons = useRef<Record<Actor, HTMLSpanElement | null>>({ model: null, runtime: null, sandbox: null });
  const [geo, setGeo] = useState<Geo | null>(null);
  useLayoutEffect(() => {
    const box = rail.current;
    if (!box) return;
    const measure = () => {
      const base = box.getBoundingClientRect();
      const out = {} as Geo;
      for (const a of ["model", "runtime", "sandbox"] as Actor[]) {
        const r = icons.current[a]?.getBoundingClientRect();
        if (!r) return;
        out[a] = { l: r.left - base.left, r: r.right - base.left, c: r.left - base.left + r.width / 2 };
        out.y = r.top - base.top + r.height / 2;
      }
      setGeo(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // ── Model pane ──
  const lastModel = iterSteps.filter(s => s.actor === "model" || s.beat === "send").at(-1);
  const response = iterSteps.filter(s => s.beat === "response").at(-1);
  const accepted = upto.filter(s => s.beat === "accepted" && s.log?.source === "model").at(-1);
  const modelDone = n != null && seen.done.has(n);
  let modelStatus = "Idle";
  if (streaming) modelStatus = run.activity || "Writing code…";
  else if (lastModel) modelStatus = ({
    send: "Request on its way", calling: "Waiting for the response", first_token: "Generating the answer",
    accepted: `Returned ${iterFile(lastModel.iteration)}`, done_reply: "Replied DONE",
  } as Partial<Record<string, string>>)[lastModel.beat] ?? lastModel.title;
  const modelWaiting = (live && ["write", "fix", "review"].includes(run.activity_phase)) ||
    (!live && active === "model" && (lastModel?.beat === "calling" || lastModel?.beat === "send"));

  // ── Sandbox pane ──
  const handoff = upto.filter(s => s.beat === "handoff" ||
    (s.beat === "snapshot" && run.iterations.find(i => i.number === s.iteration)?.exit_code != null)).at(-1);
  const sn = handoff?.iteration ?? null;
  const sit = run.iterations.find(i => i.number === sn);
  const sandboxSteps = upto.filter(s => s.iteration === sn && s.actor === "sandbox" && handoff && s.index >= handoff.index);
  const exited = sn != null && seen.exited.has(sn) && sit?.exit_code != null;
  const killed = sandboxSteps.some(s => s.beat === "killed");
  const executing = sandboxSteps.find(s => s.beat === "executing");
  const runningNow = !!executing && !exited && !killed && !(seen.finished);
  const tail = (text: string, k: number) => text.trimEnd().split("\n").filter(Boolean).slice(-k);

  return <div className="studio-stage" data-active={active ?? "none"}>
    {/* rail: the three stations and the moving data card */}
    <div className="studio-rail" ref={rail}>
      {geo && <span className="studio-line" style={{ left: geo.model.c, width: geo.sandbox.c - geo.model.c, top: geo.y }} />}
      {geo && step?.transfer && <Motion key={`${step.key}-${animate ? "a" : "s"}`} transfer={step.transfer} geo={geo}
        animate={animate} duration={Math.max(240, 680 / speed)} />}
      <Station actor="model" active={active === "model"} waiting={modelWaiting} iconRef={el => { icons.current.model = el; }}
        title="Model" sub={run.model_name ?? (run.model || "LLM")} />
      <Station actor="runtime" active={active === "runtime"} iconRef={el => { icons.current.runtime = el; }}
        title="Agent runtime" sub={n != null ? `Iteration ${n}${n > run.max_iterations ? " · final review" : ""}` : "Coordinator"} />
      <Station actor="sandbox" active={active === "sandbox"} waiting={runningNow} iconRef={el => { icons.current.sandbox = el; }}
        title="Python sandbox" sub={run.executor || "executor"} />
    </div>

    <div className="studio-panes">
      {/* Model */}
      <section className={cn("studio-pane", active === "model" && "is-active")} aria-label="Model">
        <p className="studio-pane-status">
          <span className={cn("studio-dot", active === "model" ? "bg-[var(--model)]" : "bg-muted-foreground/40")} />
          <span className="min-w-0 truncate">{modelStatus}</span>
          {active === "model" && sinceActivity != null && <span className="ml-auto font-mono tabular-nums text-muted-foreground">{seconds(sinceActivity)}</span>}
        </p>
        {streaming && it?.code ? <pre className="studio-codetail" aria-label="Code being written">
            {tail(it.code, 6).map((line, i) => <span key={i} className="block truncate">{line}</span>)}
          </pre>
          : modelDone ? <p className="studio-quote">DONE — the output satisfies the request.</p>
          : accepted ? <figure className="space-y-1">
              <figcaption className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Model’s explanation · iter {accepted.iteration}</figcaption>
              <blockquote className="studio-quote">{accepted.log?.message}</blockquote>
            </figure>
          : <p className="text-xs text-muted-foreground">{n == null ? "No request yet." : "Nothing returned yet in this iteration."}</p>}
        {response && <p className="mt-auto flex flex-wrap gap-x-3 font-mono text-[10.5px] text-muted-foreground">
          {typeof response.log?.data.input_tokens === "number" && <span>in {response.log.data.input_tokens} tok</span>}
          {typeof response.log?.data.output_tokens === "number" && <span>out {response.log.data.output_tokens} tok</span>}
          {response.log?.data.stop_reason != null && <span>{String(response.log.data.stop_reason)}</span>}
        </p>}
      </section>

      {/* Runtime: small coordinator with this iteration's loop */}
      <section className={cn("studio-pane studio-runtime", active === "runtime" && "is-active")} aria-label="Agent runtime">
        {seen.finished ? <span className={cn("self-start rounded-full border px-2 py-0.5 text-[11px] font-medium", TONE_CLASSES[RUN_STATUS[run.status].tone])}>
            Run {RUN_STATUS[run.status].label.toLowerCase()}</span>
          : n != null ? <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {seen.intent && <span className="studio-intent">{seen.intent}</span>}loop</span>
          : <span className="text-[11px] text-muted-foreground">Waiting to start</span>}
        {n != null && <LoopChecklist iterSteps={iterSteps} intent={seen.intent} done={modelDone} />}
      </section>

      {/* Sandbox */}
      <section className={cn("studio-pane", active === "sandbox" && "is-active")} aria-label="Python sandbox">
        <div className="studio-term">
          {sn == null ? <span className="text-code-muted">$ waiting for code…</span> : <>
            <span className="block truncate"><span className="text-code-muted">$</span> python code/{iterFile(sn)}</span>
            {sandboxSteps.filter(s => s.beat === "install").map(s => <span key={s.key} className="block truncate text-amber-300">… {s.title}</span>)}
            {runningNow && <span className="block text-teal-300">running{active === "sandbox" && sinceActivity != null ? ` · ${seconds(sinceActivity)}` : "…"}</span>}
            {exited && sit && tail(sit.stdout, 3).map((l, i) => <span key={`o${i}`} className="block truncate">{l}</span>)}
            {exited && sit && sit.exit_code !== 0 && tail(sit.stderr, 2).map((l, i) => <span key={`e${i}`} className="block truncate text-red-300">{l}</span>)}
            {killed && !exited && <span className="block text-amber-300">process killed</span>}
            {exited && sit && <span className={cn("block", sit.exit_code === 0 ? "text-emerald-300" : "text-red-300")}>
              exit {sit.exit_code}{sit.execution_time_ms != null && ` · ${(sit.execution_time_ms / 1000).toFixed(2)}s`}</span>}
          </>}
        </div>
        <div className="studio-files" aria-label="Output files">
          {seen.files.length === 0 ? <span className="text-[11px] text-muted-foreground">{seen.finished ? "This run saved no output files" : "No output files yet"}</span>
            : seen.files.map(f => <a key={`${f.path}-${f.iteration}`} href={f.url} target="_blank" rel="noreferrer"
              title={`${f.path} · iteration ${f.iteration}`} className={cn("studio-file", seen.newFiles.has(f.path) && animate && "is-new")}>
              {isImage(f.mime) && f.snapshot_available !== false
                ? <img src={f.url} alt={f.path} className="checker size-full rounded-[5px] object-contain" />
                : <span className="flex size-full flex-col items-center justify-center gap-0.5 rounded-[5px] bg-muted px-1">
                    <FileText className="size-4 text-muted-foreground" />
                    <span className="max-w-full truncate font-mono text-[9px]">{f.path}</span>
                  </span>}
            </a>)}
        </div>
      </section>
    </div>
  </div>;
}

function Station({ actor, active, waiting, title, sub, iconRef }: {
  actor: Actor; active: boolean; waiting?: boolean; title: string; sub: string; iconRef: (el: HTMLSpanElement | null) => void;
}) {
  const Icon = actor === "model" ? BrainCircuit : actor === "sandbox" ? SquareTerminal : Workflow;
  return <div className={cn("studio-station", `is-${actor}`, active && "is-active", actor === "runtime" && "is-small")}>
    <span ref={iconRef} className="studio-station-icon">
      <Icon className={actor === "runtime" ? "size-4" : "size-5"} />
      {active && waiting && <span className="studio-wait" aria-hidden />}
    </span>
    <span className="text-xs font-semibold leading-tight">{title}</span>
    <span className="max-w-full truncate font-mono text-[10.5px] text-muted-foreground">{sub}</span>
  </div>;
}

function Motion({ transfer, geo, animate, duration }: { transfer: Transfer; geo: Geo; animate: boolean; duration: number }) {
  const from = geo[transfer.from];
  const to = geo[transfer.to];
  const right = to.c > from.c;
  const gap = 10;
  // The card slides out from behind the source icon and settles beside the destination icon.
  const x0 = right ? `calc(${from.c}px - 0%)` : `calc(${from.c}px - 100%)`;
  const x1 = right ? `calc(${to.l - gap}px - 100%)` : `calc(${to.r + gap}px - 0%)`;
  const style = { "--x0": x0, "--x1": x1, "--dur": `${duration}ms`, top: geo.y } as React.CSSProperties;
  return <>
    <span className={cn("studio-track", `tone-${transfer.tone}`, animate && "is-animated")} style={{
      left: Math.min(from.c, to.c), width: Math.abs(to.c - from.c), top: geo.y,
      transformOrigin: right ? "left center" : "right center", "--dur": `${duration}ms` } as React.CSSProperties} />
    <span className={cn("studio-packet", `tone-${transfer.tone}`, animate && "is-animated")} style={style}
      role="img" aria-label={`${transfer.label}: ${transfer.from} to ${transfer.to}`}>
      {transfer.label}
    </span>
  </>;
}

function LoopChecklist({ iterSteps, intent, done }: { iterSteps: StudioStep[]; intent: Intent | null; done: boolean }) {
  const has = (...beats: string[]) => iterSteps.some(s => beats.includes(s.beat));
  const last = iterSteps.at(-1)?.beat;
  const isLast = (...beats: string[]) => !!last && beats.includes(last);
  const snapshot = has("snapshot");
  const items: { label: string; state: "done" | "active" | "todo" | "skip" }[] = [
    { label: intent === "fix" ? "Send error" : intent === "review" ? "Send output" : "Send task",
      state: has("send", "iteration", "snapshot") ? "done" : "todo" },
    { label: intent === "fix" ? "Model fixes code" : intent === "review" ? "Model decides" : "Model writes code",
      state: has("accepted", "done_reply") || snapshot ? "done" : isLast("calling", "first_token", "response", "parsed", "send") ? "active" : "todo" },
    { label: "Run in sandbox", state: done ? "skip" : has("exited", "killed") || snapshot ? "done"
      : isLast("accepted", "handoff", "executing", "install") ? "active" : "todo" },
    { label: "Check result", state: done ? "skip" : has("result") || snapshot ? "done"
      : isLast("exited", "artifact", "no_files", "checking") ? "active" : "todo" },
  ];
  return <ol className="space-y-1">
    {items.map(item => <li key={item.label} className={cn("studio-check", `is-${item.state}`)}>
      <span className="studio-check-mark">{item.state === "done" ? <Check className="size-2.5" strokeWidth={3} />
        : item.state === "skip" ? <Minus className="size-2.5" /> : null}</span>
      <span className="min-w-0 truncate">{item.label}</span>
    </li>)}
  </ol>;
}
