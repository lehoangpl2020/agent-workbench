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

const MODEL_BEATS = new Set<Beat>(["iteration", "send", "calling", "reasoning", "first_token", "response", "parsed", "accepted", "done_reply"]);
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

/** Sections that exist at step `revealed` (replay and live hide the ones not reached yet). */
export function revealedSections(sections: JourneySection[], revealed: number): JourneySection[] {
  return sections.filter(s => s.first <= revealed);
}

/** The journey step before/after `current`: what Prev/Next visit when exploring. */
export function neighborSection(sections: JourneySection[], current: JourneySection | undefined, dir: 1 | -1, revealed: number): JourneySection | null {
  const visible = revealedSections(sections, revealed);
  if (!current) return dir === 1 ? visible[0] ?? null : null;
  return visible[visible.indexOf(current) + dir] ?? null;
}

/** The event selected when a whole step is chosen: its result-carrying event, or the latest one recorded so far. */
export function sectionTarget(section: JourneySection, revealed: number): number {
  if (section.focus <= revealed) return section.focus;
  return section.steps.filter(s => s.index <= revealed).at(-1)?.index ?? section.first;
}

/** The hand-off the flow diagram shows for a whole step: its latest transfer up to `upto`. */
export function sectionTransferStep(section: JourneySection, upto: number): StudioStep | undefined {
  return section.steps.filter(s => s.index <= upto && s.transfer).at(-1);
}

/** What this kind of step is for, in one sentence (the mechanism, never the model's reasoning). */
export function sectionLead(section: JourneySection, run: RunDetail): string {
  switch (section.kind) {
    case "setup": return "The runtime prepares the loop with your task and the run settings.";
    case "model": {
      if (section.finalReview) return "No code runs are left: the model reviews the last output and may reply DONE. Code it returns here is not run.";
      const intent = section.steps.find(s => s.intent)?.intent ?? run.iterations.find(i => i.number === section.iteration)?.intent ?? "write";
      return intent === "fix" ? "The model receives the error and returns new code (whether it fixes the error shows in the next code run)."
        : intent === "review" ? "The model receives the output and decides: reply DONE, or return code for another step."
        : "The model receives your task and returns Python code.";
    }
    case "code": return `The sandbox runs ${iterFile(section.iteration)} and returns stdout, stderr, the exit code and any files.`;
    case "check": return "The runtime reads the exit code and applies the stop rules. The model is not involved.";
    case "stop": return "You pressed Stop. The runtime cancels the loop.";
    case "end": return "The runtime ended the run and stored its history for inspection and replay.";
  }
}

/** The branch of the runtime's rule that applied after a code run (core/rules.py), from the recorded result. */
export function checkDecision(run: RunDetail, iteration: number | null): string | null {
  const it = run.iterations.find(i => i.number === iteration);
  if (!it || it.exit_code == null) return null;
  const used = run.iterations.filter(i => i.exit_code !== null && i.number <= it.number).length;
  const left = used < run.max_iterations;
  if (it.exit_code === 0) return left
    ? "Exit code 0 → the output goes back to the model, which decides: DONE or another step."
    : "Exit code 0 on the last allowed code run → one final review call; code returned in it is not run.";
  const what = it.timed_out ? "Timed out" : it.false_success ? "Output looked like an error" : `Exit code ${it.exit_code}`;
  return left ? `${what} → the error goes back to the model to fix the code.`
    : `${what} on the last allowed code run → the run stops without another model call.`;
}

// ─── The loop of one model call, as of a step ─────────────────────────

export type TurnState = "done" | "failed" | "active" | "underway" | "next" | "upcoming" | "na" | "unknown";
export interface TurnItem { key: "send" | "model" | "run" | "check"; label: string; state: TurnState; note?: string }

/**
 * The four parts of one turn of the loop (send → model → sandbox → check) as of step `upto`. A part that does not
 * apply to this turn (DONE, or a final review) is "na", never pending; a part that was never recorded is "unknown".
 * "active" means happening right now, so it only appears at the live edge of a running run. When exploring or
 * replaying history, a part the record shows had started but not finished at the selected point is "underway", and
 * a part that only follows it is "next".
 */
export function turnChecklist(run: RunDetail, steps: StudioStep[], n: number | null, upto: number): TurnItem[] {
  if (n == null) return [];
  // Stop and the run's end are logged with the current iteration but are not part of the turn itself.
  const turn = steps.filter(s => s.iteration === n && s.beat !== "finished" && s.beat !== "stop");
  const seen = turn.filter(s => s.index <= upto);
  const has = (...beats: Beat[]) => seen.some(s => beats.includes(s.beat));
  const lastBeat = seen.at(-1)?.beat;
  const at = (...beats: Beat[]) => !!lastBeat && beats.includes(lastBeat);
  const it = run.iterations.find(i => i.number === n);
  const running = run.status === "running" || run.status === "pending";
  const snapshot = has("snapshot");
  const intent = seen.find(s => s.intent)?.intent ?? it?.intent ?? "write";
  const finalReview = isFinalReview(run, n, steps);
  const done = has("done_reply") || (snapshot && it?.status === "done");
  // Not reached at this step: it comes later if this turn continues in the record (or live), else it never happened.
  const liveEdge = running && upto >= steps.length - 1;
  const continues = turn.some(s => s.index > upto) || liveEdge;
  // Without a recorded end (older or cut-off history) a missing part is unknown rather than "not reached".
  const ended = running || steps.some(s => s.beat === "finished" || s.beat === "stop");
  const pending = (): Pick<TurnItem, "state" | "note"> => continues ? { state: "upcoming" }
    : { state: "unknown", note: ended ? "not reached" : "not recorded" };
  // In progress at this step; if the turn ends here without a result, it was cut off (Stop) or its outcome is unknown.
  const stopped = steps.some(s => s.beat === "stop");
  // `started`: the record shows this part had begun at the selected point (the call was sent, the process started...)
  const inProgress = (started: boolean): Pick<TurnItem, "state" | "note"> => liveEdge ? { state: "active", note: "now" }
    : continues || running ? started ? { state: "underway", note: "under way at this point" } : { state: "next", note: "next" }
    : { state: "unknown", note: stopped ? "interrupted by Stop" : "no result recorded" };

  const modelReply = seen.some(s => s.beat === "note" && s.log?.source === "model");
  const modelFailed = seen.some(s => s.level === "ERROR" && (s.actor === "model" || s.log?.source === "llm"));
  const exited = seen.find(s => s.beat === "exited");
  const exitCode = typeof exited?.log?.data.exit_code === "number" ? exited.log.data.exit_code as number
    : it?.false_success ? 0 : it?.exit_code ?? null;
  const ran = (!!exited || (snapshot && it?.exit_code != null));
  const skip = done ? "not needed: DONE" : finalReview ? "not run: no code runs left" : null;

  const items: TurnItem[] = [
    { key: "send", label: intent === "fix" ? "Send the error" : intent === "review" ? "Send the output" : "Send the task",
      ...(has("send", "iteration", "snapshot") ? { state: "done" as const } : pending()) },
    { key: "model", label: finalReview ? "Model reviews (final)" : intent === "fix" ? "Model fixes the code" : intent === "review" ? "Model reviews" : "Model writes code",
      ...(done ? { state: "done" as const, note: "DONE" }
        : has("accepted") || (snapshot && it?.code) ? { state: "done" as const, note: iterFile(n) }
        : modelReply ? { state: "done" as const, note: finalReview ? "asked for another step" : undefined }
        : at("send", "iteration", "calling", "reasoning", "first_token", "response", "parsed") && !modelFailed ? inProgress(!at("send", "iteration"))
        : modelFailed ? { state: "failed" as const, note: "call failed" }
        : pending()) },
    { key: "run", label: "Run in sandbox",
      ...(skip ? { state: "na" as const, note: skip }
        : ran ? { state: exitCode === 0 ? "done" as const : "failed" as const, note: it?.timed_out ? "timed out" : exitCode != null ? `exit ${exitCode}` : undefined }
        : has("killed") ? { state: "failed" as const, note: "killed" }
        : at("accepted", "handoff", "executing", "install") ? inProgress(at("executing", "install"))
        : pending()) },
    { key: "check", label: "Check the result",
      ...(skip ? { state: "na" as const, note: skip }
        : has("result") || (snapshot && it?.exit_code != null) ? { state: "done" as const, note: it?.exit_code === 0 ? "success" : "failure" }
        : at("exited", "artifact", "no_files", "checking") ? inProgress(at("checking"))
        : pending()) },
  ];
  return items;
}

export type ModelOutcomeKind = "code" | "done" | "not_executed" | "failed" | "partial" | "none";
export interface ModelOutcome { kind: ModelOutcomeKind; text: string; tone: FactTone }

/**
 * What the model call is observed to have returned as of step `upto`, read from the record (never its intent).
 * Null while the call has not answered yet. "Review the result" does not mean the model stops: a review call
 * can return more code, and a final review's code is never run.
 */
export function modelOutcome(section: JourneySection, run: RunDetail, upto: number): ModelOutcome | null {
  if (section.kind !== "model") return null;
  const reached = section.steps.filter(s => s.index <= upto);
  const has = (beat: Beat) => reached.some(s => s.beat === beat);
  const it = run.iterations.find(i => i.number === section.iteration);
  const intent = section.steps.find(s => s.intent)?.intent ?? it?.intent ?? "write";
  const snapshot = has("snapshot");
  if (has("done_reply") || (snapshot && it?.status === "done")) return { kind: "done", text: "Replied DONE", tone: "ok" };
  if (has("accepted") || (snapshot && it?.code && !section.finalReview))
    return { kind: "code", text: intent === "review" ? "Returned more code" : "Returned code", tone: "muted" };
  if (section.finalReview && it?.code && (reached.some(s => s.log?.source === "model" || s.level === "WARN") || snapshot))
    return { kind: "not_executed", text: "Returned code · not executed", tone: "warn" };
  if (reached.some(s => s.level === "ERROR")) return { kind: "failed", text: "Model call failed", tone: "bad" };
  const running = run.status === "running" || run.status === "pending";
  // The section's record continues (or the run is live): the answer is still to come
  if (section.steps.some(s => s.index > upto) || running) return null;
  const answered = section.steps.some(s => s.beat === "response");
  // Partial = answer text had started streaming; reasoning alone is not a reply (it is shown on its own)
  if (!answered && has("first_token") && it?.code)
    return { kind: "partial", text: "Partial response · not used", tone: "warn" };
  if (!answered && reached.length) return { kind: "none", text: "No response recorded", tone: "muted" };
  return null;
}

/** One-line summary of a section's result, as of the step `upto` (later steps never leak in). */
export function sectionSummary(section: JourneySection, run: RunDetail, upto: number, sections: JourneySection[] = []): { text: string; tone: "ok" | "bad" | "warn" | "muted" } | null {
  const reached = section.steps.filter(s => s.index <= upto);
  const has = (beat: Beat) => reached.some(s => s.beat === beat);
  const it = run.iterations.find(i => i.number === section.iteration);
  switch (section.kind) {
    case "model": {
      const o = modelOutcome(section, run, upto);
      if (!o) return null;
      return o.kind === "code" ? { text: `${o.text} · ${iterFile(section.iteration)}`, tone: o.tone } : { text: o.text, tone: o.tone };
    }
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

/**
 * What the recorded data says happens after this section (the transition rule), as of step `upto`. `known` is how
 * far the record is revealed (the whole run when exploring, the replay position in replay): once the section itself
 * is complete, the step recorded after it may be named even though it lies past `upto`.
 */
export function nextTransition(section: JourneySection, sections: JourneySection[], run: RunDetail, upto: number, known = upto): string {
  const running = run.status === "running" || run.status === "pending";
  const after = sectionAfter(section, sections, section.last <= upto ? Math.max(upto, known) : upto);
  // Exploring or replaying a point inside a step: what follows is in the record, but not reached yet
  if (section.kind !== "end" && section.kind !== "stop" && section.steps.some(s => s.index > upto))
    return "Not reached yet at this event: the rest of this step is recorded later.";
  const reached = section.steps.filter(s => s.index <= upto);
  const it = run.iterations.find(i => i.number === section.iteration);
  const ended = after?.kind === "end";
  const endReason = `The run ended: ${RUN_STATUS[run.status]?.label ?? run.status}.`;
  switch (section.kind) {
    case "setup":
      return after?.kind === "model" ? "The runtime sends your task and the system instructions to the model (Model call 1)."
        : ended ? endReason : "The runtime is about to call the model.";
    case "model":
      if (reached.some(s => s.beat === "done_reply") || (reached.some(s => s.beat === "snapshot") && it?.status === "done")) {
        if (ended && run.status === "success") return "The model replied DONE. The runtime accepts DONE only after at least one successful code run, so it ended the run as Completed.";
        if (ended && run.status === "error") return "The model replied DONE, but no code run had succeeded, so the runtime ended the run as Failed.";
        return "The model replied DONE. The runtime accepts DONE only after at least one successful code run, then ends the run.";
      }
      if (after?.kind === "code") {
        const used = run.iterations.filter(i => i.exit_code !== null && i.number < (section.iteration ?? 0)).length;
        return `The model returned code; the runtime decides whether it runs. With ${used} of ${run.max_iterations} code runs used, the runtime writes the code to ${iterFile(section.iteration)} and hands it to the sandbox (${after.title}).`;
      }
      if (section.finalReview && it?.code) return `The model returned code, but ${allRunsUsed(run.max_iterations)}, so the runtime does not execute this code. The run stops without DONE.`;
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

// ─── What happened in this step of this run ──────────────────────────

/** The next recorded section (Stop excluded) as of `upto`: what the record shows came after this one. */
export function sectionAfter(section: JourneySection, sections: JourneySection[], upto: number): JourneySection | undefined {
  return sections.slice(sections.indexOf(section) + 1).find(s => s.first <= upto && s.kind !== "stop");
}

/** The model call that received a code run's result as its newest input (null if the loop ended first). */
export function feedbackTarget(section: JourneySection, sections: JourneySection[], upto: number): JourneySection | null {
  for (const s of sections.slice(sections.indexOf(section) + 1)) {
    if (s.first > upto || s.kind === "end" || s.kind === "code") return null;
    if (s.kind === "model") return s;
  }
  return null;
}

/** The latest earlier code file the model returned, to compare a new reply with. */
export function previousCode(run: RunDetail, n: number | null): Iteration | null {
  if (n == null) return null;
  return [...run.iterations].reverse().find(i => i.number < n && i.code.trim() !== "") ?? null;
}

/** The last non-empty line of stderr: usually the exception line. Shown as recorded text, never as a diagnosis. */
export function lastErrorLine(stderr: string): string | null {
  const line = stderr.trimEnd().split("\n").map(l => l.trim()).filter(Boolean).at(-1);
  return line ? (line.length > 300 ? `${line.slice(0, 300)}…` : line) : null;
}

/** "docker-persistent (agent-workbench-sandbox)" → "docker-persistent": the container name is a detail. */
export function executorKind(executor: string | null | undefined): string {
  return (executor ?? "").replace(/\s*\(.*\)\s*$/, "").trim() || "executor not recorded";
}

/** "all 5 code runs are used" / "the 1 allowed code run is used" */
export const allRunsUsed = (max: number) => max === 1 ? "the 1 allowed code run is used" : `all ${max} code runs are used`;

const lineCount = (code: string) => code.replace(/\n$/, "").split("\n").length;
const linesOf = (code: string) => { const k = lineCount(code); return `${k} line${k === 1 ? "" : "s"}`; };

export interface AccountRow {
  key: "who" | "input" | "output" | "next";
  label: string;
  text: string;
  tone?: FactTone;
  /** A second, quieter line of recorded detail (an error line, the stop message). */
  detail?: string;
  /** The detail is literal program output (an error line), set in monospace. */
  mono?: boolean;
  /** The section this row points to, e.g. the next step. */
  goto?: { key: string; label: string };
}

/**
 * The selected step told as this run recorded it: who acted, what input was available, what came back, and what the
 * record shows happened next. Every value is read from the stored run and its log; nothing is inferred about why.
 */
export function stepAccount(section: JourneySection, sections: JourneySection[], run: RunDetail, upto: number, known = upto): AccountRow[] {
  const n = section.iteration;
  const it = run.iterations.find(i => i.number === n);
  const reached = section.steps.filter(s => s.index <= upto);
  const has = (...beats: Beat[]) => reached.some(s => beats.includes(s.beat));
  const running = run.status === "running" || run.status === "pending";
  // The step after this one is named only once this one is complete at the selected point (no outcome leaks early)
  const after = sectionAfter(section, sections, section.last <= upto ? Math.max(upto, known) : upto);
  const later = section.steps.some(s => s.index > upto);
  const rows: AccountRow[] = [];
  const who = (text: string, detail?: string) => rows.push({ key: "who", label: "Who", text, detail });
  const input = (text: string, tone?: FactTone, detail?: string) => rows.push({ key: "input", label: "Input", text, tone, detail });
  const output = (text: string, tone?: FactTone, detail?: string) => rows.push({ key: "output", label: section.kind === "model" ? "Returned" : "Result", text, tone, detail });
  const pending = later ? "Not recorded yet at this event" : running ? "In progress" : "No result was recorded";
  const modelName = run.model_name ?? (run.model || "model not recorded");
  const codeBefore = [...sections.slice(0, sections.indexOf(section))].reverse().find(s => s.kind === "code");

  switch (section.kind) {
    case "setup":
      who("Runtime", "the application code that runs the loop");
      input(`Your task (${run.prompt.length.toLocaleString()} characters) and the run settings`);
      output(`Up to ${run.max_iterations} code run${run.max_iterations === 1 ? "" : "s"}, ${run.timeout_seconds} s each, with ${modelName}`);
      break;
    case "model": {
      who(`Model · ${modelName}`, run.provider_name ?? run.provider ?? undefined);
      const all = recordedRequests(section);
      const seen = all.filter(r => r.step.index <= upto);
      const shown = seen.at(-1);
      if (shown) {
        const k = shown.messages.length;
        const newest = shown.messages.at(-1);
        const feedback = newest && newest.role === "user" && k > 1 && /^Execution feedback/.test(describeMessage(newest, k - 1));
        input(`System instructions and ${k} message${k === 1 ? "" : "s"}`, undefined,
          newest ? `Newest: ${describeMessage(newest, k - 1)}${feedback && codeBefore ? ` (from ${codeBefore.title})` : ""}` : undefined);
      } else if (all.length) input("Recorded when the call starts", "muted");
      else if (running && !section.steps.some(s => s.beat === "calling")) input("The runtime is preparing the request", "muted");
      else input("Not recorded", "muted", "This run was stored before model inputs were saved.");
      const o = modelOutcome(section, run, upto);
      const lines = it?.code ? `${iterFile(n)} · ${linesOf(it.code)}` : undefined;
      const retried = section.formatRetries > 0 ? ` (after ${section.formatRetries} format ${section.formatRetries === 1 ? "retry" : "retries"})` : "";
      if (!o) output(running && !later ? "Not returned yet" : "Not returned yet at this event", "muted");
      else if (o.kind === "code") output(`${o.text}${retried}`, undefined, lines);
      else if (o.kind === "done") output(`DONE, with no code${retried}`, "ok");
      else if (o.kind === "not_executed") output("Code that the runtime did not run", "warn", lines ? `${lines} · no code runs were left` : undefined);
      else if (o.kind === "failed") output("No usable reply: the call failed", "bad", reached.find(s => s.level === "ERROR")?.title);
      else if (o.kind === "partial") output("A partial reply, cut off before it was complete", "warn", "It was never parsed and never ran.");
      else output("No response was recorded", "muted", sections.some(s => s.kind === "stop") && !section.steps.some(s => s.beat === "response")
        ? "The call was interrupted by Stop." : undefined);
      break;
    }
    case "code": {
      const container = /\(([^)]+)\)\s*$/.exec(run.executor ?? "")?.[1];
      who(`Sandbox · ${executorKind(run.executor)}`, container ? `container ${container}` : undefined);
      input(it?.code ? `${iterFile(n)}, returned by Model call ${n}` : "No code is recorded for this run", it?.code ? undefined : "muted",
        it?.code ? linesOf(it.code) : undefined);
      const exited = has("exited", "snapshot") && it?.exit_code != null;
      if (exited && it) {
        const time = it.execution_time_ms != null ? ` after ${formatMs(it.execution_time_ms)}` : "";
        if (it.timed_out) output(`Timed out${time}`, "warn", `Killed at the ${run.timeout_seconds} s limit (exit 124).`);
        else if (it.false_success) output(`Exit code 0${time}`, "warn", "But the first line of stdout looked like an error message.");
        else if (it.exit_code === 0) output(`Exit code 0${time}`, "ok", it.stdout.trim() ? `${it.stdout.length.toLocaleString()} characters of stdout` : "Nothing printed to stdout");
        else {
          const line = lastErrorLine(it.stderr);
          output(`Exit code ${it.exit_code}${time}`, "bad", line ? `Last line of stderr: ${line}` : "stderr is empty");
          rows[rows.length - 1].mono = !!line;
        }
      } else if (has("killed")) output("The process was killed before it finished", "warn");
      else output(pending, "muted");
      break;
    }
    case "check": {
      who("Runtime", "applies the stop rules; the model is not involved");
      const used = run.iterations.filter(i => i.exit_code !== null && i.number <= (n ?? 0)).length;
      if (it && it.exit_code != null && has("checking", "result", "snapshot"))
        input(`${it.timed_out ? "Timed out" : `Exit code ${it.false_success ? 0 : it.exit_code}`} from ${codeBefore?.title ?? "the code run"}`, undefined,
          `${used} of ${run.max_iterations} code runs used`);
      else input(pending, "muted");
      const decision = has("result", "snapshot") ? checkDecision(run, n) : null;
      if (decision && it) output(it.false_success ? "Treated as failed by the output check" : it.exit_code === 0 ? "Success" : "Failure",
        it.exit_code === 0 ? "ok" : it.false_success ? "warn" : "bad", decision);
      else output(pending, "muted");
      break;
    }
    case "stop":
      who("You, then the runtime");
      input("Stop pressed in the UI");
      output("The agent task is cancelled; a running process is killed");
      break;
    case "end": {
      who("Runtime");
      const prev = [...sections.slice(0, sections.indexOf(section))].reverse().find(s => s.kind !== "stop") ?? null;
      const prevSummary = prev ? sectionSummary(prev, run, upto, sections) : null;
      if (prev) input(`${prev.title}${prevSummary ? `: ${prevSummary.text}` : ""}`);
      const meta = RUN_STATUS[run.status];
      output(meta?.label ?? run.status, meta?.tone === "success" ? "ok" : meta?.tone === "danger" ? "bad" : meta?.tone === "warning" ? "warn" : "muted",
        run.message || undefined);
      return rows;
    }
  }
  rows.push({ key: "next", label: "Next", text: nextTransition(section, sections, run, upto, known),
    goto: after ? { key: after.key, label: after.title } : undefined });
  return rows;
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
