"use client";
import { Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { useState, useTransition } from "react";
import { requestRelearn } from "../app/actions/voice";

export function RelearnButton(p: { status: string; message: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  const busy = pending || p.status === "running";
  return (
    <div className="lares-stack">
      <Button type="button" variant="outline" disabled={busy} onClick={() => start(async () => { setMsg(""); try { await requestRelearn(); setMsg("Requested — learning runs shortly."); } catch (e) { setMsg(String(e)); } })}>
        {busy ? "Learning…" : "Re-learn from Sent mail"}
      </Button>
      {p.status === "error" && <Notice error>The last learning run failed{p.message ? `: ${p.message}` : "."}</Notice>}
      {msg && <Notice tone={msg.startsWith("Requested") ? "info" : "error"}>{msg}</Notice>}
    </div>
  );
}
