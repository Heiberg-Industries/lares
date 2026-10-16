import { STATE_COLOURS } from "../lib/state-colours";

export function StatePill({ state }: { state: string }) {
  const m = STATE_COLOURS[state] ?? { c: "var(--mist)", label: state };
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
      <span style={{ width: 8, height: 8, borderRadius: 8, background: m.c }} />
      {m.label}
    </span>
  );
}
