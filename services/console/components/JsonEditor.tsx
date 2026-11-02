"use client";
import { Button } from "@lares/ui/primitives/button";
import { Textarea } from "@lares/ui/primitives/textarea";
import { useState } from "react";

/** Plain textarea + Save. The spine validates; its message is shown verbatim. */
export function JsonEditor({ initial, onSave, hint }: { initial: unknown; onSave(json: string): Promise<void>; hint: string }) {
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [msg, setMsg] = useState("");
  async function save() {
    setMsg("saving…");
    try { JSON.parse(text); await onSave(text); setMsg("saved"); }
    catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
  }
  return (
    <div className="lares-stack lares-operational-section">
      <p className="lares-small lares-status-muted">{hint}</p>
      <Textarea className="mono lares-small" value={text} onChange={(e) => setText(e.target.value)} rows={28} />
      <div className="lares-actions">
        <Button type="button" onClick={save}>Save</Button>
        <span className={msg === "saved" ? "lares-form-success" : "lares-form-error"}>{msg}</span>
      </div>
    </div>
  );
}
