"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@lares/ui/primitives/button";
import type { AutonomyLevel } from "../lib/contracts";
import { setAutonomy } from "../app/actions/autonomy";
const options: { level: AutonomyLevel; title: string }[] = [
  { level: "autonomous", title: "Allow" },
  { level: "gated", title: "Ask first" },
  { level: "never", title: "Never" },
];
export function AutonomyControl(p: {
  agent: string;
  capability: string;
  action?: string;
  level: AutonomyLevel;
}) {
  const [level, setLevel] = useState(p.level);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    setLevel(p.level);
  }, [p.level]);
  async function pick(next: AutonomyLevel) {
    if (inFlight.current || error || next === level) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await setAutonomy({
        agent: p.agent,
        capability: p.capability,
        action: p.action,
        level: next,
      });
      setLevel(next);
    } catch {
      setError(
        "Could not confirm the change. Reload to check the saved permission before trying again.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div>
      <div
        className="lares-actions"
        role="group"
        aria-label={`${p.capability}${p.action ? ` ${p.action}` : ""} permission`}
        aria-busy={busy}
      >
        {options.map((o) => (
          <Button
            key={o.level}
            type="button"
            variant={level === o.level ? "secondary" : "outline"}
            size="sm"
            disabled={busy || Boolean(error)}
            aria-pressed={level === o.level}
            onClick={() => void pick(o.level)}
          >
            {o.title}
          </Button>
        ))}
      </div>
      {busy && <span role="status">Saving permission…</span>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
