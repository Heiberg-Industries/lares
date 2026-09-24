"use client";
/**
 * ORB-193 — the owner's three knobs on the proactivity gate.
 *
 * Every switch says in words what turning it does, because "dnd: on" tells an owner nothing about
 * whether their morning brief still arrives (the same rule `ConsumerSwitches` sets out for the
 * spine's kill switches). A refused save puts the control back and prints the reason: a checkbox
 * that stays flipped after a failed write is a lie about production.
 *
 * The engine maxima arrive as props rather than being imported: `lib/proactivity.ts` reaches the
 * database, and a client component may not pull that in. The page reads them from the one constant.
 */
import { useState, useTransition } from "react";
import { saveCeilings, saveDnd, saveQuietHours } from "../app/actions/proactivity";
import type { SaveResult } from "../app/actions/proactivity";

export interface DndScope {
  agent: string;
  label: string;
  /** The row's own switch. */
  dnd: boolean;
  /** What the gate actually resolves for this agent (global OR its own row). */
  effective: boolean;
}

/**
 * A value the page has already put back through the kit's read-time rules: `value` is what the
 * ENGINE enforces, and `note` is set only when the stored row says something else ("stored 50 — the
 * engine uses 10"). Structurally the lib's `Effective<T>`, restated here because this is a client
 * component and `lib/proactivity.ts` reaches the database.
 */
export interface EffectiveValue<T> {
  value: T;
  note: string | null;
}

export interface QuietScope {
  door: string;
  label: string;
  /** The window the engine will use — NOT necessarily the one stored. */
  quietStart: string;
  quietEnd: string;
  /** True when nothing is stored for this scope at all. */
  isDefault: boolean;
  /** Set when the stored row and the engine disagree. */
  note: string | null;
}

export interface EngineMaxima {
  quietStart: string;
  quietEnd: string;
  quietMinHours: number;
  eventPerDoorPerDay: number;
  escalationPerDoorPerDay: number;
  perOwnerPerDay: number;
}

const inp = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 8px",
  fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--card)", color: "var(--ink)",
} as const;

const btn = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 12px",
  background: "var(--signal)", color: "#fff", cursor: "pointer", fontSize: 12,
} as const;

function Note({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--mist)", fontSize: 12, margin: "2px 0 0" }}>{children}</p>;
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <span className="mono" style={{ fontSize: 12, color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</span>
  );
}

/** The engine-disagrees annotation. Warn-coloured, never hidden: a stored value the fleet is
 *  overriding is the one thing this page must not let an owner read as truth. */
function Override({ note }: { note: string | null }) {
  if (!note) return null;
  return <span className="mono" style={{ fontSize: 12, color: "var(--warn)" }}>{note}</span>;
}

// ── Do not disturb ─────────────────────────────────────────────────────────────────────────────

function DndRow({ scope }: { scope: DndScope }) {
  const [on, setOn] = useState(scope.dnd);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  // `effective` is what the gate resolves for this agent (global OR its own row): an agent row that
  // is off while the effective answer is on can only mean the global switch is holding it quiet.
  const heldByGlobal = scope.agent !== "*" && scope.effective && !scope.dnd;

  function toggle(next: boolean) {
    const prev = on;
    setOn(next);
    setMsg(null);
    start(async () => {
      let r: SaveResult;
      try { r = await saveDnd({ agent: scope.agent, dnd: next }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      if (r.ok) setMsg({ ok: true, text: next ? "quiet — nothing will be initiated" : "off" });
      else { setOn(prev); setMsg({ ok: false, text: r.message }); }
    });
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <label className="mono" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline" }}>
        <input type="checkbox" checked={on} disabled={pending} onChange={(e) => toggle(e.target.checked)} />
        <span>{scope.label}{on ? " — ON" : ""}</span>
        <Msg msg={msg} />
      </label>
      <Note>
        {scope.agent === "*"
          ? "On = no agent starts a conversation with you: no briefs, no trip posts, no nudges. Your replies to a message you send still work, and nothing is lost — held items are reconsidered when you switch it off."
          : heldByGlobal
            ? `On for ${scope.label.toLowerCase()} either way — the global switch above is on, and do-not-disturb is an OR across scopes.`
            : `On = only ${scope.label} stays quiet. The other agents carry on.`}
      </Note>
    </div>
  );
}

export function DndSection({ scopes }: { scopes: DndScope[] }) {
  return (
    <div className="card" style={{ padding: 12, marginTop: 8, maxWidth: 720 }}>
      {scopes.map((s) => <DndRow key={s.agent} scope={s} />)}
    </div>
  );
}

// ── Quiet hours ────────────────────────────────────────────────────────────────────────────────

function QuietRow({ scope }: { scope: QuietScope }) {
  // The EFFECTIVE window, not the stored one: a hand-edited 05:00–06:00 is not what the fleet runs,
  // and pre-filling the input with it would invite a save that changes nothing an owner can see.
  const [startAt, setStart] = useState(scope.quietStart);
  const [endAt, setEnd] = useState(scope.quietEnd);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, save] = useTransition();

  function submit() {
    setMsg(null);
    save(async () => {
      let r: SaveResult;
      try { r = await saveQuietHours({ door: scope.door, quietStart: startAt, quietEnd: endAt }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "saved" } : { ok: false, text: r.message });
    });
  }

  return (
    <tr>
      <td className="mono" style={{ fontSize: 12 }}>
        {scope.label}
        {scope.isDefault && <span style={{ color: "var(--mist)" }}> · default</span>}
      </td>
      <td><input style={inp} type="time" value={startAt} onChange={(e) => setStart(e.target.value)} aria-label={`${scope.label} quiet from`} /></td>
      <td><input style={inp} type="time" value={endAt} onChange={(e) => setEnd(e.target.value)} aria-label={`${scope.label} quiet until`} /></td>
      <td>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={btn} disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</button>
          <Msg msg={msg} />
          <Override note={scope.note} />
        </div>
      </td>
    </tr>
  );
}

export function QuietSection({ scopes }: { scopes: QuietScope[] }) {
  return (
    <table className="card" style={{ marginTop: 8 }}>
      <thead><tr><th>Door</th><th>Quiet from</th><th>Until</th><th /></tr></thead>
      <tbody>
        {scopes.map((s) => <QuietRow key={s.door} scope={s} />)}
      </tbody>
    </table>
  );
}

// ── Ceilings ───────────────────────────────────────────────────────────────────────────────────

export function CeilingSection({ values, engine }: {
  /** Each already re-validated against the engine by the page (see {@link EffectiveValue}). */
  values: {
    eventPerDoorPerDay: EffectiveValue<number>;
    escalationPerDoorPerDay: EffectiveValue<number>;
    perOwnerPerDay: EffectiveValue<number>;
  };
  engine: EngineMaxima;
}) {
  // Seeded with the EFFECTIVE numbers: a hand-edited 50 the kit clamps to 10 must not be the number
  // in the box, or an owner reads their own settings and is wrong about production.
  const [ev, setEv] = useState(values.eventPerDoorPerDay.value);
  const [esc, setEsc] = useState(values.escalationPerDoorPerDay.value);
  const [own, setOwn] = useState(values.perOwnerPerDay.value);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, save] = useTransition();

  const fields: Array<{ label: string; what: string; value: number; max: number; note: string | null; set(n: number): void }> = [
    {
      label: "Events per door per day", what: "A new email, a reply, a proposal — anything the world caused.",
      value: ev, max: engine.eventPerDoorPerDay, note: values.eventPerDoorPerDay.note, set: setEv,
    },
    {
      label: "Escalations per door per day", what: "Second and later nudges about the same unanswered thing.",
      value: esc, max: engine.escalationPerDoorPerDay, note: values.escalationPerDoorPerDay.note, set: setEsc,
    },
    {
      label: "Messages per day, all doors", what: "The whole day's budget across events and escalations. Scheduled slots (the briefs) never count.",
      value: own, max: engine.perOwnerPerDay, note: values.perOwnerPerDay.note, set: setOwn,
    },
  ];

  function submit() {
    setMsg(null);
    save(async () => {
      let r: SaveResult;
      try { r = await saveCeilings({ door: "*", eventPerDoorPerDay: ev, escalationPerDoorPerDay: esc, perOwnerPerDay: own }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "saved" } : { ok: false, text: r.message });
    });
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8, display: "grid", gap: 12, maxWidth: 720 }}>
      {fields.map((f) => (
        <div key={f.label}>
          <label className="mono" style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              style={{ ...inp, width: 72 }} type="number" min={0} max={f.max} step={1}
              value={f.value} onChange={(e) => f.set(Number(e.target.value))}
            />
            <span>{f.label}</span>
            <span style={{ color: "var(--mist)" }}>engine max {f.max}</span>
            <Override note={f.note} />
          </label>
          <Note>{f.what}</Note>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button style={btn} disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save ceilings"}</button>
        <Msg msg={msg} />
      </div>
      <Note>A ceiling can only be lowered. Above the engine maximum the save is refused, not quietly trimmed.</Note>
    </div>
  );
}
