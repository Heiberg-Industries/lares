"use client";
import { Field, FieldGroup, Notice, Row, Rows } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Card, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { ListEditor } from "@lares/ui/primitives/list-editor";
import { useState, useTransition } from "react";
import { setAgentSetting, type AgentSettingsResult } from "../app/actions/definition";
import type { AgentSettingView } from "../lib/agent-settings";
import { draftOf, draftText, type SettingDraft, type TrackDraft } from "../lib/list-setting";

const list = (names: string[]) => names.join(", ");
const SOURCE: Record<AgentSettingView["from"], string> = {
  console: "Saved in the console.",
  "installation file": "Still comes from the installation file; saving here replaces it.",
  none: "Not set.",
};
const NEW_TRACK: TrackDraft = { id: "", description: "", closingSteps: [], namedClosingSteps: false };

/** One track of the CRM tracks setting: its exact value, a line about it, and the stages that close it. */
function TrackFields({ number, track, disabled, onChange, onRemove }: {
  number: number; track: TrackDraft; disabled: boolean; onChange(next: TrackDraft): void; onRemove(): void;
}) {
  return (
    <FieldGroup legend={`Track ${number}`} disabled={disabled}>
      <Field label="Track value" hint="Exactly as it is written in your CRM.">
        <Input type="text" autoComplete="off" spellCheck={false} value={track.id} onChange={e => onChange({ ...track, id: e.target.value })} />
      </Field>
      <Field label="What it is for" hint="One line that explains this track to the agent.">
        <Input type="text" autoComplete="off" value={track.description} onChange={e => onChange({ ...track, description: e.target.value })} />
      </Field>
      <FieldGroup legend="Stages that close it">
        <ListEditor label={`Closing stage of track ${number}`} addLabel="Add a stage" values={track.closingSteps} disabled={disabled} onChange={closingSteps => onChange({ ...track, closingSteps })} />
      </FieldGroup>
      <div className="lares-actions">
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>Remove track {number}</Button>
      </div>
    </FieldGroup>
  );
}

/** One chief-of-staff setting that used to live only in the installation file. Only the installation
 * owner gets the field; everyone else sees the value. Saving restarts the agents that read it.
 * A setting that holds a list is typed as one box per value; `lib/list-setting.ts` turns the boxes
 * back into the same text the single field sent. */
function AgentSettingRow({ setting, canChange }: { setting: AgentSettingView; canChange: boolean }) {
  const [current, setCurrent] = useState(setting.value);
  const [from, setFrom] = useState(setting.from);
  const [draft, setDraft] = useState<SettingDraft>(() => draftOf(setting.key, setting.value));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentSettingsResult | null>(null);
  const [pending, start] = useTransition();
  const edit = (next: SettingDraft) => { setDraft(next); setResult(null); };
  const save = () => {
    setError(null); setResult(null);
    start(async () => {
      const r = await setAgentSetting({ key: setting.key, value: draftText(draft, current) });
      if (!r.ok) { setError(r.error.message); return; }
      setCurrent(r.result.value); setFrom("console"); setDraft(draftOf(setting.key, r.result.value)); setResult(r.result);
    });
  };
  const description = (
    <>
      {setting.description} {SOURCE[from]}
      {setting.agentCount === 0 && " No agent reads this yet; it takes effect when a chief of staff agent exists."}
      {canChange ? " Saving restarts the agents that read it, so a conversation in progress is interrupted for a moment." : " Ask the installation owner to change it."}
    </>
  );
  if (!canChange)
    return <Row title={setting.label} description={description} control={<span className="mono" data-testid={`setting-${setting.key}`}>{current ?? "Not set"}</span>} />;
  return (
    <Row title={setting.label} description={description}>
      <form className="lares-stack" onSubmit={e => { e.preventDefault(); if (!pending) save(); }}>
        {draft.kind === "text" && (
          <div className="lares-inline-form">
            <Field label={`${setting.label} (empty to clear)`}>
              <Input type="text" autoComplete="off" spellCheck={false} value={draft.text} onChange={e => edit({ kind: "text", text: e.target.value })} />
            </Field>
            <Button type="submit" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        )}
        {draft.kind === "values" && (
          <>
            <ListEditor label={setting.label} values={draft.items} disabled={pending} onChange={items => edit({ ...draft, items })} />
            <p className="lares-field-hint">One value in each box. Remove every box and save to clear the setting.</p>
          </>
        )}
        {draft.kind === "tracks" && (
          <>
            {draft.items.map((track, index) => (
              <TrackFields
                key={index}
                number={index + 1}
                track={track}
                disabled={pending}
                onChange={next => edit({ ...draft, items: draft.items.map((old, i) => (i === index ? next : old)) })}
                onRemove={() => edit({ ...draft, items: draft.items.filter((_, i) => i !== index) })}
              />
            ))}
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => edit({ ...draft, items: [...draft.items, NEW_TRACK] })}>Add a track</Button>
            <p className="lares-field-hint">Remove every track and save to clear the setting.</p>
          </>
        )}
        {draft.kind !== "text" && <Button type="submit" variant="outline" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>}
        {error && <Notice error>{error}</Notice>}
        {result && (
          <Notice tone="success">
            {result.value ? "Saved." : "Saved: the setting is cleared."}
            {result.restarted.length > 0 && ` ${list(result.restarted)} restarted.`}
            {result.waiting.length > 0 && ` ${list(result.waiting)} has other changes waiting, so it was left alone; it picks this up when you apply them.`}
            {result.stopped.length > 0 && ` ${list(result.stopped)} is stopped and picks this up when it next starts.`}
          </Notice>
        )}
      </form>
    </Row>
  );
}

/** Settings grouped by the section the keeper names for them (one block per integration). */
export function AgentSettingsSections({ settings, canChange }: { settings: AgentSettingView[]; canChange: boolean }) {
  const sections = [...new Set(settings.map(s => s.section))];
  return (
    <>
      {sections.map(section => (
        <Card key={section}>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>{section}</CardTitle>
          </CardHeader>
          <Rows label={section}>
            {settings.filter(s => s.section === section).map(s => <AgentSettingRow key={s.key} setting={s} canChange={canChange} />)}
          </Rows>
        </Card>
      ))}
    </>
  );
}
