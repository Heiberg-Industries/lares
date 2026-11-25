"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Notice, StatusBadge, ToolList, ToolRow } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { connectSetDanger } from "../app/actions/outside-connect";
import { DANGER_BADGE, DANGER_CHANGED_WORDS } from "../lib/outside-tools-words";
import type { AgentUse } from "../lib/outside-connector-view";

type Item = { agent: string; displayName: string; tool: string; danger: "on" | "changed" | null };

/** One tool that changes something. The switch-on button stays disabled until the tool's exact name is typed. Switching off needs no typing. */
function DangerRow({ item, slug, allowed }: { item: Item; slug: string; allowed: boolean }) {
  const router = useRouter();
  const [typed, setTyped] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  async function set(on: boolean) {
    setBusy(true); setNote(null);
    const r = await connectSetDanger({ agent: item.agent, name: slug, tool: item.tool, on, typedName: typed })
      .catch(() => ({ ok: false as const, message: "Lares could not confirm that. Reload the page to see what is saved." }));
    setBusy(false);
    if (!r.ok) { setNote({ tone: "error", text: r.message }); return; }
    setTyped(""); setNote({ tone: "success", text: on ? "Switched on." : "Switched off." }); router.refresh();
  }
  const live = item.danger === "on";
  return <ToolRow name={item.tool} kind="change" description={`${item.displayName}`}
    control={live ? <StatusBadge tone="error">{DANGER_BADGE}</StatusBadge> : undefined}>
    {item.danger === "changed" && <Notice tone="needs-you">{DANGER_CHANGED_WORDS}</Notice>}
    {live ? <div className="lares-actions"><Button type="button" variant="outline" disabled={busy} onClick={() => void set(false)}>Switch off</Button></div>
      : allowed && <div className="lares-stack">
        <Field label={`Type ${item.tool} to confirm`} hint="Only the owner of this installation can do this. It stays on until you switch it off or the tool's description changes. Every use still counts against the agent's limits."><Input value={typed} autoComplete="off" onChange={e => setTyped(e.target.value)} /></Field>
        <div className="lares-actions"><Button type="button" variant="destructive" disabled={busy || typed !== item.tool} onClick={() => void set(true)}>Let {item.displayName} run {item.tool} without asking</Button></div>
      </div>}
    {note && <Notice tone={note.tone}>{note.text}</Notice>}
  </ToolRow>;
}

/** The red section at the bottom of a connector's page. Lists only the tools that change something, one by one; there is no blanket switch. */
export function DangerZone({ slug, uses, isOwner }: { slug: string; uses: AgentUse[]; isOwner: boolean }) {
  const items: Item[] = uses.flatMap(u => u.tools.filter(t => t.kind === "change" && t.name !== "connect-pending").map(t => ({ agent: u.agent, displayName: u.displayName, tool: t.name, danger: t.danger })));
  return <section aria-label="Danger zone" data-slot="danger-zone" className="lares-stack">
    <h2 className="lares-section-title">Danger zone</h2>
    <Notice tone="error">A tool that changes something always asks you first. Here you can let one of them run without asking, for one agent at a time. It can then send, create, delete or pay with nobody looking, in your private chats on Slack and Telegram too. Only use this for a tool you fully trust.</Notice>
    {!isOwner && <p className="lares-muted">Only the owner of this installation can switch these on or off.</p>}
    {items.length === 0 ? <p className="lares-muted">No agent has a tool here that changes something.</p>
      : <ToolList label="Tools that change something">{items.map(i => <DangerRow key={`${i.agent}/${i.tool}`} item={i} slug={slug} allowed={isOwner} />)}</ToolList>}
  </section>;
}
