import type { IterationStatus, RunStatus } from "./api";

export type Tone = "running" | "success" | "danger" | "warning" | "neutral";

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "neutral" },
  running: { label: "Running", tone: "running" },
  success: { label: "Completed", tone: "success" },
  error: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
  timeout: { label: "Timed out", tone: "warning" },
  max_retries: { label: "Code run limit reached", tone: "warning" },
};

export const ITERATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  planning: { label: "Generating code", tone: "running" },
  executing: { label: "Executing", tone: "running" },
  succeeded: { label: "Ran successfully", tone: "success" },
  failed: { label: "Execution error", tone: "danger" },
  timed_out: { label: "Timed out", tone: "warning" },
  done: { label: "Model confirmed DONE", tone: "success" },
  stopped: { label: "Stopped", tone: "neutral" },
  error: { label: "Failed", tone: "danger" },
};

export function iterationStatus(s: IterationStatus) {
  return ITERATION_STATUS[s] ?? RUN_STATUS[s as RunStatus] ?? { label: s, tone: "neutral" as Tone };
}

export const TONE_CLASSES: Record<Tone, string> = {
  running: "bg-accent text-accent-foreground border-primary/20",
  success: "bg-success-soft text-success border-success/20",
  danger: "bg-danger-soft text-destructive border-destructive/20",
  warning: "bg-warning-soft text-warning border-warning/25",
  neutral: "bg-muted text-muted-foreground border-border",
};

export const TONE_DOT: Record<Tone, string> = {
  running: "bg-primary",
  success: "bg-success",
  danger: "bg-destructive",
  warning: "bg-warning",
  neutral: "bg-muted-foreground/60",
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function isImage(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(mime);
}

/** Tên model của một run: tên trong catalog, hoặc model ID đã lưu (không đoán). */
export function modelLabel(run: { model: string; model_name: string | null }): string {
  return run.model_name ?? (run.model || "—");
}

/** Provider của một run. Run cũ không ghi provider → nói rõ, không gán default. */
export function providerLabel(run: { provider: string | null; provider_name: string | null }): string {
  return run.provider_name ?? run.provider ?? "provider not recorded";
}
