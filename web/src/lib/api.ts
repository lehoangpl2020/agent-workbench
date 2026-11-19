// Typed client for the FastAPI backend. There are no secrets in the frontend.

export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "timeout"
  | "max_retries"
  | "stopped";

export type IterationStatus =
  | "planning"
  | "executing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "done"
  | RunStatus;

export interface IterationArtifact {
  path: string;
  size: number;
  mime: string;
  url: string;
  snapshot_available?: boolean;
}

export type Intent = "write" | "fix" | "review";

export interface Iteration {
  number: number;
  status: IterationStatus;
  /** What the model is called for: write new code / fix an error / review the result and decide on DONE */
  intent: Intent;
  /** For intent "fix": the error being fixed */
  intent_detail: string;
  explanation: string;
  language: string;
  code: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  execution_time_ms: number | null;
  timed_out: boolean;
  false_success: boolean;
  artifacts: IterationArtifact[];
  started_at: string;
  finished_at: string | null;
}

export interface RunArtifact {
  path: string;
  size: number;
  mime: string;
  iteration: number | null;
  url: string;
  download_url: string;
}

export interface RunSummary {
  id: string;
  prompt: string;
  status: RunStatus;
  max_iterations: number;
  timeout_seconds: number;
  message: string;
  iteration_count: number;
  /** The provider/model actually used. Old runs (before multi-provider support) have provider = null. */
  provider: string | null;
  model: string;
  /** Display name looked up from the backend catalog; null if the model is no longer in the catalog */
  provider_name: string | null;
  model_name: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RunDetail extends RunSummary {
  answer: string;
  /** Current action (real time, from backend events) */
  activity: string;
  activity_phase: string;
  activity_iteration: number | null;
  activity_at: string | null;
  executor: string;
  iterations: Iteration[];
  artifacts: RunArtifact[];
  active: boolean;
}

/** One activity-log line (stored in SQLite, pushed in real time via the SSE "log" event) */
export interface LogEntry {
  id: number;
  ts: string;
  iteration: number | null;
  /** runtime = agent loop · llm = model call · model = the model's explanation · sandbox = executor */
  source: "runtime" | "llm" | "model" | "sandbox" | string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  data: Record<string, unknown>;
}

export interface AppConfig {
  defaults: { max_iterations: number; timeout_seconds: number; provider: string; model: string };
  limits: { max_iterations: [number, number]; timeout_seconds: [number, number] };
  executor: string;
  /** false = local executor: model-generated code runs directly on the server machine (no isolation). */
  sandboxed?: boolean;
  model: string;
  llm_configured: boolean;
  active_run_id: string | null;
}

/** One model in the backend catalog (model_catalog.py) + readiness status */
export interface CatalogModel {
  id: string;
  name: string;
  provider_default: boolean;
  note: string;
  ready: boolean;
  status: string;
  message: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  local: boolean;
  configured: boolean;
  ready: boolean;
  /** configured | not_configured | reachable | connection | ... */
  status: string;
  message: string;
  base_url?: string;
  models: CatalogModel[];
}

export interface ProvidersResponse {
  default: { provider: string; model: string };
  providers: CatalogProvider[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is the backend running?", 0);
  }
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* the body is not JSON */
    }
    throw new ApiError(errorMessage(detail) ?? `Request failed (${res.status})`, res.status, detail);
  }
  return res.json() as Promise<T>;
}

function errorMessage(detail: unknown): string | undefined {
  if (!detail) return undefined;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // FastAPI 422 validation errors
    return detail.map((d) => `${(d.loc ?? []).slice(-1)[0] ?? "field"}: ${d.msg}`).join("; ");
  }
  if (typeof detail === "object" && "message" in detail) return String(detail.message);
  return undefined;
}

export const api = {
  config: () => request<AppConfig>("/api/config"),
  listRuns: () => request<{ runs: RunSummary[]; active_run_id: string | null }>("/api/runs"),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  providers: () => request<ProvidersResponse>("/api/providers"),
  createRun: (body: { message: string; max_iterations: number; timeout_seconds: number; provider: string; model: string }) =>
    request<RunDetail>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  stopRun: (id: string) => request<RunDetail>(`/api/runs/${id}/stop`, { method: "POST" }),
  eventsUrl: (id: string) => `/api/runs/${id}/events`,
  logs: (id: string, after = 0) => request<{ logs: LogEntry[] }>(`/api/runs/${id}/logs?after=${after}`),
  logsDownloadUrl: (id: string, iteration?: number | null) =>
    `/api/runs/${id}/logs/download${iteration ? `?iteration=${iteration}` : ""}`,
};

// SSE events emitted by the backend (see agent.py / server.py)
export const SSE_EVENTS = [
  "session",
  "status",
  "iteration",
  "code",
  "result",
  "model_done",
  "activity",
  "code_progress",
  "log",
  "error",
  "done",
] as const;
