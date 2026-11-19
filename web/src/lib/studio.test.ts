// Unit tests for the logic behind Live Flow and Replay. The fixtures are real scripted runs recorded from the
// backend (tests/test_ui_fixtures.py keeps them in sync with what the backend emits).
import { describe, expect, it } from "vitest";
import type { LogEntry, RunDetail } from "./api";
import finalReview from "./__fixtures__/final_review_rejected.json";
import fixThenDone from "./__fixtures__/fix_then_done.json";
import {
  artifactFor, buildSteps, explain, groupSteps, REPLAY_MAX_MS, REPLAY_MIN_MS, REPLAY_TRANSFER_MIN_MS, replayGap,
  seenAt, type StudioStep,
} from "./studio";

type Recorded = { run: RunDetail; logs: LogEntry[] };
const fix = fixThenDone as unknown as Recorded;
const review = finalReview as unknown as Recorded;
const clone = <T,>(value: T): T => structuredClone(value);

const beats = (steps: StudioStep[]) => steps.map(s => s.beat);
const firstIndex = (steps: StudioStep[], beat: StudioStep["beat"], iteration?: number) =>
  steps.findIndex(s => s.beat === beat && (iteration === undefined || s.iteration === iteration));

describe("buildSteps on a recorded run", () => {
  const { steps, partial } = buildSteps(fix.run, fix.logs);

  it("turns every log entry into one step, in order, with unique keys", () => {
    expect(steps).toHaveLength(fix.logs.length);
    expect(steps.map(s => s.index)).toEqual(steps.map((_, i) => i));
    expect(new Set(steps.map(s => s.key)).size).toBe(steps.length);
    expect(partial).toBe(false);
  });

  it("recognizes the whole mechanism", () => {
    const seen = new Set(beats(steps));
    for (const beat of ["start", "send", "calling", "accepted", "handoff", "executing", "exited", "artifact",
      "checking", "result", "done_reply", "finished"] as const) {
      expect(seen.has(beat), beat).toBe(true);
    }
  });

  it("labels what is sent back to the model by the reason for the call", () => {
    const sends = steps.filter(s => s.beat === "send").map(s => s.intent);
    expect(sends).toEqual(["write", "fix", "review"]);
  });

  it("shows hand-offs as transfers between the right actors", () => {
    const accepted = steps[firstIndex(steps, "accepted", 1)];
    expect(accepted.transfer).toMatchObject({ from: "model", to: "runtime", tone: "code", label: "iter_01.py" });
    const handoff = steps[firstIndex(steps, "handoff", 1)];
    expect(handoff.transfer).toMatchObject({ from: "runtime", to: "sandbox" });
    const failed = steps[firstIndex(steps, "checking", 1)];
    expect(failed.transfer).toMatchObject({ from: "sandbox", to: "runtime", tone: "error", label: "exit 1" });
    const ok = steps[firstIndex(steps, "checking", 2)];
    expect(ok.transfer).toMatchObject({ tone: "output", label: "exit 0" });
  });

  it("ends with the run's final status", () => {
    expect(steps.at(-1)).toMatchObject({ beat: "finished", title: "Run finished · Completed" });
  });

  it("every step has a plain-English explanation", () => {
    for (const s of steps) expect(explain(s, fix.run).length, s.beat).toBeGreaterThan(0);
  });
});

describe("seenAt: later steps never leak into an earlier view", () => {
  const { steps } = buildSteps(fix.run, fix.logs);

  it("knows nothing about results before they happen", () => {
    const seen = seenAt(fix.run, steps, firstIndex(steps, "accepted", 1));
    expect([...seen.code]).toEqual([1]);
    expect(seen.result.size).toBe(0);
    expect(seen.exited.size).toBe(0);
    expect(seen.files).toEqual([]);
    expect(seen.finished).toBe(false);
  });

  it("does not reveal the next step either", () => {
    // The step right before a file is saved must not show it, and the step before the result must not show it
    expect(seenAt(fix.run, steps, firstIndex(steps, "exited", 2)).files).toEqual([]);
    expect(seenAt(fix.run, steps, firstIndex(steps, "checking", 1)).result.size).toBe(0);
    expect(seenAt(fix.run, steps, firstIndex(steps, "send", 3) - 1).done.size).toBe(0);
    expect(seenAt(fix.run, steps, steps.length - 2).finished).toBe(false);
  });

  it("accumulates iterations, files and the final state", () => {
    const end = seenAt(fix.run, steps, steps.length - 1);
    expect([...end.code]).toEqual([1, 2]);
    expect([...end.result]).toEqual([1, 2]);
    expect([...end.done]).toEqual([3]);
    expect(end.finished).toBe(true);
    expect(end.files.map(f => [f.path, f.iteration])).toEqual([["out.txt", 2]]);
  });

  it("highlights new files only on the step that saved them", () => {
    const at = firstIndex(steps, "artifact", 2);
    expect([...seenAt(fix.run, steps, at).newFiles]).toEqual(["out.txt"]);
    expect(seenAt(fix.run, steps, at + 1).newFiles.size).toBe(0);
  });

  it("tracks the reason for the current iteration", () => {
    expect(seenAt(fix.run, steps, firstIndex(steps, "send", 2)).intent).toBe("fix");
    expect(seenAt(fix.run, steps, firstIndex(steps, "send", 3)).intent).toBe("review");
  });
});

describe("groupSteps", () => {
  it("groups the start, each iteration and the end", () => {
    const groups = groupSteps(buildSteps(fix.run, fix.logs).steps);
    expect(groups.map(g => g.label)).toEqual(["Start", "Iteration 1", "Iteration 2", "Iteration 3", "End"]);
    expect(groups.flatMap(g => g.steps)).toHaveLength(fix.logs.length);
  });
});

describe("a run that hit the limit", () => {
  it("keeps the final review as an extra iteration and the status label", () => {
    const { steps } = buildSteps(review.run, review.logs);
    expect(steps.at(-1)?.title).toBe("Run finished · Code run limit reached");
    expect(groupSteps(steps).map(g => g.label)).toEqual(["Start", "Iteration 1", "Iteration 2", "End"]);
    expect(beats(steps)).not.toContain("done_reply");
  });
});

describe("older runs without detailed logs", () => {
  it("are rebuilt from the stored iterations and flagged as partial", () => {
    const run = clone(fix.run);
    const { steps, partial } = buildSteps(run, []);
    expect(partial).toBe(true);
    expect(steps.every(s => s.synthetic)).toBe(true);
    expect(steps[0]).toMatchObject({ beat: "start", title: "Run created" });
    expect(beats(steps)).toContain("snapshot");
    expect(steps.at(-1)?.beat).toBe("finished");
    expect(explain(steps[0], run)).toContain("not recorded");
  });

  it("are not flagged while the run is still going and no log has arrived yet", () => {
    const run = { ...clone(fix.run), status: "running" as const, finished_at: null };
    expect(buildSteps(run, [])).toEqual({ steps: [], partial: false });
  });

  it("add an end step when the terminal log is missing", () => {
    const logs = fix.logs.filter(l => l.data.flow !== "finished");
    const { steps, partial } = buildSteps(fix.run, logs);
    expect(partial).toBe(true);
    expect(steps.at(-1)).toMatchObject({ beat: "finished", synthetic: true });
  });
});

describe("log entries without a flow tag (written before tags existed)", () => {
  const entry = (id: number, source: string, message: string, data: Record<string, unknown> = {}): LogEntry =>
    ({ id, ts: `2026-01-01T12:00:0${id}.000+00:00`, iteration: 1, source, level: "INFO", message, data });

  it("are placed by their source and message", () => {
    const logs = [
      entry(1, "runtime", "Run started", { flow: "started" }),
      entry(2, "llm", "Calling m", { messages: 1 }),
      entry(3, "llm", "First token after 0.5s"),
      entry(4, "llm", "Response received in 1.0s", { stop_reason: "end_turn" }),
      entry(5, "llm", "Parsed response: python code, 1 lines / 8 chars"),
      entry(6, "sandbox", "Wrote code to code/iter_01.py"),
      entry(7, "sandbox", "Execution finished: exit code 0 in 0.10s", { exit_code: 0 }),
      entry(8, "sandbox", "No new or changed files in /workspace/output"),
      entry(9, "sandbox", "Process killed after 0.2s"),
      entry(10, "runtime", "Stop requested by user"),
      entry(11, "runtime", "Something else"),
    ];
    const running = { ...clone(fix.run), status: "running" as const, finished_at: null };
    const { steps } = buildSteps(running, logs);
    expect(beats(steps)).toEqual(["start", "calling", "first_token", "response", "parsed", "handoff", "exited",
      "no_files", "killed", "stop", "note"]);
  });
});

describe("runs recorded before the newer flow tags existed", () => {
  const NEWER = new Set(["iteration", "calling", "first_token", "response", "parsed", "handoff", "exited", "killed",
    "no_files", "stop"]);
  const untagged = (recorded: Recorded): LogEntry[] => recorded.logs.map(l => {
    const data = { ...l.data };
    if (NEWER.has(String(data.flow))) delete data.flow;
    if (data.flow === "checking") delete data.exit_code;
    return { ...l, data };
  });

  it.each([["fix_then_done", fix], ["final_review_rejected", review]])("%s renders the same without them", (_name, recorded) => {
    const tagged = buildSteps(recorded.run, recorded.logs);
    const legacy = buildSteps(recorded.run, untagged(recorded));
    expect(legacy.steps.map(s => [s.beat, s.title, s.actor, s.transfer])).toEqual(
      tagged.steps.map(s => [s.beat, s.title, s.actor, s.transfer]));
    expect(legacy.partial).toBe(tagged.partial);
  });

  it("the exit code of a check comes from the tag, or from the message when there is none", () => {
    const entry = (data: Record<string, unknown>): LogEntry => ({ id: 1, ts: "2026-01-01T12:00:00.000+00:00", iteration: 1,
      source: "runtime", level: "INFO", message: "Runtime checking the result (exit code 7)", data });
    const run = clone(fix.run);
    expect(buildSteps(run, [entry({ flow: "checking", exit_code: 3 })]).steps[0].transfer?.label).toBe("exit 3");
    expect(buildSteps(run, [entry({ flow: "checking" })]).steps[0].transfer?.label).toBe("exit 7");
  });
});

describe("replayGap", () => {
  const step = (ts: string, transfer = false) =>
    ({ ts, transfer: transfer ? { from: "model", to: "runtime", label: "x", tone: "code" } : undefined }) as StudioStep;
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0, ms)).toISOString();

  it("clamps recorded waits so long gaps stay watchable and short ones stay visible", () => {
    expect(replayGap(step(at(0)), step(at(100)))).toBe(REPLAY_MIN_MS);
    expect(replayGap(step(at(0)), step(at(1000)))).toBe(1000);
    expect(replayGap(step(at(0)), step(at(60_000)))).toBe(REPLAY_MAX_MS);
  });

  it("gives hand-offs more time on screen", () => {
    expect(replayGap(step(at(0), true), step(at(100)))).toBe(REPLAY_TRANSFER_MIN_MS);
  });

  it("falls back to the minimum for unreadable timestamps", () => {
    expect(replayGap(step("not a date"), step(at(100)))).toBe(REPLAY_MIN_MS);
  });
});

describe("artifactFor", () => {
  it("uses the stored URL and adds a download link", () => {
    const file = artifactFor(fix.run, 2, "out.txt");
    expect(file.url).toContain("/artifacts/out.txt?iteration=2");
    expect(file.download).toBe(`${file.url}&download=1`);
    expect(file.mime).toBe("text/plain");
  });

  it("builds a snapshot URL and guesses the type for files the run record does not list", () => {
    const file = artifactFor(fix.run, 1, "dir/plot 1.png", 10);
    expect(file.url).toBe(`/api/runs/${fix.run.id}/artifacts/dir%2Fplot%201.png?iteration=1`);
    expect(file.mime).toBe("image/png");
    expect(file.size).toBe(10);
  });
});
