"use client";
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Textarea } from "@lares/ui/primitives/textarea";
import { useState } from "react";

type Message = { tone: "working" | "success" | "error"; text: string };

/** Plain textarea + Save. The spine validates; its message is shown with what to do next. */
export function JsonEditor({ label, initial, onSave, hint }: { label: string; initial: unknown; onSave(json: string): Promise<void>; hint: string }) {
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [msg, setMsg] = useState<Message | null>(null);
  async function save() {
    setMsg({ tone: "working", text: "Saving…" });
    try { JSON.parse(text); await onSave(text); setMsg({ tone: "success", text: "Saved." }); }
    catch (e) {
      setMsg({ tone: "error", text: `Not saved: ${String(e instanceof Error ? e.message : e)}. Correct the text above and press Save again. Nothing was changed.` });
    }
  }
  return (
    <div className="lares-stack">
      <Field label={label} hint={hint}>
        <Textarea className="mono lares-small" value={text} onChange={(e) => setText(e.target.value)} rows={28} />
      </Field>
      <div className="lares-actions">
        <Button type="button" onClick={save}>Save</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
