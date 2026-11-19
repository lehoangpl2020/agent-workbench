import { useCallback, useEffect, useRef, useState } from "react";
import { api, SSE_EVENTS, type LogEntry, type RunDetail } from "@/lib/api";

/** RunView is keyed by runId. All tabs share this snapshot, log and SSE connection. */
export function useRun(runId: string, onFinished: () => void) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [logError, setLogError] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const revision = useRef(0);
  const cursor = useRef(0);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const refetch = useCallback(async () => {
    const version = ++revision.current;
    try {
      const detail = await api.getRun(runId);
      if (version === revision.current) {
        setRun(detail);
        setError(null);
      }
      return true;
    } catch (e) {
      if (version === revision.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [runId]);

  const mergeLogs = useCallback((entries: LogEntry[]) => {
    if (!entries.length) return;
    setLogs(previous => {
      const byId = new Map(previous.map(entry => [entry.id, entry]));
      for (const entry of entries) byId.set(entry.id, entry);
      return [...byId.values()].sort((a, b) => a.id - b.id);
    });
  }, []);

  const catchUp = useCallback(async () => {
    // Only a successful range read advances this cursor. SSE can arrive before a backfill.
    let after = cursor.current;
    try {
      for (;;) {
        const { logs: page } = await api.logs(runId, after);
        mergeLogs(page);
        after = page.at(-1)?.id ?? after;
        cursor.current = Math.max(cursor.current, after);
        if (page.length < 5000) break;
      }
      setLogError(false);
    } catch {
      setLogError(true);
    } finally {
      setHistoryLoaded(true);
    }
  }, [runId, mergeLogs]);

  useEffect(() => {
    void refetch();
    void catchUp();
    return () => { revision.current++; };
  }, [refetch, catchUp]);

  const status = run?.status;
  const previousStatus = useRef(status);
  useEffect(() => {
    if (status && status !== "running" && status !== "pending" &&
        (previousStatus.current === "running" || previousStatus.current === "pending")) {
      void catchUp();
      finished.current();
    }
    previousStatus.current = status;
  }, [status, catchUp]);

  useEffect(() => {
    if (status !== "running" && status !== "pending") return;
    const es = new EventSource(api.eventsUrl(runId));
    let timer: number | undefined;
    let retry: number | undefined;
    const schedule = () => {
      timer ??= window.setTimeout(() => {
        timer = undefined;
        void refetch();
      }, 120);
    };
    es.onopen = async () => {
      void catchUp();
      if (await refetch() && es.readyState === EventSource.OPEN) setConnected(true);
    };
    es.onerror = (event) => {
      if (event instanceof MessageEvent) return; // application error precedes done
      setConnected(false);
      setError("Waiting for the event stream to reconnect.");
      // Native retries handle dropped streams. HTTP errors can close EventSource permanently.
      if (es.readyState === EventSource.CLOSED) {
        retry = window.setTimeout(() => {
          void refetch();
          setConnectionAttempt(value => value + 1);
        }, 2000);
      }
    };
    for (const name of SSE_EVENTS) {
      es.addEventListener(name, (event) => {
        if (!(event instanceof MessageEvent)) return;
        if (name === "log") {
          const entry: LogEntry = JSON.parse(event.data);
          mergeLogs([entry]);
        } else if (name === "done") {
          es.close();
          setConnected(false);
          window.clearTimeout(timer);
          // Apply terminal status immediately, then read complete iteration rows and missing logs.
          const { status, answer, message } = JSON.parse(event.data);
          setRun(previous => previous && { ...previous, status, answer, message, activity: "", activity_phase: "finished" });
          void refetch();
        } else {
          if (name === "activity") {
            const { phase, text, iteration, at } = JSON.parse(event.data);
            revision.current++;
            setRun(previous => previous && { ...previous, activity_phase: phase, activity: text,
              activity_iteration: iteration, activity_at: at ?? previous.activity_at });
          }
          schedule();
        }
      });
    }
    return () => {
      es.close();
      window.clearTimeout(timer);
      window.clearTimeout(retry);
    };
  }, [runId, status, connectionAttempt, refetch, mergeLogs, catchUp]);

  return { run, logs, connected, error, logError, historyLoaded, refetch, retryLogs: catchUp };
}
