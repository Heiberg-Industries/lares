"use client";
import { useState } from "react";
import type { AutonomyLevel } from "../lib/contracts";
import { setAutonomy } from "../app/actions/autonomy";

const OPTS: { level: AutonomyLevel; glyph: string; title: string }[] = [
  { level: "autonomous", glyph: "✓", title: "Always allow" },
  { level: "gated", glyph: "✋", title: "Needs approval" },
  { level: "never", glyph: "🚫", title: "Never" },
];

export function AutonomyControl(p: {
  agent: string;
  capability: string;
  action?: string;
  level: AutonomyLevel;
}) {
  const [level, setLevel] = useState(p.level);
  const [err, setErr] = useState("");

  async function pick(l: AutonomyLevel) {
    const prev = level;
    setLevel(l);
    setErr("");
    try {
      await setAutonomy({ agent: p.agent, capability: p.capability, action: p.action, level: l });
    } catch (e) {
      setLevel(prev);
      setErr(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {OPTS.map((o) => (
        <button
          type="button"
          key={o.level}
          title={o.title}
          onClick={() => pick(o.level)}
          style={{
            border: "1px solid var(--rule)",
            borderRadius: 4,
            padding: "2px 6px",
            cursor: "pointer",
            background: level === o.level ? "var(--signal)" : "var(--card)",
            color: level === o.level ? "#fff" : "var(--ink)",
          }}
        >
          {o.glyph}
        </button>
      ))}
      {err && (
        <span title={err} style={{ color: "var(--bad)" }}>
          !
        </span>
      )}
    </span>
  );
}
