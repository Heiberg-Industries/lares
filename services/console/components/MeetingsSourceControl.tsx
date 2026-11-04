"use client";
import { Field } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { useState, useTransition } from "react";
import { setMeetingsSource, type MeetingsSourceResult } from "../app/actions/definition";
import type { MeetingsSourceView } from "../lib/meetings-source";

const list = (names: string[]) => names.join(", ");

/** Which Notion database the meeting follow-up schedule reads. Only the installation owner gets the
 * field; everyone else sees the value. Saving restarts the agents that read it. */
export function MeetingsSourceControl({ view }: { view: MeetingsSourceView }) {
  const [current, setCurrent] = useState(view.value);
  const [from, setFrom] = useState(view.from);
  const [value, setValue] = useState(view.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MeetingsSourceResult | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    setError(null); setResult(null);
    start(async () => {
      const r = await setMeetingsSource({ dataSource: value });
      if (!r.ok) { setError(r.error.message); return; }
      setCurrent(r.result.value); setFrom("console"); setValue(r.result.value ?? ""); setResult(r.result);
    });
  };
  return (
    <>
      <div className="lares-setting-row">
        <div>
          Meetings database
          <p>
            The Notion database the meeting follow-up schedule reads your meeting notes from. Paste its data source id.
            {" "}{current === null ? "Not set: the follow-up schedule says so once and does nothing else." : "Set."}
            {from === "installation file" && " This value still comes from the installation file; saving here replaces it."}
            {view.chiefCount === 0 && " No agent reads this yet; it takes effect when a chief of staff agent exists."}
            {view.canChange ? " Saving restarts the agents that read it, so a conversation in progress is interrupted for a moment." : " Ask the installation owner to change it."}
          </p>
        </div>
        {!view.canChange && <span className="mono" data-testid="meetings-source">{current ?? "Not set"}</span>}
      </div>
      {view.canChange && (
        <form className="lares-stack" onSubmit={e => { e.preventDefault(); if (!pending) save(); }}>
          <div className="lares-inline-form">
            <Field label="Notion data source id (empty to clear)">
              <Input type="text" autoComplete="off" spellCheck={false} value={value} onChange={e => { setValue(e.target.value); setResult(null); }} />
            </Field>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </div>
          {error && <p role="alert">{error}</p>}
          {result && (
            <p role="status">
              {result.value ? "Saved." : "Saved: the meetings database is cleared."}
              {result.restarted.length > 0 && ` ${list(result.restarted)} restarted.`}
              {result.waiting.length > 0 && ` ${list(result.waiting)} has other changes waiting, so it was left alone; it picks this up when you apply them.`}
              {result.stopped.length > 0 && ` ${list(result.stopped)} is stopped and picks this up when it next starts.`}
            </p>
          )}
        </form>
      )}
    </>
  );
}
