// Agent Studio: turns the recorded activity log of ONE agent run into ordered steps.
// Live and Replay both read these steps; nothing here invents events, durations or model reasoning.
import type { Flow, Intent, IterationArtifact, LogEntry, RunDetail } from "./api";
import { RUN_STATUS } from "./format";

export type Actor = "model" | "runtime" | "sandbox";

export type Beat =
  | "start" | "iteration" | "send" | "calling" | "first_token" | "response" | "parsed"
  | "accepted" | "done_reply" | "handoff" | "executing" | "install" | "exited" | "killed"
  | "artifact" | "no_files" | "checking" | "result" | "stop" | "finished" | "note"
  // Older runs without detailed logs: reconstructed from run/iteration rows.
  | "snapshot";

export type PacketTone = "prompt" | "code" | "output" | "error" | "done";

export interface Transfer {
  from: Actor;
  to: Actor;
  label: string;
  tone: PacketTone;
}

export interface StudioStep {
  key: string;
  index: number;
  ts: string;
  iteration: number | null;
  beat: Beat;
  actor: Actor;
  title: string;
  level: "INFO" | "WARN" | "ERROR";
  intent?: Intent;
  transfer?: Transfer;
  log?: LogEntry;
  /** Rebuilt from the run record because no log entry exists. */
  synthetic?: boolean;
}

export interface VisibleFile extends IterationArtifact {
  iteration: number;
  download: string;
}

export const iterFile = (n: number | null | undefined) => `iter_${String(n ?? 0).padStart(2, "0")}.py`;

const SEND: Record<Intent, { title: string; label: string; tone: PacketTone }> = {
  write: { title: "Task sent to the model", label: "Task", tone: "prompt" },
  fix: { title: "Error sent back to the model", label: "Error", tone: "error" },
  review: { title: "Output sent back to the model", label: "Output", tone: "output" },
};

function startsWith(log: LogEntry, prefix: string) {
  return log.message.startsWith(prefix);
}

function exitFrom(text: string): number | null {
  const m = /exit code (-?\d+)/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * The `flow` tag of an entry. Entries written before a tag existed have none, so they are recognized by their
 * source, data shape or message text: runs stored in older databases must keep rendering the same way.
 * New backend log entries carry their tag (domain/events.py), so this is only a fallback.
 */
function legacyFlow(log: LogEntry): Flow | undefined {
  const d = log.data;
  if (log.source === "llm") {
    if ("messages" in d) return "calling";
    if (startsWith(log, "First token")) return "first_token";
    if ("stop_reason" in d) return "response";
    if (startsWith(log, "Parsed response")) return "parsed";
  } else if (log.source === "sandbox") {
    if (startsWith(log, "Wrote code")) return "handoff";
    if ("exit_code" in d) return "exited";
    if (startsWith(log, "Execution cancelled") || startsWith(log, "Process killed")) return "killed";
    if (startsWith(log, "No new or changed files")) return "no_files";
  } else if (log.source === "runtime") {
    if ("intent" in d) return "iteration";
    if (startsWith(log, "Stop requested")) return "stop";
  }
  return undefined;
}

/** Classify one log entry by its `flow` tag. */
function classify(log: LogEntry, run: RunDetail): Omit<StudioStep, "key" | "index" | "ts" | "iteration" | "level" | "log"> {
  const n = log.iteration;
  const flow = (log.data.flow as Flow | undefined) ?? legacyFlow(log);
  switch (flow) {
    case "started": return { beat: "start", actor: "runtime", title: "Run started" };
    case "iteration": return { beat: "iteration", actor: "runtime", intent: log.data.intent as Intent, title: log.message };
    case "write": case "fix": case "review": {
      const intent = flow as Intent;
      const s = SEND[intent];
      return { beat: "send", actor: "runtime", intent, title: s.title,
        transfer: { from: "runtime", to: "model", label: s.label, tone: s.tone } };
    }
    case "calling": return { beat: "calling", actor: "model", title: `Calling ${run.model || "the model"}` };
    case "first_token": return { beat: "first_token", actor: "model", title: "Model is generating" };
    case "response": return { beat: "response", actor: "model", title: log.message };
    case "parsed": return { beat: "parsed", actor: "model", title: log.message.replace(/^Parsed response: /, "Parsed: ") };
    case "code": return { beat: "accepted", actor: "model", title: `Code accepted · ${iterFile(n)}`,
      transfer: { from: "model", to: "runtime", label: iterFile(n), tone: "code" } };
    case "done_reply": return { beat: "done_reply", actor: "model", title: "Model replied DONE",
      transfer: { from: "model", to: "runtime", label: "DONE", tone: "done" } };
    case "handoff": return { beat: "handoff", actor: "sandbox", title: `${iterFile(n)} handed to the sandbox`,
      transfer: { from: "runtime", to: "sandbox", label: iterFile(n), tone: "code" } };
    case "executing": return { beat: "executing", actor: "sandbox", title: `Running ${iterFile(n)}` };
    case "installing": case "rerunning": case "install_failed":
      return { beat: "install", actor: "sandbox", title: log.message };
    case "exited": return { beat: "exited", actor: "sandbox", title: log.message };
    case "killed": return { beat: "killed", actor: "sandbox", title: log.message };
    case "artifacts": {
      const count = Object.keys(filesOf(log)).length;
      return { beat: "artifact", actor: "sandbox", title: `${count} file${count === 1 ? "" : "s"} saved` };
    }
    case "no_files": return { beat: "no_files", actor: "sandbox", title: "No new files" };
    case "checking": {
      const exit = log.data.exit_code;
      const code = (typeof exit === "number" ? exit : exitFrom(log.message))
        ?? run.iterations.find(it => it.number === n)?.exit_code ?? null;
      const timedOut = code === 124;
      return { beat: "checking", actor: "runtime", title: "Runtime checking the result",
        transfer: { from: "sandbox", to: "runtime", label: timedOut ? "Timed out" : `exit ${code ?? "?"}`,
          tone: code === 0 ? "output" : "error" } };
    }
    case "result": {
      const code = log.data.exit_code;
      return { beat: "result", actor: "runtime",
        title: code === 0 ? "Result recorded · exit 0" : `Error recorded${log.data.error ? ` · ${String(log.data.error)}` : ` · exit ${String(code)}`}` };
    }
    case "stop": return { beat: "stop", actor: "runtime", title: "Stop requested by user" };
    case "finished": return { beat: "finished", actor: "runtime",
      title: `Run finished · ${RUN_STATUS[run.status]?.label ?? run.status}` };
  }
  return { beat: "note", actor: log.source === "model" ? "model" : log.source === "sandbox" ? "sandbox" : "runtime", title: log.message };
}

export function filesOf(log?: LogEntry): Record<string, number> {
  const files = log?.data.files;
  return files && typeof files === "object" && !Array.isArray(files) ? files as Record<string, number> : {};
}

export interface BuiltSteps {
  steps: StudioStep[];
  /** Detailed activity is missing (older run) or the terminal log is missing. */
  partial: boolean;
}

export function buildSteps(run: RunDetail, logs: LogEntry[]): BuiltSteps {
  const running = run.status === "running" || run.status === "pending";
  const detailed = logs.some(l => l.data.flow === "started");
  // A write iteration's "Iteration N started" line carries flow=write itself, so it becomes the send step.
  const steps: Omit<StudioStep, "index">[] = logs.map(log => ({
    key: `log-${log.id}`, ts: log.ts, iteration: log.iteration, level: log.level, log, ...classify(log, run),
  }));
  if (!detailed && !running) {
    // Older databases kept iteration rows even when activity phases were never logged.
    if (!logs.length) steps.push({ key: "created", ts: run.created_at, iteration: null, beat: "start",
      actor: "runtime", title: "Run created", level: "INFO", synthetic: true });
    for (const it of run.iterations) {
      if (!logs.length) steps.push({ key: `start-${it.number}`, ts: it.started_at, iteration: it.number,
        beat: "iteration", actor: "runtime", intent: it.intent, title: `Iteration ${it.number} started`, level: "INFO", synthetic: true });
      if (it.finished_at) steps.push({ key: `snapshot-${it.number}`, ts: it.finished_at, iteration: it.number,
        beat: "snapshot", actor: it.status === "done" ? "model" : it.exit_code !== null ? "sandbox" : "runtime",
        title: it.status === "done" ? "Model replied DONE" : it.exit_code !== null ? `Iteration ${it.number} · exit ${it.exit_code}` : `Iteration ${it.number} ended`,
        level: it.exit_code ? "WARN" : "INFO", synthetic: true });
    }
    steps.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  const hasFinish = steps.some(s => s.beat === "finished");
  if (run.finished_at && !running && !hasFinish) {
    steps.push({ key: "finished", ts: run.finished_at, iteration: run.iterations.at(-1)?.number ?? null, beat: "finished",
      actor: "runtime", title: `Run finished · ${RUN_STATUS[run.status]?.label ?? run.status}`, level: "INFO", synthetic: true });
  }
  return {
    steps: steps.map((s, index) => ({ ...s, index })),
    partial: (!detailed && !running) || Boolean(run.finished_at && !running && !hasFinish),
  };
}

/** Everything that is known at a given step. Later steps must never leak into this. */
export interface Seen {
  index: number;
  iteration: number | null;
  intent: Intent | null;
  code: Set<number>;
  exited: Set<number>;
  result: Set<number>;
  done: Set<number>;
  files: VisibleFile[];
  newFiles: Set<string>;
  finished: boolean;
  stopped: boolean;
}

export function artifactFor(run: RunDetail, n: number, path: string, size = 0): VisibleFile {
  const known = run.iterations.find(it => it.number === n)?.artifacts.find(a => a.path === path);
  const url = known?.url ?? `/api/runs/${run.id}/artifacts/${encodeURIComponent(path)}?iteration=${n}`;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = known?.mime ?? ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", csv: "text/csv", json: "application/json" } as Record<string, string>)[ext]
    ?? "application/octet-stream";
  return { path, size: known?.size ?? size, mime, url, snapshot_available: known?.snapshot_available,
    iteration: n, download: `${url}${url.includes("?") ? "&" : "?"}download=1` };
}

export function seenAt(run: RunDetail, steps: StudioStep[], index: number): Seen {
  const seen: Seen = { index, iteration: null, intent: null, code: new Set(), exited: new Set(), result: new Set(),
    done: new Set(), files: [], newFiles: new Set(), finished: false, stopped: false };
  const files = new Map<string, VisibleFile>();
  for (const s of steps.slice(0, index + 1)) {
    const n = s.iteration;
    if (n != null && s.beat !== "finished") {
      if (n !== seen.iteration) seen.intent = null;
      seen.iteration = n;
    }
    if (s.intent) seen.intent = s.intent;
    if (s.beat === "finished") seen.finished = true;
    if (s.beat === "stop") seen.stopped = true;
    if (n == null) continue;
    if (s.beat === "accepted") seen.code.add(n);
    if (s.beat === "exited" || s.beat === "killed") seen.exited.add(n);
    if (s.beat === "result") { seen.result.add(n); seen.exited.add(n); }
    if (s.beat === "done_reply") seen.done.add(n);
    if (s.beat === "artifact") {
      for (const [path, size] of Object.entries(filesOf(s.log))) files.set(path, artifactFor(run, n, path, size));
    }
    if (s.beat === "snapshot") {
      const it = run.iterations.find(i => i.number === n);
      if (it?.code) seen.code.add(n);
      if (it?.exit_code != null) { seen.exited.add(n); seen.result.add(n); }
      if (it?.status === "done") seen.done.add(n);
      for (const a of it?.artifacts ?? []) files.set(a.path, artifactFor(run, n, a.path, a.size));
    }
  }
  const current = steps[index];
  if (seen.intent == null && seen.iteration != null) seen.intent = run.iterations.find(it => it.number === seen.iteration)?.intent ?? null;
  if (current?.beat === "artifact") seen.newFiles = new Set(Object.keys(filesOf(current.log)));
  seen.files = [...files.values()];
  return seen;
}

/** One-line, plain-English description of what the agent does at this step (mechanism, not model reasoning). */
export function explain(step: StudioStep, run: RunDetail): string {
  const file = iterFile(step.iteration);
  switch (step.beat) {
    case "start": return step.synthetic ? "The run was created. Detailed activity was not recorded for this older run."
      : "The runtime starts the loop with your task.";
    case "iteration": return step.intent === "fix" ? "A new iteration starts to fix the previous error."
      : step.intent === "review" ? "A new iteration starts so the model can review the output." : "A new iteration starts.";
    case "send": return step.intent === "fix" ? "The runtime sends the error back so the model can fix the code."
      : step.intent === "review" ? "The runtime sends the output back so the model can decide: DONE or another step."
      : "The runtime sends your task to the model.";
    case "calling": return "Waiting for the model’s response.";
    case "first_token": return "The model started streaming its answer.";
    case "response": return "The full response arrived from the model.";
    case "parsed": return "The runtime parsed the response into a code block.";
    case "accepted": return `The runtime accepted the complete code block as ${file}.`;
    case "done_reply": return "The model reviewed the output and replied DONE.";
    case "handoff": return `The runtime wrote ${file} and handed it to the sandbox.`;
    case "executing": return `The sandbox is running ${file}.`;
    case "install": return "The sandbox is installing a missing package.";
    case "exited": return exitFrom(step.title) === 0 ? "The process exited successfully." : step.title;
    case "killed": return "The running process was killed.";
    case "artifact": return "The code saved files to the output folder.";
    case "no_files": return "The code did not save any new files.";
    case "checking": return "The runtime receives the output and checks the exit code.";
    case "result": return step.log?.data.exit_code === 0 ? "The runtime recorded a successful result." : "The runtime recorded the error.";
    case "stop": return "You pressed Stop. The runtime cancels the loop.";
    case "finished": return ({
      success: "The model replied DONE, so the runtime ended the run.",
      max_retries: "The runtime used every allowed code run and the model did not reply DONE (the last run failed, or the final review asked for another step).",
      timeout: "The code run limit was reached and the last execution timed out.",
      stopped: "The runtime stopped the run at your request.",
      error: "The runtime ended the run because of an error.",
    } as Partial<Record<string, string>>)[run.status] ?? `The run ended: ${RUN_STATUS[run.status]?.label}.`;
    case "snapshot": return "Iteration result restored from the run record.";
    default: return step.title;
  }
}

/** Gap before advancing to `next` during replay (ms at 1×). Recorded gaps are clamped so long waits stay watchable. */
export const REPLAY_MIN_MS = 450;
export const REPLAY_TRANSFER_MIN_MS = 1000;
export const REPLAY_MAX_MS = 2400;

export function replayGap(current: StudioStep, next: StudioStep) {
  const recorded = Date.parse(next.ts) - Date.parse(current.ts);
  const min = current.transfer ? REPLAY_TRANSFER_MIN_MS : REPLAY_MIN_MS;
  return Math.min(REPLAY_MAX_MS, Math.max(min, Number.isFinite(recorded) ? recorded : min));
}

export interface StepGroup {
  key: string;
  label: string;
  iteration: number | null;
  steps: StudioStep[];
}

/** Timeline groups: run start, one group per iteration, then the run's end. */
export function groupSteps(steps: StudioStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const s of steps) {
    const end = s.beat === "finished";
    const key = end ? "end" : s.iteration != null ? `iter-${s.iteration}` : groups.at(-1)?.key ?? "setup";
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, iteration: end ? null : s.iteration, steps: [],
        label: end ? "End" : s.iteration != null ? `Iteration ${s.iteration}` : "Start" };
      groups.push(group);
    }
    group.steps.push(s);
  }
  return groups;
}

export function stepTime(ts: string) {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3,
    hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
