"use client";
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { addConnector } from "../app/actions/outside-connectors";

/** One screen: name, address, how it signs in. Continue saves it and asks the server what it is, then opens its page. */
export function AddConnectorForm() {
  const router = useRouter();
  const [name, setName] = useState(""), [url, setUrl] = useState(""), [auth, setAuth] = useState<"automatic" | "token">("automatic");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [savedId, setSavedId] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!/^https:\/\//i.test(url.trim())) { setError("Paste the server's full address, starting with https://."); return; }
    setBusy(true); setError("");
    const r = await addConnector({ name, url, auth, ...(savedId ? { existingId: savedId } : {}) }).catch(() => ({ ok: false as const, message: "Lares could not confirm that. Press Try again.", id: savedId }));
    setBusy(false);
    if (!r.ok) { setError(r.message); if (r.id) setSavedId(r.id); return; }
    router.push(`/outside-tools/${r.id}?found=${r.authKind}`);
  }

  return <form className="lares-stack" onSubmit={submit}>
    <Field label="Name"><Input required maxLength={80} value={name} disabled={!!savedId} onChange={e => setName(e.target.value)} /></Field>
    <Field label="Server URL" hint="The MCP address the tool's maker gave you."><Input required type="url" maxLength={2048} value={url} disabled={!!savedId} onChange={e => setUrl(e.target.value)} /></Field>
    <Field label="Authentication" hint="Automatic lets Lares find out. Choose Token if you know the server needs one; you paste it on the next page.">
      <Select value={auth} onChange={e => setAuth(e.target.value as "automatic" | "token")}><option value="automatic">Automatic</option><option value="token">Token</option></Select>
    </Field>
    {busy && <Notice tone="working">Checking the server.</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="lares-actions">
      <Button type="submit" disabled={busy}>{savedId && error ? "Try again" : "Continue"}</Button>
      <Button variant="outline" asChild><Link href="/outside-tools">Cancel</Link></Button>
    </div>
  </form>;
}
