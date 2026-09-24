"use client";
/**
 * LAR-16-s3 — the brief's language, offered next to the home-timezone line on `/proactivity`.
 *
 * A new file, deliberately: `ProactivityControls.tsx` is the gate's three knobs
 * (`proactivity_settings`), and this one knob writes a different table (`brief_settings`) and
 * revalidates the same page for an unrelated reason. Styled the same plain way — inline styles
 * copied from that file's `inp`/`btn` constants, no UI library, no new global CSS.
 *
 * `BRIEF_LANGUAGES_MIRROR` comes from `lib/brief-languages.ts`, NOT `lib/brief-settings.ts`: that
 * one reaches `pg` through `./db`, and a client component importing it breaks `next build` (which
 * is the only check that can see it). The row's current value arrives as a prop.
 */
import { useState, useTransition } from "react";
import { saveBriefLanguage } from "../app/actions/proactivity";
import type { SaveResult } from "../app/actions/proactivity";
import { BRIEF_LANGUAGES_MIRROR } from "../lib/brief-languages";
import type { BriefLanguageCode } from "../lib/brief-languages";

const inp = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 8px",
  fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--card)", color: "var(--ink)",
} as const;

const btn = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px",
  background: "var(--signal)", color: "#fff", cursor: "pointer", fontSize: 12,
} as const;

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
      <p className="mono" style={{ marginTop: 8, color: "var(--bad)", fontSize: 12 }}>
        Brief language couldn&apos;t be read. If this installation has not applied
        sql/050_brief_settings.sql yet, apply it on the server and reload this page; otherwise the
        database is not answering.
      </p>
    );
  }

  function submit() {
    setMsg(null);
    start(async () => {
      let r: SaveResult;
      try { r = await saveBriefLanguage({ language: value }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "saved" } : { ok: false, text: r.message });
    });
  }

  return (
    <div style={{ marginTop: 8 }}>
      <label className="mono" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        Brief language
        <select
          style={inp} value={value} disabled={pending}
          onChange={(e) => setValue(e.target.value as BriefLanguageCode)}
        >
          {BRIEF_LANGUAGES_MIRROR.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <button style={btn} disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</button>
        {msg && <span className="mono" style={{ fontSize: 12, color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</span>}
      </label>
      <p style={{ color: "var(--mist)", fontSize: 12, margin: "2px 0 0" }}>
        Takes effect from the next brief — the one already on its way still uses the old language.
      </p>
    </div>
  );
}
