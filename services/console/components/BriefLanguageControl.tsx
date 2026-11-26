"use client";
/**
 *  — the brief's language, offered next to the home-timezone line on `/quiet-hours-and-delivery`.
 *
 * A new file, deliberately: `ProactivityControls.tsx` is the gate's three knobs
 * (`proactivity_settings`), and this one knob writes a different table (`brief_settings`) and
 * revalidates the same page for an unrelated reason. Built from the design system's shared parts.
 *
 * `BRIEF_LANGUAGES_MIRROR` comes from `lib/brief-languages.ts`, NOT `lib/brief-settings.ts`: that
 * one reaches `pg` through `./db`, and a client component importing it breaks `next build` (which
 * is the only check that can see it). The row's current value arrives as a prop.
 */
import { Field, Notice } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Select } from "@lares/ui/primitives/select";
import { useState, useTransition } from "react";
import { saveBriefLanguage } from "../app/actions/proactivity";
import type { SaveResult } from "../app/actions/proactivity";
import { BRIEF_LANGUAGES_MIRROR } from "../lib/brief-languages";
import type { BriefLanguageCode } from "../lib/brief-languages";

export interface BriefLanguageProps {
  language: BriefLanguageCode;
  /** Set when `brief_settings` could not be read (including a table that does not exist yet). */
  unavailable?: boolean;
}

export function BriefLanguageControl({ language, unavailable }: BriefLanguageProps) {
  const [value, setValue] = useState<BriefLanguageCode>(language);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (unavailable) {
    return (
      <Notice error>
        Brief language couldn&apos;t be read. If this installation has not applied
        sql/001_baseline.sql yet, apply it on the server and reload this page; otherwise the
        database is not answering.
      </Notice>
    );
  }

  function submit() {
    setMsg(null);
    start(async () => {
      let r: SaveResult;
      try { r = await saveBriefLanguage({ language: value }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.message });
    });
  }

  return (
    <div className="lares-stack">
      <div className="lares-inline-form">
        <Field label="Brief language">
          <Select value={value} disabled={pending} onChange={(e) => setValue(e.target.value as BriefLanguageCode)}>
            {BRIEF_LANGUAGES_MIRROR.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </Select>
        </Field>
        <Button type="button" variant="outline" disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</Button>
      </div>
      <p className="lares-muted">Used from the next brief. One already on its way still uses the old language.</p>
      {msg && <Notice tone={msg.ok ? "success" : "error"}>{msg.text}</Notice>}
    </div>
  );
}
