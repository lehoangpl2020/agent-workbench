// The agent journey (journey.ts) on runs recorded from the backend (tests/contract/test_ui_fixtures.py).
import { describe, expect, it } from "vitest";
import type { LogEntry, RunDetail } from "./api";
import finalReview from "./__fixtures__/final_review_rejected.json";
import fixThenDone from "./__fixtures__/fix_then_done.json";
import {
  buildJourney, describeMessage, meaningfulOrder, neighbor, nextTransition, outcomeOf, recordedRequests,
  sectionIndex, sectionSummary,
} from "./journey";
import { buildSteps } from "./studio";

type Recorded = { run: RunDetail; logs: LogEntry[] };
const fix = fixThenDone as unknown as Recorded;
const review = finalReview as unknown as Recorded;
const clone = <T,>(value: T): T => structuredClone(value);

function journey(recorded: Recorded, logs = recorded.logs) {
  const { steps } = buildSteps(recorded.run, logs);
  return { steps, sections: buildJourney(recorded.run, steps) };
}

describe("buildJourney on a run that fails, is fixed, then is confirmed", () => {
  const { steps, sections } = journey(fix);

  it("separates model calls, code runs and runtime checks", () => {
    expect(sections.map(s => `${s.title} · ${s.purpose}`)).toEqual([
      "Run started · Prepare the loop",
      "Model call 1 · Generate code",
      "Code run 1 · Execute Python",
      "Runtime check · Decide the next step",
      "Model call 2 · Fix the error",
      "Code run 2 · Execute Python",
      "Runtime check · Decide the next step",
      "Model call 3 · Review the result",
      "Run finished · Completed",
    ]);
    expect(sections.map(s => s.actor)).toEqual(["runtime", "model", "sandbox", "runtime", "model", "sandbox", "runtime", "model", "runtime"]);
  });

  it("keeps every step exactly once, in order", () => {
    const all = sections.flatMap(s => s.steps.map(st => st.index)).sort((a, b) => a - b);
    expect(all).toEqual(steps.map(s => s.index));
    for (const s of sections) expect(s.main.length + s.technical.length).toBe(s.steps.length);
  });

  it("hides bookkeeping events but keeps the hand-offs visible", () => {
    const call1 = sections[1];
    expect(call1.technical.map(s => s.beat)).toEqual(["calling", "first_token", "response", "parsed"]);
    expect(call1.main.map(s => s.beat)).toEqual(["send", "accepted"]);
    expect(sections[2].main.map(s => s.beat)).toContain("handoff");
  });

  it("shows the feedback path: the error and the output are sent back as the first step of the next model call", () => {
    expect(sections[4].main[0]).toMatchObject({ beat: "send", intent: "fix", title: "Error sent back to the model" });
    expect(sections[7].main[0]).toMatchObject({ beat: "send", intent: "review", title: "Output sent back to the model" });
  });

  it("focuses each section on the step that carries its result", () => {
    expect(steps[sections[1].focus].beat).toBe("accepted");
    expect(steps[sections[2].focus].beat).toBe("exited");
    expect(steps[sections[3].focus].beat).toBe("result");
    expect(steps[sections[7].focus].beat).toBe("done_reply");
  });

  it("summarizes results only once they are recorded", () => {
    const last = steps.length - 1;
    expect(sectionSummary(sections[2], fix.run, last)).toMatchObject({ tone: "bad", text: expect.stringMatching(/^exit 1/) });
    expect(sectionSummary(sections[2], fix.run, sections[2].first)).toBeNull();
    expect(sectionSummary(sections[3], fix.run, last, sections)?.text).toBe("Failure → error to model");
    expect(sectionSummary(sections[6], fix.run, last, sections)?.text).toBe("Success → output to model");
    // Before the next model call is recorded, the check does not claim where the result goes
    expect(sectionSummary(sections[3], fix.run, sections[3].last, sections)?.text).toBe("Failure");
    expect(sectionSummary(sections[7], fix.run, last)?.text).toBe("Replied DONE");
  });

  it("explains each transition from what was recorded next", () => {
    const last = steps.length - 1;
    expect(nextTransition(sections[1], sections, fix.run, last)).toContain("hands it to the sandbox (Code run 1)");
    expect(nextTransition(sections[3], sections, fix.run, last)).toContain("error is sent back to the model (Model call 2)");
    expect(nextTransition(sections[6], sections, fix.run, last)).toContain("output is sent back to the model (Model call 3)");
    expect(nextTransition(sections[7], sections, fix.run, last)).toContain("replied DONE");
    // At an earlier step the next section has not happened yet
    expect(nextTransition(sections[3], sections, fix.run, sections[3].last)).not.toContain("Model call 2");
  });

  it("visits meaningful steps in order with prev/next", () => {
    const order = meaningfulOrder(sections);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(i => !["first_token", "parsed", "calling"].includes(steps[i].beat))).toBe(true);
    expect(neighbor(order, order[0], -1)).toBeNull();
    expect(neighbor(order, order[0], 1)).toBe(order[1]);
    expect(neighbor(order, order.at(-1)!, 1)).toBeNull();
    // From a technical step, prev/next go to the surrounding meaningful steps
    const tech = sections[1].technical[0].index;
    expect(neighbor(order, tech, -1)).toBe(sections[1].main[0].index);
    expect(neighbor(order, tech, 1)).toBe(sections[1].main[1].index);
  });

  it("maps every step to its section", () => {
    const map = sectionIndex(sections);
    expect(map.size).toBe(steps.length);
    expect(map.get(sections[4].focus)?.title).toBe("Model call 2");
  });
});

describe("the recorded model input", () => {
  const { sections } = journey(fix);

  it("is the exact system prompt and message list of each call", () => {
    const [first] = recordedRequests(sections[1]);
    expect(first.system).toContain("You are a code execution agent");
    expect(first.messages).toEqual([{ role: "user", content: "demo" }]);
    const [fixCall] = recordedRequests(sections[4]);
    expect(fixCall.messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    // (The fixture stabilizer shortens text that contains a traceback, so the failure message is checked directly.)
    expect(describeMessage({ role: "user", content: "❌ Execution FAILED (attempt 1/4)." }, 2)).toBe("Execution feedback: failure");
    expect(describeMessage({ role: "user", content: "⏱ Execution TIMED OUT" }, 2)).toBe("Execution feedback: timeout");
    expect(describeMessage(fixCall.messages[1], 1)).toBe("An earlier reply from the model");
    const [reviewCall] = recordedRequests(sections[7]);
    expect(describeMessage(reviewCall.messages.at(-1)!, reviewCall.messages.length - 1)).toBe("Execution feedback: success");
  });

  it("is reported as not recorded for runs stored before the request was logged", () => {
    const logs = fix.logs.map(l => {
      const data = { ...l.data };
      delete data.request;
      return { ...l, data };
    });
    expect(recordedRequests(journey(fix, logs).sections[1])).toEqual([]);
  });
});

describe("a run whose final review asked for another step", () => {
  const { steps, sections } = journey(review);
  const last = steps.length - 1;

  it("labels the extra model call as a final review and does not run its code", () => {
    const call2 = sections.find(s => s.title === "Model call 2")!;
    expect(call2.finalReview).toBe(true);
    expect(call2.purpose).toBe("Final review (no code runs left)");
    expect(sections.filter(s => s.kind === "code")).toHaveLength(1);
    expect(sectionSummary(call2, review.run, last)?.text).toBe("Wanted another step · not executed");
    expect(nextTransition(call2, sections, review.run, last)).toContain("does not execute this code");
    // Choosing the section shows the model's reply, not the runtime's limit message logged after it
    expect(steps[call2.focus]).toMatchObject({ beat: "note", actor: "model", title: "Two" });
  });

  it("keeps the partial result and separates the three facts", () => {
    const o = outcomeOf(review.run);
    expect(o.execution).toMatchObject({ value: "Code run 1: exit 0", tone: "ok" });
    expect(o.signal).toMatchObject({ value: "No DONE", tone: "warn" });
    expect(o.validation.value).toBe("Not performed");
    expect(o.partial).toBe(true);
  });
});

describe("outcomeOf", () => {
  it("never treats exit code 0 or DONE as task validation", () => {
    const o = outcomeOf(fix.run);
    expect(o.execution.value).toBe("Code run 2: exit 0");
    expect(o.signal.value).toBe("DONE in model call 3");
    expect(o.validation).toMatchObject({ value: "Not performed", tone: "muted" });
    expect(o.partial).toBe(false);
  });

  it("names a timeout and the output check separately from a plain failure", () => {
    const run = clone(fix.run);
    run.status = "timeout";
    Object.assign(run.iterations[1], { exit_code: 124, timed_out: true });
    run.iterations = run.iterations.slice(0, 2);
    expect(outcomeOf(run).execution).toMatchObject({ value: "Code run 2 timed out", tone: "warn" });
    Object.assign(run.iterations[1], { exit_code: 1, timed_out: false, false_success: true });
    expect(outcomeOf(run).execution.value).toBe("Code run 2: exit 0, treated as failed");
  });

  it("says so when no code ran", () => {
    const run = { ...clone(fix.run), status: "stopped" as const, iterations: [] };
    expect(outcomeOf(run).execution.value).toBe("No code finished running");
  });
});

describe("older runs without detailed logs", () => {
  it("still form a journey from the stored iterations", () => {
    const { sections } = journey(fix, []);
    expect(sections[0].title).toBe("Run started");
    expect(sections.at(-1)?.kind).toBe("end");
    expect(sections.some(s => s.kind === "code")).toBe(true);
    expect(sections.flatMap(s => s.steps).every(s => s.synthetic)).toBe(true);
  });
});
