"use client";
import { Field } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { useState, useTransition } from "react";
import { acceptNotionSyncPreview, runNotionSyncPreview, setNotionSync, type DefinitionActionResult } from "../app/actions/definition";
import type { NotionSyncCounts, NotionSyncView } from "../lib/notion-sync";

const PASS_NAMES: Record<string, string> = { attendees: "Meeting attendees", people: "People records" };

const sentence = (c: NotionSyncCounts) =>
  `${c.create} new, ${c.adoptPatch} to update, ${c.skip} left alone, ${c.conflict} that need a look`;

/** The optional Notion sync: off until switched on, and then off until the owner has seen a preview of
 * what it would do and accepted it. Only the installation owner gets the buttons. */
export function NotionSyncControl({ initial }: { initial: NotionSyncView }) {
  const [view, setView] = useState(initial);
  const [people, setPeople] = useState(initial.peopleDataSource ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (work: () => Promise<DefinitionActionResult<NotionSyncView>>) => {
    setError(null);
    start(async () => {
      const r = await work();
      if (!r.ok) { setError(r.error.message); return; }
      setView(r.result); setPeople(r.result.peopleDataSource ?? "");
    });
  };
  const last = view.lastRun ? new Date(view.lastRun).toLocaleString() : "never";
  const status: Record<NotionSyncView["phase"], string> = {
    off: "Off.",
    "needs-setup": "Switched on, but it cannot run yet.",
    "needs-key": "Switched on. Connect the Notion key first (under Connections); nothing runs until it is connected.",
    "needs-preview": "Switched on, waiting for a preview. Nothing runs until you have seen what it would do and accepted it.",
    "ready-to-accept": "Preview ready. Nothing runs until you accept it.",
    on: view.running === "running" ? "On. It runs once an hour." : "On, but the service is not running. Try switching it off and on again.",
  };
  return (
    <>
      <div className="lares-setting-row">
        <div>
          Notion sync
          <p>
            Keeps meeting attendees and people records in Notion up to date, once an hour. It stays off until you switch it on and
            accept a preview of what it would do. Change anything below and you will need a new preview.
          </p>
          <p data-testid="sync-status">{status[view.phase]}</p>
          <p data-testid="sync-last-run">Last run: {last}</p>
        </div>
      </div>
      {view.phase !== "off" && view.problems.length > 0 && (
        <ul data-testid="sync-problems">{view.problems.map(p => <li key={p}>{p}</li>)}</ul>
      )}
      {view.canChange && (
        <div className="lares-stack">
          <form className="lares-inline-form" onSubmit={e => { e.preventDefault(); if (!pending) run(() => setNotionSync({ enabled: view.enabled, peopleDataSource: people })); }}>
            <Field label="People database id (Notion data source, empty for none)">
              <Input type="text" autoComplete="off" spellCheck={false} value={people} onChange={e => setPeople(e.target.value)} />
            </Field>
            <Button type="submit" disabled={pending}>Save</Button>
          </form>
          {!view.enabled
            ? <div><Button disabled={pending} onClick={() => run(() => setNotionSync({ enabled: true, peopleDataSource: people }))}>Switch on</Button></div>
            : <div className="lares-inline-form">
                {(view.phase === "needs-preview" || view.phase === "ready-to-accept") &&
                  <Button disabled={pending} onClick={() => run(runNotionSyncPreview)}>{pending ? "Working…" : view.preview?.current ? "Run preview again" : "Run preview"}</Button>}
                {view.phase === "ready-to-accept" && view.hash &&
                  <Button disabled={pending} onClick={() => run(() => acceptNotionSyncPreview({ hash: view.hash! }))}>Accept and start</Button>}
                <Button disabled={pending} onClick={() => run(() => setNotionSync({ enabled: false, peopleDataSource: people }))}>Switch off</Button>
              </div>}
        </div>
      )}
      {view.preview && (
        <div data-testid="sync-preview">
          <p>{view.preview.current ? "Preview" : "Out-of-date preview (the settings changed since)"}, {new Date(view.preview.at).toLocaleString()}:</p>
          <ul>{Object.entries(view.preview.passes).map(([name, counts]) => <li key={name}>{PASS_NAMES[name] ?? name}: {sentence(counts)}</li>)}</ul>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
