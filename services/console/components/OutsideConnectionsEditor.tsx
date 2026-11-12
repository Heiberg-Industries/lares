"use client";
import { Choice, Field, PageHeader } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { SaveEndsConversations } from "./SaveEndsConversations";
import { Checkbox } from "@lares/ui/primitives/checkbox";
import { Input } from "@lares/ui/primitives/input";
import { Textarea } from "@lares/ui/primitives/textarea";
import { useState, type FormEvent } from "react";
import type { OutsideToolDeclaration } from "@lares/agent-kit/definition";
import { applyOutsideConnections, saveOutsideConnections, type OutsideConnectionsState } from "../app/actions/outside-connections";

type Draft = {
  name: string; url: string; description: string; token: boolean;
  allow: string; read: string; trusted: boolean; runsAt: string;
};
const draftOf = (connection?: OutsideToolDeclaration): Draft => ({
  name: connection?.name ?? "", url: connection?.url ?? "", description: connection?.description ?? "",
  token: connection?.token ?? false, allow: connection?.tools.allow.join(", ") ?? "",
  read: connection?.tools.read.join(", ") ?? "", trusted: connection?.trusted ?? false, runsAt: connection?.runsAt ?? "",
});
const listOf = (value: string) => [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];

export function OutsideConnectionsEditor({ initial }: { initial: OutsideConnectionsState }) {
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function apply() {
    if (busy || state.applicationStatus !== "pending") return;
    setBusy(true); setMessage("");
    try {
      const result = await applyOutsideConnections({ name: state.name, expectedDefinitionHash: state.definitionHash,
        expectedAccessRevision: state.accessRevision });
      if (!result.ok) {
        setState(result.current ?? { ...state, applicationStatus: "unavailable", appliedConnections: [] });
        setMessage(result.message); return;
      }
      setState(result.result);
      setMessage(result.result.applicationStatus === "applied"
        ? "Applied. The saved declarations match the last applied runtime definition."
        : result.result.applicationStatus === "pending"
          ? "Apply returned, but the saved declarations still differ from the last applied definition. Refresh before trying again."
          : "Apply returned, but the applied declaration state is unavailable. Refresh before trying again.");
    } catch {
      setState(current => ({ ...current, applicationStatus: "unavailable", appliedConnections: [] }));
      setMessage("Apply did not complete. Refresh to confirm which declarations are applied before trying again.");
    } finally { setBusy(false); }
  }

  async function publish(connections: OutsideToolDeclaration[]) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await saveOutsideConnections({
        name: state.name, expectedDefinitionHash: state.definitionHash,
        expectedAccessRevision: state.accessRevision, connections,
      });
      if (!result.ok) { setMessage(result.message); return; }
      setState(result.result); setDraft(null); setEditing(null);
      setMessage("Saved. The agent will use the saved connection settings after they are applied.");
    } catch {
      setMessage("The change could not be confirmed. Refresh this page before trying again.");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const connection: OutsideToolDeclaration = {
      name: draft.name.trim(), url: draft.url.trim(), description: draft.description.trim(), token: draft.token,
      tools: { allow: listOf(draft.allow), read: listOf(draft.read) }, trusted: draft.trusted,
      ...(draft.runsAt.trim() ? { runsAt: draft.runsAt.trim() } : {}),
    };
    const next = editing
      ? state.connections.map(item => item.name === editing ? connection : item)
      : [...state.connections, connection];
    void publish(next);
  }

  return <><PageHeader title={`Outside connections for ${state.name}`} />
  <section className="lares-surface lares-stack" aria-label="Outside connection settings">
    <p>Manage only this agent’s connection declarations. Connection credentials remain under their custodian’s control and are never entered here.</p>
    <p>Removing a declaration does not revoke or delete its separately held credential.</p>
    <SaveEndsConversations />
    {state.applicationStatus === "applied" ? <p role="status">The last applied runtime definition matches these saved declarations.</p> : state.applicationStatus === "pending" ? <div className="lares-stack">
      <p role="status">Saved declarations are pending Apply. The last applied declaration set is shown below.</p>
      <Button type="button" disabled={busy} onClick={() => void apply()}>{busy ? "Applying…" : "Apply saved declarations"}</Button>
    </div> : <p role="status">Applied declaration status is unavailable. Refresh before applying changes.</p>}
    {state.applicationStatus === "pending" && <section aria-label="Currently applied connection declarations">
      <h2 className="lares-section-title">Currently applied declarations</h2>
      {state.appliedConnections.length ? <ul>{state.appliedConnections.map(connection => <li key={connection.name}>{connection.name} — {connection.description}</li>)}</ul> : <p>No outside connections are currently applied.</p>}
    </section>}
    {state.connections.length ? <ul className="lares-data-list">
      {state.connections.map(connection => <li key={connection.name}>
        <strong>{connection.name}</strong><p>{connection.description}</p><p>Address: <span className="mono">{connection.url}</span></p>
        <p>Allowed tools: {connection.tools.allow.join(", ")}</p>
        <div className="lares-actions">
          <Button type="button" variant="outline" disabled={busy} onClick={() => { setEditing(connection.name); setDraft(draftOf(connection)); setMessage(""); }}>Edit</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void publish(state.connections.filter(item => item.name !== connection.name))}>Remove declaration</Button>
        </div>
      </li>)}</ul> : <p>No outside connections are declared.</p>}
    {!draft && <Button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft(draftOf()); setMessage(""); }}>Add connection</Button>}
    {draft && <form className="lares-stack" onSubmit={submit}>
      <h2 className="lares-section-title">{editing ? `Edit ${editing}` : "Add connection"}</h2>
      <Field label="Connection name"><Input required pattern="[a-z][a-z0-9-]{0,40}" maxLength={41} value={draft.name} disabled={!!editing} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label="Server address"><Input required type="url" maxLength={2048} value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} /></Field>
      <Field label="What this server is for"><Textarea required maxLength={500} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
      <Field label="Tools this agent may use" hint="Enter tool names separated by commas."><Input required value={draft.allow} onChange={e => setDraft({ ...draft, allow: e.target.value })} /></Field>
      <Field label="Read-only tools" hint="Must be chosen from the allowed tools. Leave empty when all allowed tools make changes."><Input value={draft.read} onChange={e => setDraft({ ...draft, read: e.target.value })} /></Field>
      <Choice><Checkbox checked={draft.token} onChange={e => setDraft({ ...draft, token: e.target.checked })} /> This server requires a credential</Choice>
      <Choice><Checkbox checked={draft.trusted} onChange={e => setDraft({ ...draft, trusted: e.target.checked })} /> Allow trusted lookups without asking</Choice>
      <Field label="Runs at (optional)"><Input maxLength={200} value={draft.runsAt} onChange={e => setDraft({ ...draft, runsAt: e.target.value })} /></Field>
      <div className="lares-actions"><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save connections"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setDraft(null); setEditing(null); }}>Cancel</Button></div>
    </form>}
    {message && <p role="status">{message}</p>}
  </section></>;
}
