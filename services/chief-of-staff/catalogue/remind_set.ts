// Propose a new reminder. GATED WRITE — requires the owner to tap Approve on the card on every call.
//
// Deliberate scope boundary: this does NOT port `services/agent-runtime/lib/adapters/
// reminders/parse.ts`'s natural-language `parseWhen` (the old hand's "in 5 minutes" / "every
// weekday 09:00" text parser). The model itself computes `dueAt` (and `recurrence`, in the
// `daily:HH:MM` / `weekdays:HH:MM` / `weekly:<dow>:HH:MM` format `lib/recurrence.ts` consumes)
// from conversational context — the idiomatic pattern for an LLM tool, and it removes an
// entire parser's worth of surface this task would otherwise have to re-test. `remind_set`
// takes structured fields only.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { createReminder } from "../lib/reminders-store.js";
import { assertApproval } from "../lib/approvals.js";
import { primaryTelegramChatId } from "../lib/principals.js";
import { allowedSlackUserIds } from "../lib/slack-allowlist.js";
import { formatDateTimeIn } from "@lares/agent-kit/clock";
import { ownerTz } from "../lib/owner-clock.js";
import { approvalFor } from "../lib/board.js";
import { homeTzFromEnv } from "@lares/agent-kit/owner-clock";
import { agentName } from "../lib/agent-name.js";

// Matches `agent/tools/digest_run.ts`'s own AGENT constant: both write to shared Postgres
// tables (`reminders`, `digest_requests`) that the old runtime's own agent='chief-of-staff' rows also
// use, on the same `db` service.

const RECURRENCE_RE = /^(daily:\d{2}:\d{2}|weekdays:\d{2}:\d{2}|weekly:(mon|tue|wed|thu|fri|sat|sun):\d{2}:\d{2})$/;

/**
 * Default threadRef per door when the caller doesn't name one — the owner's own standing address
 * on that door, mirroring `services/agent-runtime/lib/adapters/reminders/wiring.ts`'s
 * `makeTargetResolver` (Slack → his DM/user id, Telegram → his chat id) and matching
 * `digest_run.ts`'s existing use of `allowedSlackUserIds[0]` as a Slack target.
 */
function defaultThreadRef(door: "slack" | "telegram"): string | undefined {
  if (door === "slack") return allowedSlackUserIds()[0];
  return primaryTelegramChatId();
}

export default defineTool({
  description:
    "Propose a new reminder for the owner (requires them to tap Approve on the card). `dueAt` is an ISO 8601 datetime " +
    "(compute it from the conversation — this tool does no natural-language time parsing). " +
    "`recurrence` is optional, one of daily:HH:MM, weekdays:HH:MM, or weekly:<dow>:HH:MM " +
    "(dow = mon/tue/wed/thu/fri/sat/sun), all in the owner's home time zone wall-clock time. `door` picks " +
    "slack or telegram for delivery; `threadRef` is optional and defaults to the owner's " +
    "standing address on that door. The result carries `dueAtLocal` — confirm THAT back to " +
    "the owner verbatim, never the relative words they used (\"tomorrow\"), so a wrong date is " +
    "visible to him immediately instead of agreeing with him and storing something else.",
  inputSchema: z.object({
    message: z.string(),
    dueAt: z.string(),
    recurrence: z.string().optional(),
    door: z.enum(["slack", "telegram"]),
    threadRef: z.string().optional(),
  }),
  approval: approvalFor("remind_set"),
  async execute(input, ctx) {
    await assertApproval(ctx, "remind_set", input);
    const { message, dueAt, recurrence, door, threadRef } = input;

    const trimmedMessage = message.trim();
    if (!trimmedMessage) throw new Error("remind_set: empty message");

    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) throw new Error(`remind_set: invalid dueAt "${dueAt}"`);

    // The model has no clock (a live finding: "in 3 minutes" arrived dated JUNE
    // 2025 — right wall-clock time, hallucinated date — and was instantly "due"). A past
    // dueAt is therefore always a model error, and the error message IS the clock: it
    // carries the current time so the model recomputes correctly on its retry. 90s of
    // grace absorbs honest clock skew and approval-card latency.
    const now = new Date();
    if (due.getTime() < now.getTime() - 90_000) {
      const homeTz = homeTzFromEnv();
      const homeNow = new Intl.DateTimeFormat("sv-SE", {
        timeZone: homeTz,
        dateStyle: "short",
        timeStyle: "short",
      }).format(now);
      throw new Error(
        `remind_set: dueAt "${dueAt}" is in the past. It is now ${homeNow} ${homeTz} ` +
          `(${now.toISOString()} UTC) — recompute dueAt from this and call again.`,
      );
    }

    if (recurrence !== undefined && !RECURRENCE_RE.test(recurrence)) {
      throw new Error(`remind_set: unrecognised recurrence "${recurrence}"`);
    }

    const resolvedThreadRef = (threadRef ?? "").trim() || defaultThreadRef(door);
    if (!resolvedThreadRef) {
      throw new Error(
        `remind_set: no threadRef given and no default address configured for door "${door}"`,
      );
    }

    const reminder = await createReminder(getPool(), {
      agent: agentName(),
      dueAt: due,
      recurrence: recurrence ?? null,
      payload: { text: trimmedMessage, door, threadRef: resolvedThreadRef },
      createdBy: "user",
    });

    return {
      id: reminder.id,
      dueAt: due.toISOString(),
      // The absolute rendering of what was ACTUALLY stored, on the OWNER's clock. An earlier
      // failure was invisible because the tool returned only a UTC ISO string and the model confirmed
      // "i morgen" — its own paraphrase of the request — while the row said three days later.
      //
      // final review: `ownerTz`, not Oslo. The turn's clock block already speaks the
      // owner's zone, so a confirmation on the home clock would have him told "Tuesday 21:00
      // (Europe/Oslo)" about a reminder his own phone will ring at 15:00 in another time zone. The
      // RECURRENCE stays on the home clock deliberately — `lib/recurrence.ts` computes every later
      // firing in Oslo wall-clock time, and the tool's own description says so.
      dueAtLocal: formatDateTimeIn(due, await ownerTz()),
      recurrence: recurrence ?? null,
      door,
      threadRef: resolvedThreadRef,
    };
  },
});
