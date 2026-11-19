import { useEffect, useRef, useState } from "react";
import type { StudioStep } from "@/lib/studio";

/** Wall clock that ticks once a second while `active`; used for "running for Ns" counters. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Live view presenter. Backend events can land milliseconds apart (code accepted → file written → executing),
 * so new steps are shown in order with a short dwell, then the view sits on the real latest state.
 * History that already existed when the tab opened is shown settled, without animation.
 */
export function useLivePresenter(steps: StudioStep[], ready: boolean) {
  const [shown, setShown] = useState(-1);
  const [animated, setAnimated] = useState<string | null>(null);
  const latest = useRef(steps);
  latest.current = steps;
  const last = steps.length - 1;
  useEffect(() => {
    if (!ready || last < 0) return;
    if (shown < 0) { setShown(last); return; }
    if (shown >= last) return;
    const behind = last - shown;
    if (behind > 14) { setShown(last); setAnimated(null); return; } // far behind (tab was hidden): jump
    const current = latest.current[shown];
    // Only hand-offs get time on screen; bookkeeping steps pass quickly so the view stays close to real time.
    const dwell = current?.transfer && animated === current.key ? (behind > 5 ? 380 : 520) : 70;
    const t = window.setTimeout(() => {
      setShown(shown + 1);
      setAnimated(latest.current[shown + 1]?.key ?? null);
    }, dwell);
    return () => window.clearTimeout(t);
  }, [ready, last, shown, animated]);
  return { shown: shown < 0 ? last : Math.min(shown, last), animated };
}
