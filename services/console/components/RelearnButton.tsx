"use client";
import { Button } from "@lares/ui/primitives/button";
import { useState, useTransition } from "react";
import { requestRelearn } from "../app/actions/voice";

export function RelearnButton(p: { status: string; message: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  const busy = pending || p.status === "running";
  return (
    <span className="lares-actions">
      <Button type="button" variant="outline" disabled={busy} onClick={() => start(async () => { setMsg(""); try { await requestRelearn(); setMsg("Requested — learning runs shortly."); } catch (e) { setMsg(String(e)); } })}>
        {busy ? "Learning…" : "Re-learn from Sent mail"}
      </Button>
      {p.status === "error" && <span className="lares-small lares-status-error" title={p.message}>last run failed</span>}
      {msg && <span className="lares-small lares-status-muted">{msg}</span>}
    </span>
  );
}
