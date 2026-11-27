"use client";
import { Field, Notice, RunStatus, type RunStatusProps } from "@lares/ui/patterns";
import { Badge } from "@lares/ui/primitives/badge";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { acceptNotionSyncPreview, runNotionSyncPreview, setNotionSync, type DefinitionActionResult } from "../app/actions/definition";
import type { NotionSyncCounts, NotionSyncView } from "../lib/notion-sync";
import { NOTION_KEY_UPDATED } from "./NotionConnection";

const PASS_NAMES: Record<string, string> = { attendees: "Meeting attendees", people: "People records" };

const sentence = (c: NotionSyncCounts) =>
  `${c.create} new, ${c.adoptPatch} to update, ${c.skip} left alone, ${c.conflict} that need a look`;

/** Where the People sync is, for its status line. Pure. */
export function peopleSyncRunStatus(view: NotionSyncView): RunStatusProps {
  const last = view.lastRun ? `on ${view.lastRun.slice(0, 10)} at ${view.lastRun.slice(11, 16)} UTC` : undefined;
  switch (view.phase) {
    case "off": return { state: "skipped", why: "Switched off." };
    case "needs-setup": return { state: "waiting", why: "Switched on, but it cannot run yet." };
    case "needs-key": return { state: "waiting", why: "Waiting for Notion to be connected." };
    case "needs-preview": return { state: "waiting", why: "Waiting for a preview of what it would do." };
    case "ready-to-accept": return { state: "waiting", why: "Waiting for you to accept the preview." };
    case "on": return view.running !== "running"
      ? { state: "failed", why: "The service is not running. Try switching it off and on again." }
      : view.lastRun ? { state: "finished", when: last, why: "It runs once an hour." } : { state: "waiting", why: "On. The first run is within the hour." };
  }
}

/** The optional Notion sync: off until switched on, and then off until the owner has seen a preview of
 * what it would do and accepted it. Only the installation owner gets the buttons. */
export function NotionSyncControl({ initial }: { initial: NotionSyncView }) {
  const [view, setView] = useState(initial);
  const [people, setPeople] = useState(initial.peopleDataSource ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  // The Notion key card on the same page changed the key, which decides whether this sync can run: ask the
  // server for the page again, and show what it sends back.
  useEffect(() => {
    const onKey = () => router.refresh();
    window.addEventListener(NOTION_KEY_UPDATED, onKey);
    return () => window.removeEventListener(NOTION_KEY_UPDATED, onKey);
  }, [router]);
  // What the server last said the saved id is. An id the person has typed but not saved is theirs: fresh data from
  // the server (after a key test, say) replaces the field only while it still shows the saved value.
  const saved = useRef(initial.peopleDataSource ?? "");
  useEffect(() => {
    const next = initial.peopleDataSource ?? "", before = saved.current;
    setView(initial); setPeople((typed) => (typed === before ? next : typed));
    saved.current = next;
  }, [initial]);
  const run = (work: () => Promise<DefinitionActionResult<NotionSyncView>>) => {
    setError(null);
    start(async () => {
      const r = await work();
      if (!r.ok) { setError(r.error.message); return; }
      setView(r.result); setPeople(r.result.peopleDataSource ?? ""); saved.current = r.result.peopleDataSource ?? "";
    });
  };
  const last = view.lastRun ? new Date(view.lastRun).toLocaleString() : "never";
  const status: Record<NotionSyncView["phase"], string> = {
    off: "Off.",
    "needs-setup": "Switched on, but it cannot run yet.",
    "needs-key": "Switched on. Connect Notion first (under 1. Connect on this page); nothing runs until it is connected.",
    "needs-preview": "Switched on, waiting for a preview. Nothing runs until you have seen what it would do and accepted it.",
    "ready-to-accept": "Preview ready. Nothing runs until you accept it.",
    on: view.running === "running" ? "On. It runs once an hour." : "On, but the service is not running. Try switching it off and on again.",
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>People sync</CardTitle>
        <CardDescription>
          Keeps meeting attendees and people records in Notion up to date, once an hour. It stays off until you switch it on and
          accept a preview of what it would do. Change anything below and you will need a new preview.
        </CardDescription>
        <CardAction><Badge variant={view.phase === "on" && view.running === "running" ? "success" : view.phase === "off" ? "neutral" : "warning"}>{view.phase === "on" ? "On" : view.phase === "off" ? "Off" : "Not running yet"}</Badge></CardAction>
      </CardHeader>
      <CardContent className="lares-stack">
      <RunStatus label="People sync" {...peopleSyncRunStatus(view)} />
      <p data-testid="sync-status">{status[view.phase]}</p>
      <p className="lares-muted" data-testid="sync-last-run">Last run: {last}</p>
      {view.phase !== "off" && view.problems.length > 0 && (
        <Notice tone="needs-you"><ul data-testid="sync-problems">{view.problems.map(p => <li key={p}>{p}</li>)}</ul></Notice>
      )}
      {view.canChange && (
        <div className="lares-stack">
          <form className="lares-inline-form" onSubmit={e => { e.preventDefault(); if (!pending) run(() => setNotionSync({ enabled: view.enabled, peopleDataSource: people })); }}>
            <Field label="People database id (Notion data source, empty for none)">
              <Input type="text" autoComplete="off" spellCheck={false} value={people} onChange={e => setPeople(e.target.value)} />
            </Field>
            <Button type="submit" variant="outline" disabled={pending}>Save</Button>
          </form>
          {!view.enabled
            ? <div><Button disabled={pending} onClick={() => run(() => setNotionSync({ enabled: true, peopleDataSource: people }))}>Switch on</Button></div>
            : <div className="lares-inline-form">
                {(view.phase === "needs-preview" || view.phase === "ready-to-accept") &&
                  <Button variant={view.phase === "ready-to-accept" ? "outline" : "default"} disabled={pending} onClick={() => run(runNotionSyncPreview)}>{pending ? "Working…" : view.preview?.current ? "Run preview again" : "Run preview"}</Button>}
                {view.phase === "ready-to-accept" && view.hash &&
                  <Button disabled={pending} onClick={() => run(() => acceptNotionSyncPreview({ hash: view.hash! }))}>Accept and start</Button>}
                <Button variant="outline" disabled={pending} onClick={() => run(() => setNotionSync({ enabled: false, peopleDataSource: people }))}>Switch off</Button>
              </div>}
        </div>
      )}
      {view.preview && (
        <div data-testid="sync-preview">
          <p>{view.preview.current ? "Preview" : "Out-of-date preview (the settings changed since)"}, {new Date(view.preview.at).toLocaleString()}:</p>
          <ul>{Object.entries(view.preview.passes).map(([name, counts]) => <li key={name}>{PASS_NAMES[name] ?? name}: {sentence(counts)}</li>)}</ul>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      </CardContent>
    </Card>
  );
}
