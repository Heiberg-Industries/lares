"use client";
// Where your meeting notes come from: a choice among connected sources. In this version the one
// source is a Notion meetings database. You paste its link; the chief of staff looks it up in Notion
// (the console cannot reach Notion) and says what it found; you choose it, and Lares saves the same
// installation setting as before (settings.notion_meetings_set), so nothing that works now breaks.
// Connections are made in Integrations only: this page links there, it never asks for a key.
import Link from "next/link";
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { Select } from "@lares/ui/primitives/select";
import { useState, useTransition } from "react";
import type { MeetingsDatabaseResult } from "@lares/agent-kit/clipping-console";
import { setMeetingsSource, type MeetingsSourceResult } from "../app/actions/definition";
import type { MeetingsSourceView } from "../lib/meetings-source";
import type { ClippingOutcome, MeetingsLookupView } from "../lib/clipping";
import { useKeepFresh } from "../lib/use-keep-fresh";


/** Whether Notion is connected, as far as this person may see: an admin who is not the owner cannot
 *  read the key's state, so for them it is unknown and nothing is claimed. */
export type NotionConnected = "connected" | "not-connected" | "unknown";

/** A failed lookup in plain words, by the chief of staff's outcome code; the engine's own sentence
 *  is shown for anything else. */
const LOOKUP_FAILED: Partial<Record<ClippingOutcome, string>> = {
  "not-configured": "No agent may use Notion yet, so nobody can look the database up. Switch one on on the Notion page.",
  "key-unreadable": "The agent cannot read its Notion key. Check it on the Notion page.",
  refused: "Notion refused the key. Check it on the Notion page.",
  "not-shared": "Notion has not shared this database with your Lares connection. In Notion, open the database, choose the three dots, then Connections, and add your Lares connection. Then find it again.",
  "schema-mismatch": "That link is not a Notion database. Copy the database's own link in Notion (Share, then Copy link).",
  "rate-limited": "Notion asked Lares to wait. Try again in a minute.",
  unavailable: "Notion could not be reached. Try again in a minute.",
  timeout: "Notion did not answer in time. Try again in a minute.",
};

function lookupLine(view: MeetingsLookupView): { tone: "info" | "error"; text: string } | null {
  if (view.unavailable) return { tone: "error", text: "Lares could not read the lookup. Reload the page." };
  const r = view.request;
  if (!r) return null;
  if (r.status === "pending") return { tone: "info", text: "Looking the database up in Notion. The chief of staff picks this up within a minute." };
  if (r.status === "claimed") return { tone: "info", text: "Looking the database up in Notion now." };
  if (r.status === "unavailable") return { tone: "error", text: r.detail ?? "The chief of staff did not pick this up. Is it running?" };
  if (r.status === "failed") return { tone: "error", text: (r.outcome && LOOKUP_FAILED[r.outcome]) || r.detail || "The lookup did not work." };
  return null;
}

const isFound = (r: unknown): r is MeetingsDatabaseResult => !!r && typeof r === "object" && "dataSources" in r && !("suggested" in r);

export function MeetingsSourceControl({ view, initialLookup, notion, names = {} }: {
  /** The saved setting; null when it could not be read. */
  view: MeetingsSourceView | null;
  initialLookup: MeetingsLookupView;
  notion: NotionConnected;
  /** Agent definition name → display name, for the agents a save restarted. */
  names?: Record<string, string>;
}) {
  const list = (agents: string[]) => agents.map((a) => names[a] ?? a).join(", ");
  const [current, setCurrent] = useState(view?.value ?? null);
  const [from, setFrom] = useState(view?.from ?? "none");
  const [lookup, setLookup] = useState(initialLookup);
  const [link, setLink] = useState("");
  const [asked, setAsked] = useState(false);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MeetingsSourceResult | null>(null);
  const [pending, start] = useTransition();
  const busy = !lookup.unavailable && lookup.busy;

  useKeepFresh(busy, async () => {
    try {
      const res = await fetch("/api/meetings/source", { cache: "no-store", credentials: "same-origin" });
      const body = await res.json();
      setLookup(res.ok && body.ok === true && typeof body.view?.unavailable === "boolean" ? body.view : { unavailable: true });
    } catch { setLookup({ unavailable: true }); }
  });

  const find = () => {
    setError(null); setResult(null);
    start(async () => {
      try {
        const res = await fetch("/api/meetings/source", {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ link }),
        });
        const body = await res.json();
        if (!res.ok || body.ok !== true) {
          setError(body.code === "busy" ? "A lookup is already on its way. Give it a minute."
            : body.code === "invalid-request" ? "Paste the database's link first." : "Lares could not ask for the lookup. Try again in a minute.");
          return;
        }
        setLookup(body.view); setAsked(true); setChoice("");
      } catch { setError("Lares could not ask for the lookup. Try again in a minute."); }
    });
  };
  const save = (dataSource: string) => {
    setError(null); setResult(null);
    start(async () => {
      const r = await setMeetingsSource({ dataSource });
      if (!r.ok) { setError(r.error.message); return; }
      setCurrent(r.result.value); setFrom("console"); setResult(r.result); setAsked(false);
    });
  };

  const done = !lookup.unavailable && lookup.request?.status === "done" ? lookup.request : null;
  const found = done && isFound(done.result) ? done.result : null;
  // A finished lookup is offered when it was asked for here, or when it found something other than the saved one.
  const offer = found && (asked || !found.dataSources.some((d) => d.id.replaceAll("-", "") === current?.replaceAll("-", ""))) ? found : null;
  const picked = offer ? (offer.dataSources.find((d) => d.id === choice) ?? offer.dataSources[0]!) : null;
  const line = lookupLine(lookup);
  const notionName = (id: string | null) => {
    const hit = found?.dataSources.find((d) => d.id.replaceAll("-", "") === id?.replaceAll("-", ""));
    return hit ? `“${hit.name}” in Notion` : "a Notion database";
  };

  return (
    <Card role="region" aria-labelledby="meetings-source-heading">
      <CardHeader>
        <CardTitle id="meetings-source-heading" role="heading" aria-level={2}>Where your meeting notes come from</CardTitle>
        <CardDescription>
          An agent reads your meeting notes from here and writes the follow-ups from them. In this version the one source is a Notion meetings database.
        </CardDescription>
      </CardHeader>
      <CardContent className="lares-stack">
        {view === null && <Notice tone="needs-you">The meetings source could not be read. Reload the page to try again.</Notice>}
        <div className="lares-stack" role="group" aria-label="Source">
          <p><strong>Notion meetings database</strong>{" "}
            {notion === "connected" ? "· Notion is connected." : notion === "not-connected" ? "· Notion is not connected yet." : ""}</p>
          {notion === "not-connected" && <p><Link href="/integrations/notion">Connect Notion in Integrations</Link></p>}
        </div>
        {view && <p data-testid="meetings-source">
          {current === null
            ? "No meetings database is chosen yet, so there are no follow-ups."
            : <>In use: {notionName(current)} <span className="mono">({current})</span>.</>}
          {from === "installation file" && " This one still comes from the installation file; choosing one here replaces it."}
          {view.chiefCount === 0 && " No agent reads it yet; it takes effect once a chief of staff agent exists."}
        </p>}

        {view?.canChange ? <>
          <form className="lares-inline-form" onSubmit={e => { e.preventDefault(); if (!pending && link.trim()) find(); }}>
            <Field label="Link to your meetings database in Notion">
              <Input type="url" autoComplete="off" spellCheck={false} value={link} disabled={pending || busy}
                onChange={e => { setLink(e.target.value); setResult(null); }} />
            </Field>
            <Button type="submit" variant="outline" disabled={pending || busy || link.trim() === ""}>Find database</Button>
          </form>
          <p className="lares-muted">In Notion, open the database, choose Share, then Copy link, and paste it here. The chief of staff looks it up with the Notion key; nothing is saved until you choose it.</p>
          {line && <Notice tone={line.tone === "error" ? "needs-you" : "info"}>{line.text}</Notice>}
          {offer && picked && <div className="lares-stack" role="group" aria-label="What was found">
            {offer.dataSources.length > 1
              ? <Field label="Notion found more than one table in this database. Which one holds your meetings?">
                  <Select value={picked.id} disabled={pending} onChange={e => setChoice(e.target.value)}>
                    {offer.dataSources.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </Select>
                </Field>
              : <p>Found “{picked.name}” in Notion.</p>}
            <p className="lares-muted">Choosing it restarts the agents that read it, so a conversation in progress is interrupted for a moment.</p>
            <div className="lares-inline-form"><Button disabled={pending} onClick={() => save(picked.id)}>{pending ? "Saving…" : "Use this database"}</Button></div>
          </div>}
          {current !== null && <div className="lares-inline-form">
            <Button variant="outline" disabled={pending} onClick={() => save("")}>Stop reading meeting notes</Button>
          </div>}
        </> : view && <p className="lares-muted">Only the installation&apos;s owner can choose the meetings source.</p>}

        {error && <Notice tone="error">{error}</Notice>}
        {result && (
          <Notice tone="success">
            {result.value ? "Saved." : "Saved: no meetings database is chosen now."}
            {result.restarted.length > 0 && ` ${list(result.restarted)} restarted.`}
            {result.waiting.length > 0 && ` ${list(result.waiting)} has other changes waiting, so it was left alone; it picks this up when you apply them.`}
            {result.stopped.length > 0 && ` ${list(result.stopped)} is stopped and picks this up when it next starts.`}
          </Notice>
        )}
        <p><Link href="/integrations">Connect another in Integrations</Link></p>
      </CardContent>
    </Card>
  );
}
