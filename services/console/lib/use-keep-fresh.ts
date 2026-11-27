// "Keep this up to date": the one way a console page follows background work it started. While the
// work is asked for, waiting or running, `refresh` is called every few seconds; once it is not, the
// polling stops. Each refresh is awaited before the next is timed, so slow answers never pile up,
// and a hidden tab is skipped (and caught up on the next tick it is visible). A refresh that throws
// is tried again on the next tick: the caller decides what a failed refresh shows.
//
// Two shapes of caller use it today: a card that fetches its own route and sets its state from the
// answer (ClippingCard), and a page whose server data is re-read with `router.refresh()` (Writing
// style). Either way `active` comes from what the last answer said, so the loop ends by itself.
import { useEffect, useRef } from "react";

/** How often a page asks again while something is on its way. */
export const KEEP_FRESH_MS = 5_000;

export function useKeepFresh(active: boolean, refresh: () => unknown, everyMs: number = KEEP_FRESH_MS): void {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        try { await latest.current(); } catch { /* the next tick tries again */ }
      }
      if (!stopped) timer = setTimeout(() => { void tick(); }, everyMs);
    };
    timer = setTimeout(() => { void tick(); }, everyMs);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [active, everyMs]);
}
