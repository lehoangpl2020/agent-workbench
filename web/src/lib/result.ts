// The run result: which recorded output a finished run produced, and how to label it. Pure functions over the
// stored run; nothing here summarizes, validates or infers an answer from the logs.
import type { Iteration, RunDetail, RunStatus } from "./api";
import { RUN_STATUS } from "./format";
import { iterFile } from "./studio";

export type ResultKind = "final" | "partial" | "failed" | "none" | "running";

export interface RunResultView {
  kind: ResultKind;
  /** The code run whose recorded output is shown (null when no code run finished). */
  source: Iteration | null;
  /** 1-based position of `source` among the code runs that finished. */
  codeRun: number | null;
  /** "Final output" */
  title: string;
  /** "stdout of code run 1 · iter_01.py · exit 0 · 0.35 s" is built by the component; this is the context line. */
  note: string;
}

const RUNNING: RunStatus[] = ["running", "pending"];

/** Iterations whose code actually ran (an exit code was recorded), in order. */
export function codeRunsOf(run: RunDetail): Iteration[] {
  return run.iterations.filter(i => i.exit_code !== null);
}

/** Code run number of an iteration (its position among the iterations that ran code), or null. */
export function codeRunNumber(run: RunDetail, iteration: number | null | undefined): number | null {
  const i = codeRunsOf(run).findIndex(it => it.number === iteration);
  return i < 0 ? null : i + 1;
}

/**
 * The output a run produced. Mirrors the backend's `best_answer()` (core/rules.py): the stdout of the latest code run
 * with exit code 0 (a run the output check overruled is stored with exit code 1, so it never counts).
 */
export function runResult(run: RunDetail): RunResultView {
  const status = RUN_STATUS[run.status]?.label ?? run.status;
  if (RUNNING.includes(run.status)) {
    return { kind: "running", source: null, codeRun: null, title: "Run in progress", note: "The result appears when the run ends." };
  }
  const runs = codeRunsOf(run);
  const ok = [...runs].reverse().find(i => i.exit_code === 0) ?? null;
  const last = runs.at(-1) ?? null;
  const number = (it: Iteration | null) => (it ? runs.indexOf(it) + 1 : null);

  if (ok && run.status === "success") {
    const done = run.iterations.find(i => i.status === "done");
    return { kind: "final", source: ok, codeRun: number(ok), title: "Final output",
      note: done ? `The model reviewed this output and replied DONE in model call ${done.number}.` : "The run completed." };
  }
  if (ok) {
    const later = last && last !== ok ? ` Later code runs failed.` : "";
    return { kind: "partial", source: ok, codeRun: number(ok), title: "Partial result",
      note: `The run ended as “${status}”, so this is the latest successful output, not an answer the model confirmed.${later}` };
  }
  if (last) {
    return { kind: "failed", source: last, codeRun: number(last), title: "No successful output",
      note: `No code run exited with code 0. The error output of the last code run is shown.` };
  }
  return { kind: "none", source: null, codeRun: null, title: "No output",
    note: run.status === "stopped" ? "The run was stopped before any code finished running." : "No code run finished in this run." };
}

/** "stdout of code run 2 · iter_02.py · exit 0 · 0.35 s" */
export function sourceLabel(view: RunResultView, stream: "stdout" | "stderr", time: (ms: number | null) => string): string {
  const it = view.source;
  if (!it) return "";
  const parts = [`${stream} of code run ${view.codeRun}`, iterFile(it.number),
    it.timed_out ? "timed out" : `exit ${it.exit_code}`];
  if (it.execution_time_ms != null) parts.push(time(it.execution_time_ms));
  return parts.join(" · ");
}

/** Short enough to show as a large, fully visible answer instead of a terminal block. */
export function isShortOutput(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 240 && t.split("\n").length <= 4;
}
