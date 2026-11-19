import { useCallback, useEffect, useRef, useState } from "react";
import { replayGap, type StudioStep } from "@/lib/studio";

/**
 * Replay playback over recorded steps. It only moves a cursor through data that is already loaded:
 * it never calls the backend, a model or the sandbox. `active` is false while the Live view is shown.
 * Waits are the recorded gaps, clamped by `replayGap`; Pause keeps the time left on the current step.
 */
export function useReplayClock(steps: StudioStep[], active: boolean) {
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [animatedKey, setAnimatedKey] = useState<string | null>(null);
  const remaining = useRef<{ key: string; ms: number } | null>(null);
  const last = steps.length - 1;

  useEffect(() => {
    if (!active || !playing) return;
    const current = steps[cursor];
    const next = steps[cursor + 1];
    if (!current || !next) { setPlaying(false); return; }
    const full = replayGap(current, next) / speed;
    const ms = remaining.current?.key === current.key ? remaining.current.ms : full;
    const started = performance.now();
    const t = window.setTimeout(() => {
      remaining.current = null;
      setAnimatedKey(next.key);
      setCursor(cursor + 1);
    }, ms);
    return () => {
      window.clearTimeout(t);
      remaining.current = { key: current.key, ms: Math.max(0, ms - (performance.now() - started)) };
    };
  }, [active, playing, cursor, speed, steps]);

  /** Jump to a step and pause. */
  const seek = useCallback((i: number) => {
    remaining.current = null;
    setAnimatedKey(null);
    setPlaying(false);
    setCursor(Math.max(0, Math.min(last, i)));
  }, [last]);

  /** Play from the first step (used when entering Replay and by "Restart"). */
  const restart = useCallback(() => {
    seek(0);
    setAnimatedKey(steps[0]?.key ?? null);
    setPlaying(steps.length > 1);
  }, [seek, steps]);

  const pause = useCallback(() => setPlaying(false), []);

  const toggle = useCallback(() => {
    if (playing) return setPlaying(false);
    if (cursor >= last) { seek(0); setAnimatedKey(steps[0]?.key ?? null); }
    setPlaying(true);
  }, [playing, cursor, last, seek, steps]);

  return { cursor, playing, speed, setSpeed, animatedKey, seek, restart, pause, toggle };
}
