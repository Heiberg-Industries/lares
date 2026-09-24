// Add a manual (or otherwise-sourced) deadline. UNGATED — Decision (ORB-180 plan): a wrong
// add costs a line in a brief, which is a cheap enough mistake that a card would only add
// friction. Contrast `deadline_mint_statutory`/`done`/`dismiss`, all gated: a wrong MINT
// scatters a whole year's worth of wrong lines, and a wrong close/dismiss can end in a real
// penalty or hide a filing that was never actually done.
//
// UNGATED IS NOT UNATTRIBUTED (review fix, ORB-180). `agent/tools/remember.ts`'s header states
// the rule this tool broke: the 08:00 brief runs as the APP principal with no human on the turn,
// and its own Frister block literally prints `legg til (deadline_add fromThreadId …)` beside every
// candidate. A model reading its own brief could therefore add rows nobody asked for, and stamp
// the candidate resolved on the way past. `humanTurnRefusal` requires an allowlisted HUMAN on
// `ctx.session.auth.current` — the same check every gated tool here makes — and the brief's
// REPORT ONLY line now names this tool too, so the model is told as well as blocked.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { daysToDue } from "@lares/agent-kit/deadlines";
import { ownerDay } from "@lares/agent-kit/proactivity";
import { humanTurnRefusal } from "../lib/approvals.js";
import { createDeadline, resolveCandidate } from "../lib/deadlines-store.js";
import { ownerId } from "../lib/principals.js";
import { ownerTz } from "../lib/owner-clock.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** A real calendar date, not merely digits in the right shape — `2026-02-30` matches the
 *  regex above but round-trips to March 2nd through `Date.UTC`, which is exactly the silent
 *  drift a deadline date must never suffer. */
function isValidCalendarDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, mo, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export default defineTool({
  description:
    "Add a deadline to the owner's standing calendar of what the business owes an institution " +
    "by a date. `dueDate` is YYYY-MM-DD (compute it from the conversation — this tool does no " +
    "natural-language date parsing) and must not be in the past. `source` defaults to " +
    "'manual'; use 'statutory' only for a rule minted via `deadline_mint_statutory`, and " +
    "'renewal' for something paid to keep (a domain, a certificate, a subscription, insurance). " +
    "Pass `fromThreadId` when this add resolves a mail-scanner candidate, so it stops being " +
    "surfaced again. `vendor`, `amount` and `currency` record who is paid and how much — meant " +
    "for a renewal, but accepted on any source.",
  inputSchema: z.object({
    entity: z.string().min(1),
    title: z.string().min(1),
    dueDate: z.string(),
    source: z.enum(["statutory", "accounting", "contract", "subscription", "manual", "renewal"]).optional(),
    recurrence: z.enum(["none", "yearly", "bimonthly", "monthly"]).optional(),
    consequence: z.string().optional(),
    evidenceRule: z.string().optional(),
    fromThreadId: z.string().optional(),
    vendor: z.string().min(1).optional(),
    amount: z.number().positive().optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/u, "currency must be three letters").optional(),
  }),
  async execute({ entity, title, dueDate, source, recurrence, consequence, evidenceRule, fromThreadId, vendor, amount, currency }, ctx) {
    // WHO is asking, before WHAT is due: a deadline nobody asked for is a line in every brief.
    const notHim = humanTurnRefusal(
      ctx.session?.auth,
      "A deadline is added because Bendik asked for it on this turn.",
    );
    if (notHim) return { added: false as const, message: notHim };

    if (!isValidCalendarDate(dueDate)) {
      throw new Error(`deadline_add: dueDate "${dueDate}" is not a valid YYYY-MM-DD calendar date`);
    }

    const tz = await ownerTz();
    const now = new Date();

    // Same clock trick as `remind_set`'s past-`dueAt` guard: the model has no clock of its
    // own, so the error carries today's date on the OWNER's day, and the model recomputes on
    // retry rather than being told merely "invalid".
    if (daysToDue(dueDate, now, tz) < 0) {
      const today = ownerDay(now, tz);
      throw new Error(
        `deadline_add: dueDate "${dueDate}" is in the past. Today is ${today} (${tz}) — ` +
          `recompute dueDate from this and call again.`,
      );
    }

    const pool = getPool();
    const owner = ownerId();
    const row = await createDeadline(pool, {
      owner,
      entity,
      title,
      source: source ?? "manual",
      dueDate,
      recurrence,
      consequence,
      evidenceRule,
      createdBy: "user",
      vendor,
      amount,
      // Stored upper-case regardless of how the model cased it — the schema only checks the
      // shape (three letters), never the case, so this is the one place currency is normalised
      // before it reaches `deadlines_currency_check`.
      currency: currency?.toUpperCase(),
    });

    if (fromThreadId !== undefined) {
      await resolveCandidate(pool, owner, fromThreadId, "added");
    }

    return { added: true as const, id: row.id, dueDate: row.dueDate, daysToDue: daysToDue(row.dueDate, now, tz) };
  },
});
