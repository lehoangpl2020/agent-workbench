// The agent journey: the recorded steps of one run (studio.ts) grouped into the turns a learner reasons about:
// "Model call N", "Code run N", "Runtime check" and the run's end. Pure functions over stored data; nothing here
// invents events, reasoning or validation. Live, inspect and replay all read the same sections.
import type { Iteration, RunDetail } from "./api";
import { RUN_STATUS, formatMs } from "./format";
import { iterFile, type Actor, type Beat, type StudioStep } from "./studio";

export type SectionKind = "setup" | "model" | "code" | "check" | "stop" | "end";

export interface JourneySection {
  key: string;
  kind: SectionKind;
  actor: Actor;
  iteration: number | null;
  /** Model call number (= iteration) or code run number; null for setup, stop and end. */
  number: number | null;
  /** "Model call 2" */
  title: string;
  /** "Fix the error" */
  purpose: string;
  steps: StudioStep[];
  /** Rows shown in the journey. */
  main: StudioStep[];
  /** Bookkeeping events (first token, parsing...), kept behind a disclosure. */
  technical: StudioStep[];
  /** Step selected when the section itself is chosen: the one that carries its result. */
  focus: number;
  first: number;
  last: number;
  finalReview: boolean;
  /** Model calls resent after an unusable (non-JSON) reply, inside this model call. */
  formatRetries: number;
}

const MODEL_BEATS = new Set<Beat>(["iteration", "send", "calling", "first_token", "response", "parsed", "accepted", "done_reply"]);
const CODE_BEATS = new Set<Beat>(["handoff", "executing", "install", "exited", "killed", "artifact", "no_files"]);
const CHECK_BEATS = new Set<Beat>(["checking", "result"]);
const TECHNICAL_BEATS = new Set<Beat>(["iteration", "calling", "first_token", "response", "parsed", "executing", "no_files"]);
const FOCUS_BEATS: Partial<Record<SectionKind, Beat[]>> = {
  model: ["accepted", "done_reply"],
  code: ["exited", "killed"],
  check: ["result"],
};

export const ACTOR_NAME: Record<Actor, string> = { model: "Model", runtime: "Runtime", sandbox: "Sandbox" };
export const ACTOR_ROLE: Record<Actor, string> = {
  model: "Decides what code to write, how to fix it, and when to reply DONE",
  runtime: "Application code that runs the loop, applies the stop rules and passes data between the others",
  sandbox: "Executes the code with a timeout and returns stdout, stderr, the exit code and files",
};

/** A step that is a meaningful moment for a learner (shown as a row, visited by prev/next and replay). */
export function isTechnical(step: StudioStep): boolean {
  if (step.synthetic) return false;
  if (TECHNICAL_BEATS.has(step.beat)) return true;
  return step.beat === "note" && step.level === "INFO" && step.log?.source !== "model";
}

export function isFinalReview(run: RunDetail, n: number | null, steps: StudioStep[] = []): boolean {
  if (n == null) return false;
  return n > run.max_iterations || steps.some(s => s.iteration === n && s.log?.data.final_review === true);
}

const PURPOSE = { write: "Generate code", fix: "Fix the error", review: "Review the result" } as const;

function kindOf(step: StudioStep, run: RunDetail): SectionKind | null {
  if (step.beat === "start") return "setup";
  if (step.beat === "finished") return "end";
  if (step.beat === "stop") return "stop";
  if (MODEL_BEATS.has(step.beat)) return "model";
  if (CODE_BEATS.has(step.beat)) return "code";
  if (CHECK_BEATS.has(step.beat)) return "check";
  if (step.beat === "snapshot") return run.iterations.find(i => i.number === step.iteration)?.exit_code != null ? "code" : "model";
  return null; // a plain note: it belongs to whatever is happening at that moment
}

export function buildJourney(run: RunDetail, steps: StudioStep[]): JourneySection[] {
  const sections: JourneySection[] = [];
  const byKey = new Map<string, JourneySection>();
  let codeRuns = 0;

  const open = (kind: SectionKind, n: number | null, step: StudioStep): JourneySection => {
    const key = kind === "setup" || kind === "end" ? kind : kind === "stop" ? `stop-${step.index}` : `${kind}-${n}`;
    const existing = byKey.get(key);
    if (existing) return existing;
    const it = run.iterations.find(i => i.number === n);
    let section: JourneySection;
    const base = { key, kind, iteration: n, steps: [], main: [], technical: [], focus: step.index, first: step.index,
      last: step.index, finalReview: false, formatRetries: 0 };
    if (kind === "model") {
      const finalReview = isFinalReview(run, n, steps);
      const intent = step.intent ?? it?.intent ?? "write";
      section = { ...base, actor: "model", number: n, title: `Model call ${n}`, finalReview,
        purpose: finalReview ? "Final review (no code runs left)" : PURPOSE[intent] };
    } else if (kind === "code") {
      codeRuns += 1;
      section = { ...base, actor: "sandbox", number: codeRuns, title: `Code run ${codeRuns}`, purpose: "Execute Python" };
    } else if (kind === "check") {
      section = { ...base, actor: "runtime", number: n, title: "Runtime check", purpose: "Decide the next step" };
    } else if (kind === "stop") {
      section = { ...base, actor: "runtime", number: null, title: "Stop requested", purpose: "Cancel the loop" };
    } else if (kind === "end") {
      section = { ...base, actor: "runtime", number: null, title: "Run finished", purpose: RUN_STATUS[run.status]?.label ?? run.status };
    } else {
      section = { ...base, actor: "runtime", number: null, title: "Run started", purpose: "Prepare the loop" };
    }
    sections.push(section);
    byKey.set(key, section);
    return section;
  };

  for (const step of steps) {
    const kind = kindOf(step, run);
    let section: JourneySection;
    if (kind) section = open(kind, step.iteration, step);
    else {
      // A note joins the latest section of the same iteration, else the model call it was logged in.
      const latest = sections.at(-1);
      section = latest && (step.iteration == null || latest.iteration === step.iteration) && latest.kind !== "end"
        ? latest : step.iteration != null ? open("model", step.iteration, step) : latest ?? open("setup", null, step);
    }
    section.steps.push(step);
    (isTechnical(step) ? section.technical : section.main).push(step);
    section.last = Math.max(section.last, step.index);
  }

  for (const s of sections) {
    const beats = FOCUS_BEATS[s.kind];
    // The model's own reply first (a final review's rejected step is a plain note from the model), then any warning
    const hit = beats && [...s.steps].reverse().find(st => beats.includes(st.beat))
      || (s.kind === "model" ? s.steps.find(st => st.beat === "note" && st.log?.source === "model") ?? [...s.steps].reverse().find(st => st.level !== "INFO") : undefined);
    s.focus = hit?.index ?? s.last;
    s.formatRetries = Math.max(0, s.steps.filter(st => st.beat === "calling").length - 1);
  }
  return sections;
}

/** Index → section, for every step. */
export function sectionIndex(sections: JourneySection[]): Map<number, JourneySection> {
  const map = new Map<number, JourneySection>();
  for (const s of sections) for (const st of s.steps) map.set(st.index, s);
  return map;
}

/** Indices of the meaningful steps, in order: what prev/next and replay visit. */
export function meaningfulOrder(sections: JourneySection[]): number[] {
  return sections.flatMap(s => s.main.map(st => st.index)).sort((a, b) => a - b);
}

export function neighbor(order: number[], index: number, dir: 1 | -1): number | null {
  if (dir === 1) return order.find(i => i > index) ?? null;
  for (let k = order.length - 1; k >= 0; k--) if (order[k] < index) return order[k];
  return null;
}

/** One-line summary of a section's result, as of the step `upto` (later steps never leak in). */
export function sectionSummary(section: JourneySection, run: RunDetail, upto: number, sections: JourneySection[] = []): { text: string; tone: "ok" | "bad" | "warn" | "muted" } | null {
  const reached = section.steps.filter(s => s.index <= upto);
  const has = (beat: Beat) => reached.some(s => s.beat === beat);
  const it = run.iterations.find(i => i.number === section.iteration);
  switch (section.kind) {
    case "model":
      if (has("done_reply")) return { text: "Replied DONE", tone: "ok" };
      if (has("accepted")) return { text: `Returned ${iterFile(section.iteration)}`, tone: "muted" };
      if (section.finalReview && reached.some(s => s.log?.source === "model" || s.level === "WARN") && it?.code)
        return { text: "Wanted another step · not executed", tone: "warn" };
      if (reached.some(s => s.level === "ERROR")) return { text: "Model call failed", tone: "bad" };
      if (reached.some(s => s.beat === "snapshot") && it?.status === "done") return { text: "Replied DONE", tone: "ok" };
      return null;
    case "code": {
      if (has("killed") && !has("exited")) return { text: "Process killed", tone: "warn" };
      if (!(has("exited") || has("snapshot")) || it?.exit_code == null) return null;
      const time = it.execution_time_ms != null ? ` · ${formatMs(it.execution_time_ms)}` : "";
      if (it.timed_out) return { text: `Timed out${time}`, tone: "warn" };
      // The sandbox's own exit code (the runtime may still overrule a 0 in the check that follows)
      const exit = it.false_success ? 0 : it.exit_code;
      return { text: `exit ${exit}${time}`, tone: exit === 0 ? "ok" : "bad" };
    }
    case "check":
      if (!has("result") || it?.exit_code == null) return null;
    {
      // Where the result went, read from what was recorded next (nothing yet while the run is still deciding)
      const after = sections.slice(sections.indexOf(section) + 1).find(s => s.first <= upto && s.kind !== "stop");
      const to = after?.kind === "model" ? (it.exit_code === 0 ? " → output to model" : " → error to model") : after?.kind === "end" ? " → run stops" : "";
      if (it.false_success) return { text: `Treated as failed${to}`, tone: "warn" };
      return it.exit_code === 0 ? { text: `Success${to}`, tone: "ok" } : { text: `Failure${to}`, tone: "bad" };
    }
    case "end": {
      const meta = RUN_STATUS[run.status];
      return { text: meta?.label ?? run.status, tone: meta?.tone === "success" ? "ok" : meta?.tone === "danger" ? "bad" : meta?.tone === "warning" ? "warn" : "muted" };
    }
    default:
      return null;
  }
}

/** What the recorded data says happens after this section (the transition rule), as of step `upto`. */
export function nextTransition(section: JourneySection, sections: JourneySection[], run: RunDetail, upto: number): string {
  const running = run.status === "running" || run.status === "pending";
  const pos = sections.indexOf(section);
  const after = sections.slice(pos + 1).find(s => s.first <= upto && s.kind !== "stop");
  const reached = section.steps.filter(s => s.index <= upto);
  const it = run.iterations.find(i => i.number === section.iteration);
  const ended = after?.kind === "end";
  const endReason = `The run ended: ${RUN_STATUS[run.status]?.label ?? run.status}.`;
  switch (section.kind) {
    case "setup":
      return after?.kind === "model" ? "The runtime sends your task and the system instructions to the model (Model call 1)."
        : ended ? endReason : "The runtime is about to call the model.";
    case "model":
      if (reached.some(s => s.beat === "done_reply") || (reached.some(s => s.beat === "snapshot") && it?.status === "done"))
        return "The model replied DONE. The runtime accepts DONE only after at least one successful code run, then ends the run.";
      if (after?.kind === "code") return `The runtime writes the code to ${iterFile(section.iteration)} and hands it to the sandbox (${after.title}).`;
      if (section.finalReview && it?.code) return "No code runs are left, so the runtime does not execute this code. The run stops without DONE.";
      if (ended) return endReason;
      return running ? "Waiting for the model’s response. Code is only run after the full reply is parsed." : "No further step was recorded.";
    case "code":
      if (reached.some(s => s.beat === "killed") && !reached.some(s => s.beat === "exited")) return "The process was killed before it produced a result.";
      if (reached.some(s => s.beat === "snapshot") && it?.exit_code != null)
        return after?.kind === "model" ? `The result went back to the model (${after.title}). Detailed steps were not recorded for this older run.` : endReason;
      if (after?.kind === "check" || reached.some(s => s.beat === "exited"))
        return "The runtime collects stdout, stderr, the exit code and new files, then checks the result.";
      if (ended) return endReason;
      return running ? "The sandbox is still running the code. Output arrives when the process exits." : "No result was recorded.";
    case "check": {
      if (!reached.some(s => s.beat === "result")) return "The runtime is reading the exit code.";
      const ok = it?.exit_code === 0;
      if (after?.kind === "model") return ok
        ? `Exit code 0: the output is sent back to the model (${after.title}) to decide: DONE or another step.`
        : `The error is sent back to the model (${after.title}) so it can fix the code.`;
      if (ended) {
        if (run.status === "max_retries" || run.status === "timeout")
          return `All ${run.max_iterations} allowed code runs are used and the last one did not succeed, so the runtime stops without calling the model again.`;
        return endReason;
      }
      return running ? "The runtime is starting the next model call." : "No further step was recorded.";
    }
    case "stop":
      return "The runtime cancels the agent task: no further model call is made, and code that was running is killed.";
    case "end":
      return "Nothing else happens. History, logs and file snapshots are stored for inspection and replay.";
  }
}

/** The rule that decides the transition after a runtime check (core/rules.py, core/agent.py). */
export const CHECK_RULE =
  "Exit code 0 → the output goes back to the model to review. Any other exit code → the error goes back to the model to fix. " +
  "Either way the loop continues only while code runs remain; after a successful last run the model gets one final review call, and code from that call is never run.";

export const FALSE_SUCCESS_NOTE =
  "Exit code 0, but the first line of stdout looked like an error, so the runtime’s output check treated the run as failed. " +
  "This check is a heuristic on the text of the output; it does not validate the task.";

// ─── What did the model receive? ─────────────────────────────────────

export interface RecordedMessage { role: string; content: string }
export interface RecordedRequest {
  step: StudioStep;
  attempt: number;
  system: string;
  messages: RecordedMessage[];
}

/** The input of each call in one model turn, exactly as recorded with its `calling` log entry. Empty = not recorded. */
export function recordedRequests(section: JourneySection): RecordedRequest[] {
  return section.steps.filter(s => s.beat === "calling").flatMap((s, attempt) => {
    const req = s.log?.data.request as { system?: unknown; messages?: unknown } | undefined;
    if (!req || typeof req.system !== "string" || !Array.isArray(req.messages)) return [];
    const messages = req.messages.filter((m): m is RecordedMessage =>
      !!m && typeof m === "object" && typeof (m as RecordedMessage).role === "string" && typeof (m as RecordedMessage).content === "string");
    return [{ step: s, attempt, system: req.system, messages }];
  });
}

/** A short description of a recorded message, read from its own text (never from the run history). */
export function describeMessage(m: RecordedMessage, i: number): string {
  if (m.role === "assistant") return "An earlier reply from the model";
  if (i === 0) return "Your task";
  const t = m.content.trimStart();
  if (t.startsWith("✅")) return "Execution feedback: success";
  if (t.startsWith("❌")) return "Execution feedback: failure";
  if (t.startsWith("⏱")) return "Execution feedback: timeout";
  if (t.startsWith("Your last reply was unusable")) return "Format correction";
  return "Message from the runtime";
}

// ─── Outcome ──────────────────────────────────────────────────────────

export type FactTone = "ok" | "bad" | "warn" | "muted";
export interface Fact { label: string; value: string; detail: string; tone: FactTone }
export interface Outcome {
  execution: Fact;
  signal: Fact;
  validation: Fact;
  /** The kept answer is the latest successful output, not a confirmed result. */
  partial: boolean;
}

function codeRuns(run: RunDetail): Iteration[] {
  return run.iterations.filter(i => i.exit_code !== null);
}

export function outcomeOf(run: RunDetail): Outcome {
  const runs = codeRuns(run);
  const last = runs.at(-1);
  const okRuns = runs.filter(i => i.exit_code === 0).length;
  let execution: Fact;
  if (!last) {
    execution = { label: "Code execution", value: "No code finished running", tone: "muted",
      detail: run.status === "stopped" ? "The run was stopped before any code run finished." : "No code run produced a result." };
  } else {
    const k = runs.length;
    const of = `The runtime counted ${okRuns} of ${k} code run${k === 1 ? "" : "s"} as successful.`;
    if (last.timed_out) execution = { label: "Code execution", value: `Code run ${k} timed out`, tone: "warn",
      detail: `Killed after the ${run.timeout_seconds}s limit (exit 124). ${of}` };
    else if (last.false_success) execution = { label: "Code execution", value: `Code run ${k}: exit 0, treated as failed`, tone: "warn",
      detail: `The runtime’s output check (a heuristic) saw an error message in stdout. ${of}` };
    else if (last.exit_code === 0) execution = { label: "Code execution", value: `Code run ${k}: exit 0`, tone: "ok",
      detail: `The last code run finished without an error${last.execution_time_ms != null ? ` in ${formatMs(last.execution_time_ms)}` : ""}. ${of}` };
    else execution = { label: "Code execution", value: `Code run ${k}: exit ${last.exit_code}`, tone: "bad",
      detail: `The last code run failed. ${of}` };
  }

  const done = run.iterations.find(i => i.status === "done");
  const rejected = run.iterations.find(i => i.number > run.max_iterations && i.code && i.status !== "done");
  const signal: Fact = done
    ? { label: "Model signal", value: `DONE in model call ${done.number}`, tone: "ok",
        detail: "The model reviewed the output and replied DONE. This is the model’s own judgement." }
    : rejected
      ? { label: "Model signal", value: "No DONE", tone: "warn",
          detail: `In the final review (model call ${rejected.number}) the model asked for another step; that code was not run.` }
      : { label: "Model signal", value: "No DONE", tone: "muted",
          detail: run.status === "running" ? "The run is still going." : "The run ended before the model replied DONE." };

  const validation: Fact = { label: "Task validation", value: "Not performed", tone: "muted",
    detail: "Agent Workbench does not check whether the answer is correct. Exit code 0 and DONE are not proof; compare the output with the task yourself." };

  return { execution, signal, validation, partial: run.status !== "success" && okRuns > 0 && Boolean(run.answer) };
}
