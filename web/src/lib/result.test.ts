// The run result (result.ts) on runs recorded from the backend (tests/contract/test_ui_fixtures.py).
import { describe, expect, it } from "vitest";
import type { LogEntry, RunDetail } from "./api";
import finalReview from "./__fixtures__/final_review_rejected.json";
import fixThenDone from "./__fixtures__/fix_then_done.json";
import { formatMs } from "./format";
import { codeRunNumber, isShortOutput, runResult, sourceLabel } from "./result";

type Recorded = { run: RunDetail; logs: LogEntry[] };
const fix = fixThenDone as unknown as Recorded;
const review = finalReview as unknown as Recorded;
const clone = <T,>(value: T): T => structuredClone(value);

describe("runResult", () => {
  it("shows the stdout of the successful code run the model confirmed", () => {
    const view = runResult(fix.run);
    expect(view.kind).toBe("final");
    expect(view.source?.number).toBe(2);
    expect(view.codeRun).toBe(2);
    expect(view.source?.stdout).toBe(fix.run.answer);
    expect(view.note).toContain("DONE in model call 3");
  });

  it("labels the latest successful output as partial when the run did not complete", () => {
    const view = runResult(review.run);
    expect(view.kind).toBe("partial");
    expect(view.codeRun).toBe(1);
    expect(view.note).toContain("not an answer the model confirmed");
  });

  it("never treats a run the output check overruled as the result", () => {
    const run = clone(fix.run);
    run.status = "max_retries";
    // Stored the way the backend stores it: exit code 1 with false_success set
    Object.assign(run.iterations[1], { exit_code: 1, false_success: true });
    run.iterations = run.iterations.slice(0, 2);
    const view = runResult(run);
    expect(view.kind).toBe("failed");
    expect(view.codeRun).toBe(2);
    expect(view.title).toBe("No successful output");
  });

  it("says so when no code finished, and stays empty while running", () => {
    expect(runResult({ ...clone(fix.run), status: "stopped", iterations: [] })).toMatchObject({ kind: "none", source: null });
    expect(runResult({ ...clone(fix.run), status: "running" }).kind).toBe("running");
  });

  it("names the code run, file, exit code and time of the output", () => {
    const view = runResult(fix.run);
    expect(sourceLabel(view, "stdout", formatMs)).toMatch(/^stdout of code run 2 · iter_02\.py · exit 0/);
  });

  it("counts code runs, not iterations", () => {
    expect(codeRunNumber(fix.run, 2)).toBe(2);
    expect(codeRunNumber(fix.run, 3)).toBeNull(); // the DONE call ran no code
  });

  it("shows short answers in full", () => {
    expect(isShortOutput("3.14159265358979323846264338327950288419716939937511\n")).toBe(true);
    expect(isShortOutput("")).toBe(false);
    expect(isShortOutput("x\n".repeat(10))).toBe(false);
  });
});
