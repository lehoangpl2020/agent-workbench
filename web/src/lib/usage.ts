// What the "Usage & cost" card shows, as pure functions so it can be unit-tested. The totals come from the backend
// (runs/metrics.py). A missing value is null there, and it must read as "No data" here, never as 0.
import type { RunMetrics } from "./api";

export const NO_DATA = "No data";
export const NOT_REPORTED = "Not reported";

type Llm = NonNullable<RunMetrics["llm"]>;

export function formatTokens(n: number | null | undefined): string {
  return n == null ? NO_DATA : n.toLocaleString("en-US");
}

export function formatMoney(amount: number, currency = "USD"): string {
  // Small amounts need more digits to be readable; an exact 0 is a real price of 0 (a free local model)
  const digits = amount === 0 ? 2 : amount < 0.01 ? 4 : 3;
  return `${currency === "USD" ? "$" : `${currency} `}${amount.toFixed(digits)}`;
}

/** Tokens in / out, or why there is none: the provider reported nothing, or the run has no measured call. */
export function tokensLabel(llm: Llm | null): string {
  if (!llm) return NO_DATA;
  if (llm.calls_with_usage === 0) return NOT_REPORTED;
  return `${formatTokens(llm.input_tokens)} / ${formatTokens(llm.output_tokens)}`;
}

/** The estimated cost. Without a price or usage it says why, and never shows $0. */
export function costLabel(cost: RunMetrics["cost"]): { value: string; hint: string; known: boolean } {
  switch (cost.status) {
    case "ok":
      return { value: `≈ ${formatMoney(cost.amount ?? 0, cost.currency)}`, known: true,
        hint: `Estimate: tokens the provider reported × your MODEL_PRICING for ${cost.pricing_key}. Not a bill.` };
    case "partial":
      return { value: `≥ ${formatMoney(cost.amount ?? 0, cost.currency)}`, known: true,
        hint: "At least one model call reported no usage (it failed, or the provider left it out), so this is a lower bound." };
    case "no_pricing":
      return { value: "No price set", known: false,
        hint: `Add "${cost.pricing_key ?? "provider/model"}" to MODEL_PRICING (USD per 1M tokens) to estimate the cost.` };
    case "no_usage":
      return { value: NOT_REPORTED, known: false, hint: "The provider returned no token usage for this run, so the cost cannot be estimated." };
    default:
      return { value: NO_DATA, known: false, hint: "No measured model call for this run." };
  }
}

/** Share of the measured time spent in the model, in percent (the rest is the sandbox). null if either is unknown. */
export function modelTimeShare(modelMs: number | null | undefined, sandboxMs: number | null | undefined): number | null {
  if (modelMs == null || sandboxMs == null || modelMs + sandboxMs <= 0) return null;
  return Math.round((modelMs / (modelMs + sandboxMs)) * 100);
}

/** The small print under "Model calls": retries and failures, if any. */
export function callsNote(llm: Llm | null): string | undefined {
  if (!llm) return undefined;
  const parts = [
    llm.format_retries ? `${llm.format_retries} format retr${llm.format_retries === 1 ? "y" : "ies"}` : "",
    llm.failed_calls ? `${llm.failed_calls} failed` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
