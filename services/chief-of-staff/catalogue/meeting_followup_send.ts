// Send a meeting follow-up to the participants. GATED unless Bendik has opted this meeting
// SERIES into autonomous sending (ORB-156).
//
// A distinct tool rather than a policy on `gmail_send`, deliberately: gmail_send's input
// carries no meeting or series identity, so a policy there would have to infer "this is the
// Folkepuls follow-up" from a subject line — and loosening gmail_send would loosen every
// email Saga ever sends, not just follow-ups.
//
// ⚠️ CAPABILITY NOTE: since ORB-156's follow-up-note wiring, `execute()` sends the email
// (`gmail`) AND writes a Twenty CRM note per recipient (`twenty`) via `createTwentyNote` — so
// this tool is deliberately declared under BOTH capabilities in
// tests/agent-declaration.test.ts's CAPABILITY_TOOLS (both granted `write-with-confirm` in
// agent.json). That double listing, not this comment, is what makes the CRM write auditable:
// someone reading the declaration sees `twenty` and knows this tool touches the CRM, without
// having to read its source. The note is folded into this tool rather than calling the gated
// `twenty_note` tool separately (which would demand a second approval per recipient for something
// that isn't a separate decision — see the CRM-note block below).
import { defineTool } from "eve/tools";
// eve 0.45.0 moved the capability-specific helpers off `eve/tools` and onto dedicated
// `eve/tools/*` entrypoints (CHANGELOG 0.45.0, 6252784). `ApprovalStatus` is the same type,
// re-exported from `node_modules/eve/dist/src/public/tools/approval/index.d.ts`; this is the
// subpath `packages/agent-kit/src/board-approval.ts` already imports it from.
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { assertApproval } from "../lib/approvals.js";
import { getPool } from "@lares/agent-kit/db";
import { KitRatchet, type AutonomyLevel } from "@lares/agent-kit/ratchet";
import { fingerprintRecipients, lastRecipientsFingerprint, recordSent } from "../lib/meeting-followup-store.js";
import { createTwentyNote } from "./twenty_note.js";
import { emitSignal } from "../lib/signal-emit.js";

export const FOLLOWUP_AGENT = "saga";
export const FOLLOWUP_CAPABILITY = "meeting_followup";

/**
 * Local-parts that mark a recipient as a shared/group inbox rather than a person (spec Q4:
 * "an alias hides who actually receives it, so it stays gated forever"). Deliberately
 * CONSERVATIVE and cannot be complete — every organisation invents its own aliases, and this
 * list can only ever be a sample of the common ones. It is matched case-insensitively against
 * the part before `@` only, and it fails toward ASKING, never toward sending: an unrecognised
 * alias just gets the ordinary ratchet-based treatment, the same as any personal address. If a
 * real alias is ever seen slipping through, add it here rather than trying to enumerate every
 * possible one up front.
 */
export const GROUP_ALIAS_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "post", "hei", "hello", "info", "kontakt", "team", "sales", "support", "admin",
  "noreply", "no-reply", "firmapost",
]);

/** Exported (finding-1-regression fix): `makeLiveSend`'s pre-check in
 *  agent/schedules/meeting-followup.ts imports this SAME function rather than
 *  re-implementing the rule, so the pre-check and this policy can never diverge on whether a
 *  recipient is an alias. See that file's own comment for why divergence there is now
 *  dangerous, not merely cosmetic. */
export function isGroupAlias(email: string): boolean {
  const at = email.indexOf("@");
  const localPart = (at === -1 ? email : email.slice(0, at)).trim().toLowerCase();
  return GROUP_ALIAS_LOCAL_PARTS.has(localPart);
}

/** The two facts the policy needs, injected so the decision is testable without a database. */
export interface FollowupApprovalDeps {
  level: (seriesKey: string) => Promise<AutonomyLevel>;
  lastFingerprint: (seriesKey: string) => Promise<string | null>;
}

/**
 * True only for eve's own documented schedule-dispatch principal (node_modules/eve/docs/
 * tools/human-in-the-loop.md, "Skipping approval for schedule-dispatched turns" — match all
 * three fields). `approverFrom`/`assertApprover` (lib/approvals.ts) refuse EVERY other shape,
 * including a fully-absent auth context — that refusal is a deliberate, security-reviewed
 * (2026-08-16) choice, not a gap this function may widen. A model cannot produce this exact
 * triple and an inbound payload cannot forge it: it is stamped by eve's own schedule
 * dispatcher, never by authored code.
 */
function isAppPrincipal(current: unknown): boolean {
  if (current === null || typeof current !== "object") return false;
  const c = current as { authenticator?: unknown; principalId?: unknown; principalType?: unknown };
  return c.authenticator === "app" && c.principalId === "eve:app" && c.principalType === "runtime";
}

/**
 * Decides, per call, whether this follow-up needs a human.
 *
 * RUNTIME, not build time — and that is the whole point. eve resolves the agent-kit
 * extension's autonomy levels once per `eve build` and bakes them into the image (ORB-144).
 * A per-series level read there would mean flipping the switch in the Console changes
 * nothing until the next redeploy, silently. This function runs on every tool call.
 *
 * Fail-closed in all three directions: no series id, an unreadable ratchet, or a recipient
 * set that differs from the last approved send all return `user-approval`.
 */
export function followupApproval(deps: FollowupApprovalDeps) {
  return async (ctx: { toolInput?: unknown }): Promise<ApprovalStatus> => {
    const input = (ctx.toolInput ?? {}) as { seriesKey?: unknown; to?: unknown; forceApproval?: unknown };
    const seriesKey = typeof input.seriesKey === "string" ? input.seriesKey : "";
    const to = Array.isArray(input.to) ? input.to.filter((r): r is string => typeof r === "string") : [];
    if (input.forceApproval === true) return "user-approval";

    // A group/alias recipient (post@, hei@, …) hides who actually receives the mail — spec Q4
    // rules that keeps the series GATED FOREVER. Checked before anything else, including the
    // ratchet, so a matching fingerprint or an opted-in series can never override it: without
    // this, a first autonomous send has no fingerprint baseline (`previous === null` below →
    // `approved`), and an opted-in series containing e.g. post@company.no would auto-send into
    // an unknown fan-out the very first time.
    if (to.some(isGroupAlias)) return "user-approval";

    // A one-off meeting has no series to opt in, so it is always a human decision. Checked
    // BEFORE the ratchet so a capability-wide default can never leak autonomy to it.
    if (seriesKey === "") return "user-approval";

    let level: AutonomyLevel;
    try {
      level = await deps.level(seriesKey);
    } catch (err) {
      console.error("meeting_followup_send: ratchet unreadable, falling back to gated:", err);
      return "user-approval";
    }

    if (level === "never") {
      return { type: "denied", reason: `Follow-ups are switched off for this meeting series (${seriesKey}).` };
    }
    if (level !== "autonomous") return "user-approval";

    // Opted in — but only for the people it was opted in FOR. A series that gains a
    // participant pauses ONCE; the opt-in itself is untouched, and approving resumes it.
    let previous: string | null;
    try {
      previous = await deps.lastFingerprint(seriesKey);
    } catch (err) {
      console.error("meeting_followup_send: send log unreadable, falling back to gated:", err);
      return "user-approval";
    }
    if (previous !== null && previous !== fingerprintRecipients(to)) return "user-approval";
    return "approved";
  };
}

export default defineTool({
  description:
    "Send a meeting follow-up email (summary + action items) to the meeting's participants. " +
    "Requires Bendik's approval unless he has switched this meeting series to auto-send.",
  inputSchema: z.object({
    notionPageId: z.string(),
    /** The calendar recurring-event id or a derived title/day key. "" is never auto-approvable. */
    seriesKey: z.string(),
    forceApproval: z.boolean().optional(),
    to: z.array(z.string()).min(1),
    subject: z.string(),
    bodyText: z.string(),
    /** Shown on the card so a wrong ORB-155 match is visible BEFORE anything sends. */
    meetingTitle: z.string(),
    meetingWhen: z.string(),
    from: z.string(),
    account: z.string().optional(),
  }),
  approval: followupApproval({
    level: (seriesKey) => new KitRatchet(getPool()).level(FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY, seriesKey),
    lastFingerprint: (seriesKey) => lastRecipientsFingerprint(getPool(), seriesKey),
  }),
  async execute(input, ctx) {
    // Re-check WHO approved — but only when a human could have. A send the policy approved
    // autonomously is dispatched by the app principal and has no tapper to verify: its
    // authority is the ratchet row a human wrote, which `approval` above already checked on
    // THIS call. Asserting an approver there would refuse exactly the case the ratchet exists
    // to enable. The exemption is the app principal and nothing else, so absence, an unknown
    // channel, and the wrong human all still refuse (security review 2026-08-16) — and a
    // human-approved resume arrives with `current: null` (Telegram) or the clicker's own auth
    // (Slack), neither of which is the app, so it takes the strict `assertApprover` path.
    if (!isAppPrincipal(ctx.session.auth?.current)) {
      await assertApproval(ctx, "meeting_followup_send", input);
    }

    const gmail = await googleClients().gmail(input.account);
    let signatureHtml: string | undefined;
    try {
      signatureHtml = await gmail.getSignature(input.from);
    } catch (err) {
      // A signature is presentation, never a reason to lose an approved follow-up.
      console.error("meeting_followup_send: Gmail signature unavailable — sending without it", err);
    }
    const result = await gmail.send({
      from: input.from,
      to: input.to,
      subject: input.subject,
      bodyText: input.bodyText,
      ...(signatureHtml ? { signatureHtml } : {}),
    });

    // ORB-156 fix round 2 (CRITICAL): this is the ONLY place that may record a "sent"
    // outcome — this line runs only once the send above has genuinely resolved, and only
    // when execute() runs at all means the send was authorised (approved, or autonomous).
    // The schedule that calls this tool cannot make the same claim: its own session-send
    // resolves once the model's TURN ends, which for a gated call is the moment the approval
    // card renders, not the moment (if ever) a human taps approval — recording "sent" there made a
    // declined or never-clicked card look permanently done, with no retry and no signal.
    // A store failure here must not turn a real, successful send into something that LOOKS
    // failed to the caller — log and continue, the same containment every other caller of
    // this store uses (see meeting-followup.ts's own recordOutcome/recordSent wrapping).
    try {
      await recordSent(getPool(), input.notionPageId, input.seriesKey, input.to);
    } catch (err) {
      console.error(
        `meeting_followup_send: recordSent FAILED after a successful send for ${input.notionPageId} — ` +
        "the recipient-change safety check will not see this send",
        err,
      );
    }

    // CRM touchpoint (ORB-156 follow-up-note wiring): one note per recipient, each targeted
    // at that recipient's own address so it links to the right person rather than one note
    // fanned out to everyone. Unconditional — an autonomous send has no human approver to
    // fall back on, and that is exactly the case where nothing else records what happened
    // (see file header). The email has already left by this point, so a Twenty failure here
    // must never make a successful send look failed to the caller: catch per-recipient, log
    // with the page id, and keep going — the same containment recordSent uses just above.
    //
    // `requireResolvedPerson: true` (security-review fix): skip creating the note entirely
    // when the recipient doesn't resolve to a CRM person, rather than `createTwentyNote`'s
    // default of creating it unlinked. An unlinked note here would carry the FULL sent email
    // body with no way to ever find it again — every send to someone not yet in Twenty would
    // silently accrete one, on every send, forever, which is worse than no note at all. The
    // absence is logged instead, naming the recipient and the page id, so someone can add
    // that person to the CRM if they matter.
    const noteBody =
      `Meeting: ${input.meetingTitle}\n` +
      `Subject: ${input.subject}\n\n` +
      input.bodyText;
    const noteTitle = `Meeting follow-up sent — ${input.meetingTitle}`;
    for (const recipient of input.to) {
      try {
        const note = await createTwentyNote({
          target: recipient, body: noteBody, title: noteTitle, requireResolvedPerson: true,
        });
        if (note === null) {
          console.log(
            `meeting_followup_send: no CRM note for ${input.notionPageId} — recipient ` +
            `${recipient} does not resolve to a Twenty person`,
          );
        }
      } catch (err) {
        console.error(
          `meeting_followup_send: CRM note FAILED after a successful send for ${input.notionPageId} ` +
          `(recipient ${recipient}) — the send itself succeeded and is not affected`,
          err,
        );
        // Best-effort, same as recordSent's own failure path above: emitSignal never throws
        // (see lib/signal-emit.ts) and a failing signal spine must not affect the send
        // result. This is the ONLY trace on an autonomous send — no card, no Slack line —
        // so container logs alone are not enough to notice a persistently-failing CRM write.
        await emitSignal(
          "meeting-followup-crm-note-failed",
          `meeting-followup: CRM note failed for "${input.meetingTitle}" (${recipient})`,
          `pageId=${input.notionPageId} recipient=${recipient} error=${String(err)}`,
        );
      }
    }

    return result;
  },
});
