import { STATE_COLOURS } from "../lib/state-colours";

export function StatePill({ state }: { state: string }) {
  const m = STATE_COLOURS[state] ?? { c: "var(--mist)", label: state };
  return (
    <span className="mono lares-small lares-state-pill">
      <span className="lares-state-dot" style={{ background: m.c }} />
      {m.label}
    </span>
  );
}
