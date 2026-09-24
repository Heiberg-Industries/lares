"use client";
/**
 * ORB-180 — the owner's controls on `/deadlines`: the ladder switch, per-row Done/Dismiss/Bring
 * back, the Add form, the statutory-year mint form, and a candidate's Add/Ignore.
 *
 * Shaped like `ProactivityControls.tsx`: every write reports `{ ok }|{ ok: false, message }` and a
 * refused save never leaves the row silently unchanged from what the owner sees — a checkbox or
 * input left in its optimistic state after a failed write is a lie about production.
 *
 * No `lib/deadlines.ts` import here: that module reaches the database (`pool`), and a client
 * component may not pull that in (the same reasoning `ProactivityControls.tsx`'s header states).
 * Every prop below is plain, JSON-serialisable data the server page has already computed — the one
 * exception is `lib/deadline-date.ts`'s `ruleDueDate`, which the mint form below needs to grey rules
 * already past; that module has no pool and nothing else in it, so it is safe for the client bundle.
 */
import { useState, useTransition } from "react";
import {
  addDeadline, addFromCandidate, dismiss, ignoreCandidate, markDone, mintStatutoryYear, resetRung,
  saveLadderEnabled,
} from "../app/actions/deadlines";
import { ruleDueDate } from "../lib/deadline-date";

const inp = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 8px",
  fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--card)", color: "var(--ink)",
} as const;

const btn = {
  border: "1px solid var(--rule)", borderRadius: 4, padding: "4px 10px",
  background: "var(--signal)", color: "#fff", cursor: "pointer", fontSize: 12,
} as const;

const btnQuiet = {
  ...btn, background: "var(--card)", color: "var(--ink)",
} as const;

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <span className="mono" style={{ fontSize: 12, color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</span>;
}

// ── Ladder ─────────────────────────────────────────────────────────────────────────────────────

export function LadderSwitch({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function toggle(next: boolean) {
    const prev = on;
    setOn(next);
    setMsg(null);
    start(async () => {
      const r = await saveLadderEnabled({ enabled: next }).catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) setMsg({ ok: true, text: next ? "on" : "off" });
      else { setOn(prev); setMsg({ ok: false, text: r.message }); }
    });
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8, maxWidth: 720 }}>
      <label className="mono" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline" }}>
        <input type="checkbox" checked={on} disabled={pending} onChange={(e) => toggle(e.target.checked)} />
        {/* Both states are STATED (review fix): a bare "Escalation ladder" beside an unchecked box
            reads as a label whose value failed to render, not as a switch that is off. */}
        <span>Escalation ladder{on ? " — ON" : " — OFF"}</span>
        <Msg msg={msg} />
      </label>
    </div>
  );
}

// ── Open table row ─────────────────────────────────────────────────────────────────────────────

export interface OpenDeadlineRow {
  id: string;
  entity: string;
  title: string;
  dueDate: string;
  days: number;
  colorToken: "bad" | "warn" | null;
  source: string;
  rung: number;
  consequence: string | null;
  /** LAR-22 — who is paid and how much. */
  vendor: string | null;
  amount: number | null;
  currency: string | null;
}

/** `"Domeneshop, 199 NOK"` / `"Domeneshop"` / `"199 NOK"` / `"—"` — same composition rule as the
 *  brief's `vendorAmountClause` (`services/chief-of-staff/lib/brief-content.ts`), restated here
 *  rather than shared: this is a client component and that file is not client-safe. */
function vendorAmountLabel(row: OpenDeadlineRow): string {
  const parts: string[] = [];
  if (row.vendor) parts.push(row.vendor);
  if (row.amount !== null) parts.push(row.currency ? `${row.amount} ${row.currency}` : String(row.amount));
  else if (row.currency) parts.push(row.currency);
  return parts.length > 0 ? parts.join(", ") : "—";
}

function colorFor(token: "bad" | "warn" | null): string | undefined {
  if (token === "bad") return "var(--bad)";
  if (token === "warn") return "var(--warn)";
  return undefined;
}

export function OpenRow({ row }: { row: OpenDeadlineRow }) {
  const [gone, setGone] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [showDismiss, setShowDismiss] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (gone) return null;
  const color = colorFor(row.colorToken);

  function submitDone() {
    setMsg(null);
    start(async () => {
      const r = await markDone({ id: row.id, evidence }).catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) setGone(true);
      else setMsg({ ok: false, text: r.message });
    });
  }

  function submitDismiss() {
    setMsg(null);
    start(async () => {
      const r = await dismiss({ id: row.id, reason }).catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) setGone(true);
      else setMsg({ ok: false, text: r.message });
    });
  }

  function bringBack() {
    setMsg(null);
    start(async () => {
      const r = await resetRung({ id: row.id }).catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      setMsg(r.ok ? { ok: true, text: "rung reset" } : { ok: false, text: r.message });
    });
  }

  return (
    <tr>
      <td className="mono" style={{ fontSize: 12 }}>{row.entity}</td>
      <td style={{ fontSize: 13 }}>{row.title}</td>
      <td className="mono" style={{ fontSize: 12, color }}>{row.dueDate}</td>
      <td className="mono" style={{ fontSize: 12, color }}>{row.days}</td>
      <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{row.source}</td>
      <td className="mono" style={{ fontSize: 12 }}>{row.rung}</td>
      <td style={{ fontSize: 12, color: "var(--mist)" }}>{row.consequence ?? "—"}</td>
      <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{vendorAmountLabel(row)}</td>
      <td>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button style={btnQuiet} disabled={pending} onClick={() => { setShowDone((v) => !v); setShowDismiss(false); }}>Done</button>
            <button style={btnQuiet} disabled={pending} onClick={() => { setShowDismiss((v) => !v); setShowDone(false); }}>Dismiss</button>
            {row.rung > 0 && <button style={btnQuiet} disabled={pending} onClick={bringBack}>Bring back</button>}
          </div>
          {showDone && (
            <div style={{ display: "flex", gap: 6 }}>
              <input style={inp} placeholder="Evidence (required)" value={evidence} onChange={(e) => setEvidence(e.target.value)} aria-label={`Evidence for ${row.title}`} />
              <button style={btn} disabled={pending} onClick={submitDone}>Confirm done</button>
            </div>
          )}
          {showDismiss && (
            <div style={{ display: "flex", gap: 6 }}>
              <input style={inp} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Dismiss reason for ${row.title}`} />
              <button style={btn} disabled={pending} onClick={submitDismiss}>Confirm dismiss</button>
            </div>
          )}
          <Msg msg={msg} />
        </div>
      </td>
    </tr>
  );
}

// ── Add ────────────────────────────────────────────────────────────────────────────────────────

const SOURCES = ["statutory", "accounting", "contract", "subscription", "manual", "renewal"] as const;
const RECURRENCES = ["none", "yearly", "bimonthly", "monthly"] as const;

export function AddForm() {
  const [entity, setEntity] = useState("");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [source, setSource] = useState<(typeof SOURCES)[number]>("manual");
  const [recurrence, setRecurrence] = useState<(typeof RECURRENCES)[number]>("none");
  const [consequence, setConsequence] = useState("");
  // LAR-22 — who is paid and how much. Kept as plain strings (not a number) the same way
  // `fiscalYear` below is not: `amount` is parsed to a number only at submit time, so an
  // in-progress "19" or "" never fights the input's own validity state.
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const isRenewal = source === "renewal";

  function submit() {
    setMsg(null);
    start(async () => {
      const r = await addDeadline({
        entity, title, dueDate, source, recurrence, consequence,
        vendor: vendor.trim() || undefined,
        amount: amount.trim() ? Number(amount) : undefined,
        currency: currency.trim() || undefined,
      }).catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) {
        setEntity(""); setTitle(""); setDueDate(""); setConsequence("");
        setVendor(""); setAmount(""); setCurrency("");
        setMsg({ ok: true, text: "added" });
      } else setMsg({ ok: false, text: r.message });
    });
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", maxWidth: 900 }}>
      <input style={inp} placeholder="Entity" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entity" />
      <input style={inp} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      <input style={inp} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" />
      <select style={inp} value={source} onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])} aria-label="Source">
        {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select style={inp} value={recurrence} onChange={(e) => setRecurrence(e.target.value as (typeof RECURRENCES)[number])} aria-label="Recurrence">
        {RECURRENCES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <input style={{ ...inp, minWidth: 200 }} placeholder="Consequence (optional)" value={consequence} onChange={(e) => setConsequence(e.target.value)} aria-label="Consequence" />
      {isRenewal && (
        <>
          <input style={inp} placeholder="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor" />
          <input style={{ ...inp, width: 90 }} type="number" step="0.01" min="0" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
          <input style={{ ...inp, width: 60 }} placeholder="NOK" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency" maxLength={3} />
        </>
      )}
      <button style={btn} disabled={pending} onClick={submit}>{pending ? "Adding…" : "Add"}</button>
      <Msg msg={msg} />
    </div>
  );
}

// ── Mint a statutory year ─────────────────────────────────────────────────────────────────────

export interface MintRule {
  key: string;
  title: string;
  standingDate: string;
  recurrence: string;
  consequence: string;
  /** The rule's calendar position, so the form can compute THIS year's date as the year field
   *  changes — `ruleDueDate` (`lib/deadline-date.ts`), the same formula `mintYearFromMirror` uses. */
  month: number;
  day: number;
  yearOffset: number;
}

export function MintForm({
  rules,
  defaultYear,
  today,
}: {
  rules: readonly MintRule[];
  defaultYear: number;
  /** The owner's day, `YYYY-MM-DD` — the line the greyed rows sit behind. */
  today: string;
}) {
  const [entity, setEntity] = useState("");
  const [fiscalYear, setFiscalYear] = useState(defaultYear);
  const [included, setIncluded] = useState<Record<string, boolean>>(() => Object.fromEntries(rules.map((r) => [r.key, true])));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function toggle(key: string) {
    setIncluded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function submit() {
    setMsg(null);
    const omit = rules.filter((r) => !included[r.key]).map((r) => r.key);
    start(async () => {
      const r = await mintStatutoryYear({ entity, fiscalYear, omit })
        .catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) {
        const past = r.skippedPast.length > 0 ? `, ${r.skippedPast.length} already past (${r.skippedPast.join(", ")})` : "";
        setMsg({ ok: true, text: `minted ${r.inserted}, skipped ${r.skipped} already present${past}` });
      } else setMsg({ ok: false, text: r.message });
    });
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8, maxWidth: 900 }}>
      <p style={{ color: "var(--warn)", fontSize: 12, marginTop: 0 }}>
        Confirm each date against the authority before minting — these are the standing dates, not a feed.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <input style={inp} placeholder="Entity" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entity" />
        <input style={{ ...inp, width: 90 }} type="number" value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))} aria-label="Fiscal year" />
        <span style={{ color: "var(--mist)", fontSize: 12 }}>Jurisdiction: NO-AS</span>
      </div>
      <table>
        <thead><tr><th></th><th>Rule</th><th>Date</th><th>Recurrence</th><th>Consequence</th></tr></thead>
        <tbody>
          {rules.map((r) => {
            // Greyed, not hidden and not unchecked: the rule still belongs to the year, and an
            // owner who genuinely still owes a past term needs to see it named before adding it by
            // hand. The mint skips it either way — the checkbox has no say in that.
            const past = ruleDueDate(r, fiscalYear) < today;
            return (
              <tr key={r.key} style={past ? { opacity: 0.45 } : undefined}>
                <td><input type="checkbox" checked={included[r.key] ?? true} disabled={past} onChange={() => toggle(r.key)} aria-label={`Include ${r.title}`} /></td>
                <td style={{ fontSize: 12 }}>
                  {r.title}
                  {past && <span style={{ color: "var(--mist)" }}> — already past — add by hand if you still want it</span>}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>{r.standingDate}</td>
                <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{r.recurrence}</td>
                <td style={{ fontSize: 12, color: "var(--mist)" }}>{r.consequence}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <button style={btn} disabled={pending} onClick={submit}>{pending ? "Minting…" : "Mint this year"}</button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

// ── Candidates ─────────────────────────────────────────────────────────────────────────────────

export interface CandidateDTO {
  threadId: string;
  subject: string;
  sender: string;
  seenAtLabel: string;
  surfaced: boolean;
}

export function CandidateRow({ candidate }: { candidate: CandidateDTO }) {
  const [gone, setGone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [entity, setEntity] = useState("");
  const [title, setTitle] = useState(candidate.subject);
  const [dueDate, setDueDate] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (gone) return null;

  function submitAdd() {
    setMsg(null);
    start(async () => {
      const r = await addFromCandidate({ threadId: candidate.threadId, entity, title, dueDate })
        .catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) setGone(true);
      else setMsg({ ok: false, text: r.message });
    });
  }

  function submitIgnore() {
    setMsg(null);
    start(async () => {
      const r = await ignoreCandidate({ threadId: candidate.threadId, resolution: "ignored" })
        .catch((e) => ({ ok: false as const, message: String(e instanceof Error ? e.message : e) }));
      if (r.ok) setGone(true);
      else setMsg({ ok: false, text: r.message });
    });
  }

  return (
    <tr>
      <td style={{ fontSize: 13 }}>{candidate.subject}</td>
      <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{candidate.sender}</td>
      <td className="mono" style={{ fontSize: 12, color: "var(--mist)" }}>{candidate.seenAtLabel}</td>
      <td className="mono" style={{ fontSize: 12, color: candidate.surfaced ? "var(--mist)" : "var(--warn)" }}>
        {candidate.surfaced ? "surfaced" : "not yet surfaced"}
      </td>
      <td>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 260 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={btnQuiet} disabled={pending} onClick={() => setAdding((v) => !v)}>Add</button>
            <button style={btnQuiet} disabled={pending} onClick={submitIgnore}>Ignore</button>
          </div>
          {adding && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input style={inp} placeholder="Entity" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label={`Entity for ${candidate.subject}`} />
              <input style={inp} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label={`Title for ${candidate.subject}`} />
              <input style={inp} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label={`Due date for ${candidate.subject}`} />
              <button style={btn} disabled={pending} onClick={submitAdd}>Confirm add</button>
            </div>
          )}
          <Msg msg={msg} />
        </div>
      </td>
    </tr>
  );
}
