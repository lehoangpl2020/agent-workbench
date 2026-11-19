import { describe, expect, it } from "vitest";
import type { RunDetail, RunMetrics } from "./api";
import finalReview from "./__fixtures__/final_review_rejected.json";
import { callsNote, costLabel, formatMoney, formatTokens, modelTimeShare, NO_DATA, NOT_REPORTED, tokensLabel } from "./usage";

type Llm = NonNullable<RunMetrics["llm"]>;
const llm = (over: Partial<Llm> = {}): Llm => ({
  calls: 2, failed_calls: 0, format_retries: 0, calls_with_usage: 2, usage_complete: true, duration_ms: 3000,
  first_token_ms_avg: 500, first_token_ms_max: 700, input_tokens: 2700, output_tokens: 85,
  cache_read_input_tokens: null, cache_creation_input_tokens: null, reasoning_tokens: null, ...over,
});

describe("missing data never reads as zero", () => {
  it("shows No data / Not reported instead of 0", () => {
    expect(formatTokens(null)).toBe(NO_DATA);
    expect(tokensLabel(null)).toBe(NO_DATA);
    expect(tokensLabel(llm({ calls_with_usage: 0, input_tokens: null, output_tokens: null }))).toBe(NOT_REPORTED);
    expect(costLabel({ status: "no_data" }).value).toBe(NO_DATA);
    expect(costLabel({ status: "no_usage" }).value).toBe(NOT_REPORTED);
    expect(modelTimeShare(null, 500)).toBeNull();
    expect(modelTimeShare(500, null)).toBeNull();
  });

  it("keeps a real 0 as a number", () => {
    expect(formatTokens(0)).toBe("0");
    expect(tokensLabel(llm({ input_tokens: 0, output_tokens: 0 }))).toBe("0 / 0");
  });
});

describe("cost", () => {
  it("is an estimate when complete and a lower bound when some usage is missing", () => {
    expect(costLabel({ status: "ok", amount: 0.009375, currency: "USD", pricing_key: "a/b" }).value).toBe("≈ $0.0094");
    expect(costLabel({ status: "partial", amount: 0.5, currency: "USD", pricing_key: "a/b" }).value).toBe("≥ $0.500");
  });

  it("names the missing price instead of showing $0", () => {
    const c = costLabel({ status: "no_pricing", pricing_key: "ollama/qwen3.5:4b" });
    expect(c.value).toBe("No price set");
    expect(c.known).toBe(false);
    expect(c.hint).toContain("ollama/qwen3.5:4b");
  });

  it("formats money by size", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(0.00042)).toBe("$0.0004");
    expect(formatMoney(1.5)).toBe("$1.500");
    expect(formatMoney(2, "EUR")).toBe("EUR 2.000");
  });
});

describe("small helpers", () => {
  it("splits the measured time between the model and the sandbox", () => {
    expect(modelTimeShare(3000, 1000)).toBe(75);
    expect(modelTimeShare(0, 0)).toBeNull();
  });

  it("notes retries and failures only when there are some", () => {
    expect(callsNote(llm())).toBeUndefined();
    expect(callsNote(llm({ format_retries: 1, failed_calls: 2 }))).toBe("1 format retry · 2 failed");
    expect(callsNote(llm({ format_retries: 3 }))).toBe("3 format retries");
  });
});

describe("a run recorded from the backend", () => {
  // The scripted model reports no usage, so tokens and cost are "not reported", while the time is measured.
  const { summary } = (finalReview as unknown as { run: RunDetail }).run;

  it("has timing but no tokens", () => {
    expect(summary.llm?.calls).toBe(2);
    expect(tokensLabel(summary.llm)).toBe(NOT_REPORTED);
    expect(costLabel(summary.cost).value).toBe(NOT_REPORTED);
    expect(summary.llm?.duration_ms).not.toBeNull();
  });
});
