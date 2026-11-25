"use client";
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkConnector, removeConnector, renameConnector } from "../app/actions/outside-connectors";
import { REMOVE_WARNING } from "../lib/outside-connector-words";

type Message = { tone: "working" | "success" | "error" | "info"; text: string } | null;

/** Rename (label only), Check it works, and Remove. Replace token sits with the agents' access, where the tokens are. */
export function ConnectorActions({ id, displayName }: { id: string; displayName: string }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false), [label, setLabel] = useState(displayName);
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>(null);

  async function rename() {
    setBusy(true); setMessage(null);
    const r = await renameConnector({ id, displayName: label }).catch(() => ({ ok: false as const, message: "The name could not be saved." }));
    setBusy(false);
    if (!r.ok) { setMessage({ tone: "error", text: r.message }); return; }
    setRenaming(false); router.refresh();
  }
  async function check() {
    setBusy(true); setMessage({ tone: "working", text: "Checking the server." });
    const r = await checkConnector(id).catch(() => ({ ok: false as const, message: "Lares could not confirm that. Try again." }));
    setBusy(false);
    setMessage(r.ok ? { tone: "success", text: r.value.sentence } : { tone: "error", text: r.message });
  }
  async function remove() {
    setBusy(true); setMessage({ tone: "working", text: "Removing. This can take a minute while agents restart." });
    const r = await removeConnector(id).catch(() => ({ ok: false as const, message: "Lares could not confirm that. Press Remove again to continue." }));
    setBusy(false);
    if (!r.ok) { setMessage({ tone: "error", text: r.message }); return; }
    router.push("/integrations/outside");
  }

  return <div className="lares-stack">
    <div className="lares-actions">
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setRenaming(true); setConfirming(false); }}>Rename</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void check()}>Check it works</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirming(true); setRenaming(false); }}>Remove</Button>
    </div>
    {renaming && <div className="lares-stack">
      <Field label="Name" hint="Only the label changes. Agents and tokens are not touched."><Input maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></Field>
      <div className="lares-actions"><Button type="button" disabled={busy || !label.trim()} onClick={() => void rename()}>Save name</Button><Button type="button" variant="outline" onClick={() => setRenaming(false)}>Cancel</Button></div>
    </div>}
    {confirming && <div className="lares-stack">
      <Notice tone="needs-you">{REMOVE_WARNING}</Notice>
      <div className="lares-actions"><Button type="button" disabled={busy} onClick={() => void remove()}>Remove connector</Button><Button type="button" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button></div>
    </div>}
    {message && <Notice tone={message.tone}>{message.text}</Notice>}
  </div>;
}
