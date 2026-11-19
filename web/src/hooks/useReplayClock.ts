import { useCallback, useEffect, useRef, useState } from "react";
import { replayGap, type StudioStep } from "@/lib/studio";

/**
 * Replay playback over recorded steps. It only moves the shared selection through data that is already loaded:
 * it never calls the backend, a model or the sandbox. `order` lists the step indices playback visits (the meaningful
 * ones); waits are the recorded gaps, clamped by `replayGap`. Pause keeps the time left on the current step.
 */
export function useReplayClock({ steps, order, index, onStep, active }: {
  steps: StudioStep[];
  order: number[];
  index: number;
  onStep: (index: number) => void;
  active: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [animatedKey, setAnimatedKey] = useState<string | null>(null);
  const remaining = useRef<{ key: string; ms: number } | null>(null);
  const step = useRef(onStep);
  step.current = onStep;

  useEffect(() => {
    if (!active || !playing) return;
    const current = steps[index];
    const nextIndex = order.find(i => i > index);
    const next = nextIndex != null ? steps[nextIndex] : undefined;
    if (!current || !next || nextIndex == null) { setPlaying(false); return; }
    const full = replayGap(current, next) / speed;
    const ms = remaining.current?.key === current.key ? remaining.current.ms : full;
    const started = performance.now();
    const t = window.setTimeout(() => {
      remaining.current = null;
      setAnimatedKey(next.key);
      step.current(nextIndex);
    }, ms);
    return () => {
      window.clearTimeout(t);
      remaining.current = { key: current.key, ms: Math.max(0, ms - (performance.now() - started)) };
    };
  }, [active, playing, index, speed, steps, order]);

  useEffect(() => { if (!active) setPlaying(false); }, [active]);

  /** Stop playback (a manual jump also calls this). */
  const pause = useCallback(() => {
    remaining.current = null;
    setPlaying(false);
    setAnimatedKey(null);
  }, []);

  /** Play from the first step. */
  const restart = useCallback(() => {
    remaining.current = null;
    const first = order[0] ?? 0;
    step.current(first);
    setAnimatedKey(steps[first]?.key ?? null);
    setPlaying(order.length > 1);
  }, [order, steps]);

  const atEnd = order.length === 0 || index >= (order.at(-1) ?? 0);
  const toggle = useCallback(() => {
    if (playing) return setPlaying(false);
    if (atEnd) return restart();
    setPlaying(true);
  }, [playing, atEnd, restart]);

  return { playing, speed, setSpeed, animatedKey, pause, restart, toggle, atEnd };
}
