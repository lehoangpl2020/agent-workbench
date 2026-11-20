// The agent journey (journey.ts) on runs recorded from the backend (tests/contract/test_ui_fixtures.py).
import { describe, expect, it } from "vitest";
import type { LogEntry, RunDetail } from "./api";
import finalReview from "./__fixtures__/final_review_rejected.json";
import fixThenDone from "./__fixtures__/fix_then_done.json";
import {
  buildJourney, checkDecision, describeMessage, executorKind, feedbackTarget, lastErrorLine, meaningfulOrder, modelOutcome, neighbor,
  neighborSection, nextTransition, outcomeOf, previousCode, recordedRequests, sectionIndex, sectionSummary, sectionTarget,
  sectionTransferStep, stepAccount, turnChecklist,
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
    expect(sectionSummary(call2, review.run, last)?.text).toBe("Returned code · not executed");
    expect(modelOutcome(call2, review.run, last)?.kind).toBe("not_executed");
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

describe("navigating by journey step", () => {
  const { steps, sections } = journey(fix);
  const last = steps.length - 1;

  it("moves Prev/Next between steps, not between recorded events", () => {
    expect(sections.length).toBeLessThan(steps.length);
    expect(neighborSection(sections, sections[1], 1, last)).toBe(sections[2]);
    expect(neighborSection(sections, sections[0], -1, last)).toBeNull();
    expect(neighborSection(sections, sections.at(-1), 1, last)).toBeNull();
    // Steps not reached yet (replay, live) are not visited
    expect(neighborSection(sections, sections[1], 1, sections[1].last)).toBeNull();
  });

  it("selects a step's result-carrying event, or its latest event so far", () => {
    expect(sectionTarget(sections[2], last)).toBe(sections[2].focus);
    expect(sectionTarget(sections[2], sections[2].first)).toBe(sections[2].first);
  });

  it("shows the step's hand-off in the diagram", () => {
    expect(sectionTransferStep(sections[2], last)?.beat).toBe("handoff");
    expect(sectionTransferStep(sections[3], last)?.beat).toBe("checking");
    expect(sectionTransferStep(sections[7], last)?.beat).toBe("done_reply");
  });

  it("names the branch of the runtime's rule that applied", () => {
    expect(checkDecision(fix.run, 1)).toMatch(/^Exit code 1 → the error goes back to the model/);
    expect(checkDecision(fix.run, 2)).toMatch(/^Exit code 0 → the output goes back to the model/);
    expect(checkDecision(fix.run, 3)).toBeNull(); // no code ran in the DONE call
    const run = clone(fix.run);
    run.max_iterations = 2;
    expect(checkDecision(run, 2)).toContain("final review call");
  });
});

describe("the loop checklist of one turn", () => {
  const { steps, sections } = journey(fix);
  const last = steps.length - 1;
  const states = (n: number, upto = last) => Object.fromEntries(turnChecklist(fix.run, steps, n, upto).map(i => [i.key, `${i.state}${i.note ? `:${i.note}` : ""}`]));

  it("marks sandbox and check as not applicable after DONE, never as pending", () => {
    expect(states(3)).toEqual({ send: "done", model: "done:DONE", run: "na:not needed: DONE", check: "na:not needed: DONE" });
  });

  it("shows a failed code run as failed and the check as done", () => {
    expect(states(1)).toMatchObject({ model: "done:iter_01.py", run: "failed:exit 1", check: "done:failure" });
    expect(states(2)).toMatchObject({ run: "done:exit 0", check: "done:success" });
  });

  it("shows later parts as upcoming at an earlier event, not as missing", () => {
    const call1 = sections[1];
    expect(states(1, call1.main[0].index)).toMatchObject({ send: "done", model: "next:next", run: "upcoming", check: "upcoming" });
    // Exploring history never shows a part as happening now: after the code is accepted, the run is "next"
    expect(states(1, call1.focus)).toMatchObject({ model: "done:iter_01.py", run: "next:next" });
    // Once the call is recorded as started, the model part is under way at that point (still not "now")
    const calling = call1.steps.find(s => s.beat === "calling")!.index;
    expect(states(1, calling).model).toBe("underway:under way at this point");
    expect(nextTransition(call1, sections, fix.run, calling, last)).toMatch(/^Not reached yet at this event/);
  });

  it("does not ask for code to run in a final review", () => {
    const { steps: rs } = journey(review);
    const items = turnChecklist(review.run, rs, 2, rs.length - 1);
    expect(items.find(i => i.key === "run")).toMatchObject({ state: "na", note: "not run: no code runs left" });
  });

  it("says a call cut off by Stop was interrupted, not that it is still to come", () => {
    const cut = fix.logs.findIndex(l => l.iteration === 1 && l.data.flow === "calling");
    const logs = [...fix.logs.slice(0, cut + 1),
      { ...fix.logs[cut], id: 9001, message: "Stop requested by the user", data: { flow: "stop" } },
      { ...fix.logs[cut], id: 9002, message: "Run finished: stopped", data: { flow: "finished" } }];
    const run = { ...clone(fix.run), status: "stopped" as const, iterations: fix.run.iterations.slice(0, 1).map(i => ({ ...i, exit_code: null, code: "" })) };
    const { steps: ss } = buildSteps(run, logs);
    const items = turnChecklist(run, ss, 1, ss.length - 1);
    expect(items.map(i => `${i.key}:${i.state}:${i.note ?? ""}`)).toEqual([
      "send:done:", "model:unknown:interrupted by Stop", "run:unknown:not reached", "check:unknown:not reached",
    ]);
  });
});

describe("the observed outcome of a model call", () => {
  const { steps, sections } = journey(fix);
  const last = steps.length - 1;

  it("names what came back, not the purpose of the call", () => {
    expect(modelOutcome(sections[1], fix.run, last)).toMatchObject({ kind: "code", text: "Returned code" });
    expect(modelOutcome(sections[4], fix.run, last)).toMatchObject({ kind: "code", text: "Returned code" });
    expect(modelOutcome(sections[7], fix.run, last)).toMatchObject({ kind: "done", text: "Replied DONE" });
    expect(sectionSummary(sections[1], fix.run, last)?.text).toBe("Returned code · iter_01.py");
    // Not answered yet at the call's first event
    expect(modelOutcome(sections[1], fix.run, sections[1].first)).toBeNull();
  });

  it("says a review call returned more code when it did", () => {
    const logs = fix.logs.map(l => l.iteration === 3 && l.data.flow === "done_reply"
      ? { ...l, message: "Check again", data: { ...l.data, flow: "code" } } : l);
    const run = clone(fix.run);
    Object.assign(run.iterations[2], { code: "print(1)", status: "succeeded" });
    const { steps: ss } = buildSteps(run, logs);
    const secs = buildJourney(run, ss);
    expect(secs[7].purpose).toBe("Review the result");
    expect(modelOutcome(secs[7], run, ss.length - 1)).toMatchObject({ kind: "code", text: "Returned more code" });
  });

  it("does not claim a reply for a call cut off without a response", () => {
    const cut = fix.logs.findIndex(l => l.iteration === 1 && l.data.flow === "calling");
    const logs = [...fix.logs.slice(0, cut + 1),
      { ...fix.logs[cut], id: 9001, message: "Stop requested by the user", data: { flow: "stop" } },
      { ...fix.logs[cut], id: 9002, message: "Run finished: stopped", data: { flow: "finished" } }];
    const run = { ...clone(fix.run), status: "stopped" as const, iterations: fix.run.iterations.slice(0, 1).map(i => ({ ...i, exit_code: null, code: "" })) };
    const { steps: ss } = buildSteps(run, logs);
    const secs = buildJourney(run, ss);
    expect(modelOutcome(secs[1], run, ss.length - 1)).toMatchObject({ kind: "none", text: "No response recorded" });
    // Reasoning that streamed before Stop is not a reply
    const withReasoning = [...logs.slice(0, -2), { ...fix.logs[cut], id: 9000, message: "Model is reasoning", data: { flow: "reasoning" } }, ...logs.slice(-2)];
    const reasoned = { ...run, reasoning: true, iterations: run.iterations.map(i => ({ ...i, reasoning: "partial thought" })) };
    const { steps: rs } = buildSteps(reasoned, withReasoning);
    const rsecs = buildJourney(reasoned, rs);
    expect(modelOutcome(rsecs[1], reasoned, rs.length - 1)?.kind).toBe("none");
    expect(stepAccount(rsecs[1], rsecs, reasoned, rs.length - 1).find(r => r.key === "output")?.detail).toBe("The call was interrupted by Stop.");
  });
});

describe("the account of one step in this run", () => {
  const { steps, sections } = journey(fix);
  const last = steps.length - 1;
  const rows = (k: number, upto = last) => Object.fromEntries(stepAccount(sections[k], sections, fix.run, upto).map(r => [r.key, r]));

  it("tells who acted, what came in, what came out and what the record shows next", () => {
    const call1 = rows(1);
    expect(call1.who.text).toBe("Model · Qwen 3.5 4B");
    expect(call1.input.text).toBe("System instructions and 1 message");
    expect(call1.output).toMatchObject({ text: "Returned code", detail: "iter_01.py · 1 line" });
    expect(call1.next).toMatchObject({ goto: { key: sections[2].key, label: "Code run 1" } });
    expect(call1.next.text).toContain("the runtime decides whether it runs");
  });

  it("names the recorded next step once the selected step is complete, but not before", () => {
    const call1 = sections[1];
    const whole = Object.fromEntries(stepAccount(call1, sections, fix.run, call1.last, last).map(r => [r.key, r]));
    expect(whole.next.goto?.label).toBe("Code run 1");
    const early = Object.fromEntries(stepAccount(call1, sections, fix.run, call1.first, last).map(r => [r.key, r]));
    expect(early.next.goto).toBeUndefined();
    expect(early.output.text).toBe("Not returned yet at this event");
  });

  it("surfaces the recorded error of a failed code run and where it went", () => {
    const run1 = rows(2);
    expect(run1.who.text).toBe("Sandbox · local");
    expect(run1.output).toMatchObject({ tone: "bad", detail: "Last line of stderr: NameError: name 'undefined_name' is not defined" });
    expect(feedbackTarget(sections[2], sections, last)?.title).toBe("Model call 2");
    // Before the next model call is recorded, it is not named
    expect(feedbackTarget(sections[2], sections, sections[3].last)).toBeNull();
  });

  it("connects the feedback in a model's input to the code run it came from", () => {
    expect(rows(7).input.detail).toBe("Newest: Execution feedback: success (from Code run 2)");
    expect(rows(7).output).toMatchObject({ text: "DONE, with no code", tone: "ok" });
    expect(rows(7).next.text).toContain("ended the run as Completed");
  });

  it("says when the model input was not recorded", () => {
    const logs = fix.logs.map(l => { const data = { ...l.data }; delete data.request; return { ...l, data }; });
    const { steps: ss, sections: secs } = journey(fix, logs);
    const input = stepAccount(secs[1], secs, fix.run, ss.length - 1).find(r => r.key === "input");
    expect(input).toMatchObject({ text: "Not recorded", tone: "muted" });
  });

  it("ends with the outcome and no next step", () => {
    const end = stepAccount(sections.at(-1)!, sections, fix.run, last);
    expect(end.map(r => r.key)).toEqual(["who", "input", "output"]);
    expect(end[1].text).toBe("Model call 3: Replied DONE");
  });

  it("keeps helpers literal", () => {
    expect(lastErrorLine("Traceback...\n  File x\nValueError: bad\n\n")).toBe("ValueError: bad");
    expect(lastErrorLine("")).toBeNull();
    expect(executorKind("docker-persistent (agent-workbench-sandbox)")).toBe("docker-persistent");
    expect(previousCode(fix.run, 2)?.number).toBe(1);
    expect(previousCode(fix.run, 1)).toBeNull();
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
