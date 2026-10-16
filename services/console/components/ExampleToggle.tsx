"use client";
import { useState, useTransition } from "react";
import { setExampleIncluded } from "../app/actions/voice";

export function ExampleToggle(p: { id: string; included: boolean }) {
  const [on, setOn] = useState(p.included);
  const [, start] = useTransition();
  return (
    <input type="checkbox" checked={on}
      onChange={() => { const next = !on; setOn(next); start(async () => { try { await setExampleIncluded({ id: p.id, included: next }); } catch { setOn(!next); } }); }} />
  );
}
