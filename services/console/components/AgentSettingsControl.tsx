"use client";
import { Field } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { useState, useTransition } from "react";
import { setAgentSetting, type AgentSettingsResult } from "../app/actions/definition";
import type { AgentSettingView } from "../lib/agent-settings";

const list = (names: string[]) => names.join(", ");
const SOURCE: Record<AgentSettingView["from"], string> = {
  console: "Saved in the console.",
  "installation file": "Still comes from the installation file; saving here replaces it.",
  none: "Not set.",
};

/** One chief-of-staff setting that used to live only in the installation file. Only the installation
 * owner gets the field; everyone else sees the value. Saving restarts the agents that read it. */
function AgentSettingRow({ setting, canChange }: { setting: AgentSettingView; canChange: boolean }) {
  const [current, setCurrent] = useState(setting.value);
  const [from, setFrom] = useState(setting.from);
  const [value, setValue] = useState(setting.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentSettingsResult | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    setError(null); setResult(null);
    start(async () => {
      const r = await setAgentSetting({ key: setting.key, value });
      if (!r.ok) { setError(r.error.message); return; }
      setCurrent(r.result.value); setFrom("console"); setValue(r.result.value ?? ""); setResult(r.result);
    });
  };
  return (
    <>
      <div className="lares-setting-row">
        <div>
          {setting.label}
          <p>
            {setting.description} {SOURCE[from]}
            {setting.agentCount === 0 && " No agent reads this yet; it takes effect when a chief of staff agent exists."}
            {canChange ? " Saving restarts the agents that read it, so a conversation in progress is interrupted for a moment." : " Ask the installation owner to change it."}
          </p>
        </div>
        {!canChange && <span className="mono" data-testid={`setting-${setting.key}`}>{current ?? "Not set"}</span>}
      </div>
      {canChange && (
        <form className="lares-stack" onSubmit={e => { e.preventDefault(); if (!pending) save(); }}>
          <div className="lares-inline-form">
            <Field label={`${setting.label} (empty to clear)`}>
              <Input type="text" autoComplete="off" spellCheck={false} value={value} onChange={e => { setValue(e.target.value); setResult(null); }} />
            </Field>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </div>
          {error && <p role="alert">{error}</p>}
          {result && (
            <p role="status">
              {result.value ? "Saved." : "Saved: the setting is cleared."}
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

/** Settings grouped by the section the keeper names for them (one block per integration). */
export function AgentSettingsSections({ settings, canChange }: { settings: AgentSettingView[]; canChange: boolean }) {
  const sections = [...new Set(settings.map(s => s.section))];
  return (
    <>
      {sections.map(section => (
        <section className="lares-surface" key={section}>
          <h2 className="lares-section-title">{section}</h2>
          {settings.filter(s => s.section === section).map(s => <AgentSettingRow key={s.key} setting={s} canChange={canChange} />)}
        </section>
      ))}
    </>
  );
}
