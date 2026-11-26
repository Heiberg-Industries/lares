"use client";
/**
 *  — the owner's three knobs on the proactivity gate.
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
import { Field, Notice, Row, Rows } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { CardContent } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
import { Switch } from "@lares/ui/primitives/switch";
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

type Message = { ok: boolean; text: string } | null;

function Msg({ msg }: { msg: Message }) {
  if (!msg) return null;
  return <Notice tone={msg.ok ? "success" : "error"}>{msg.text}</Notice>;
}

/** The engine-disagrees annotation. Shown as the warning message, never hidden: a stored value the
 *  fleet is overriding is the one thing this page must not let an owner read as truth. */
function Override({ note }: { note: string | null }) {
  if (!note) return null;
  return <Notice tone="needs-you">{note}</Notice>;
}

// ── Do not disturb ─────────────────────────────────────────────────────────────────────────────

function DndRow({ scope }: { scope: DndScope }) {
  const [on, setOn] = useState(scope.dnd);
  const [msg, setMsg] = useState<Message>(null);
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
      if (r.ok) setMsg({ ok: true, text: next ? `Saved. ${scope.label} will not start anything.` : `Saved. Do not disturb is off for ${scope.label.toLowerCase()}.` });
      else { setOn(prev); setMsg({ ok: false, text: `Not saved, and the switch is back where it was. ${r.message}` }); }
    });
  }

  return (
    <Row
      title={scope.label}
      description={
        scope.agent === "*"
          ? "When on, no agent starts a conversation with you: no briefs, no nudges. Your replies to a message you send still work, and nothing is lost: what was held is looked at again when you switch it off."
          : heldByGlobal
            ? `Quiet either way: the switch for every agent above is on, and that covers ${scope.label.toLowerCase()} too.`
            : `When on, only ${scope.label} stays quiet. The other agents carry on.`
      }
      control={<Switch aria-label={`Do not disturb: ${scope.label}`} checked={on} disabled={pending} onCheckedChange={toggle} />}
    >
      <Msg msg={msg} />
    </Row>
  );
}

export function DndSection({ scopes }: { scopes: DndScope[] }) {
  return (
    <Rows label="Do not disturb">
      {scopes.map((s) => <DndRow key={s.agent} scope={s} />)}
    </Rows>
  );
}

// ── Quiet hours ────────────────────────────────────────────────────────────────────────────────

function QuietRow({ scope }: { scope: QuietScope }) {
  // The EFFECTIVE window, not the stored one: a hand-edited 05:00–06:00 is not what the fleet runs,
  // and pre-filling the input with it would invite a save that changes nothing an owner can see.
  const [startAt, setStart] = useState(scope.quietStart);
  const [endAt, setEnd] = useState(scope.quietEnd);
  const [msg, setMsg] = useState<Message>(null);
  const [pending, save] = useTransition();

  function submit() {
    setMsg(null);
    save(async () => {
      let r: SaveResult;
      try { r = await saveQuietHours({ door: scope.door, quietStart: startAt, quietEnd: endAt }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.message });
    });
  }

  return (
    <Row title={<>{scope.label}{scope.isDefault && <span className="lares-muted"> · default</span>}</>}>
      <div className="lares-stack">
        <div className="lares-inline-form">
          <Field label="Quiet from">
            <Input type="time" value={startAt} onChange={(e) => setStart(e.target.value)} aria-label={`${scope.label} quiet from`} />
          </Field>
          <Field label="Until">
            <Input type="time" value={endAt} onChange={(e) => setEnd(e.target.value)} aria-label={`${scope.label} quiet until`} />
          </Field>
          <Button type="button" variant="outline" disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save"}</Button>
        </div>
        <Override note={scope.note} />
        <Msg msg={msg} />
      </div>
    </Row>
  );
}

export function QuietSection({ scopes }: { scopes: QuietScope[] }) {
  return (
    <Rows label="Quiet hours">
      {scopes.map((s) => <QuietRow key={s.door} scope={s} />)}
    </Rows>
  );
}

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────

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
  const [msg, setMsg] = useState<Message>(null);
  const [pending, save] = useTransition();

  const fields: Array<{ label: string; what: string; value: number; max: number; note: string | null; set(n: number): void }> = [
    {
      label: "Events per door per day", what: "A new email, a reply, a proposal: anything the world caused.",
      value: ev, max: engine.eventPerDoorPerDay, note: values.eventPerDoorPerDay.note, set: setEv,
    },
    {
      label: "Escalations per door per day", what: "Second and later nudges about the same unanswered thing.",
      value: esc, max: engine.escalationPerDoorPerDay, note: values.escalationPerDoorPerDay.note, set: setEsc,
    },
    {
      label: "Messages per day, all doors", what: "The whole day's budget across events and escalations. Scheduled messages (the briefs) never count.",
      value: own, max: engine.perOwnerPerDay, note: values.perOwnerPerDay.note, set: setOwn,
    },
  ];

  function submit() {
    setMsg(null);
    save(async () => {
      let r: SaveResult;
      try { r = await saveCeilings({ door: "*", eventPerDoorPerDay: ev, escalationPerDoorPerDay: esc, perOwnerPerDay: own }); }
      catch (e) { r = { ok: false, message: String(e instanceof Error ? e.message : e) }; }
      setMsg(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.message });
    });
  }

  return (
    <>
      <Rows label="Limits">
        {fields.map((f) => (
          <Row
            key={f.label}
            title={f.label}
            description={`${f.what} Highest allowed: ${f.max}.`}
            control={
              <Input
                className="lares-short-input" type="number" min={0} max={f.max} step={1} aria-label={f.label}
                value={f.value} onChange={(e) => f.set(Number(e.target.value))}
              />
            }
          >
            <Override note={f.note} />
          </Row>
        ))}
      </Rows>
      <CardContent className="lares-stack">
        <p className="lares-muted">A limit can only be set at or below the highest allowed. A higher number is refused when you save, not quietly lowered.</p>
        <Button type="button" variant="outline" disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save limits"}</Button>
        <Msg msg={msg} />
      </CardContent>
    </>
  );
}
