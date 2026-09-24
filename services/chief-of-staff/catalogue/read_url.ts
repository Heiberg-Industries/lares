// Read the readable text of a web link via the shared readability worker. See
// @lares/agent-kit/readability-client for the ORB-51 posture (ReadabilityNoContentError vs
// ReadabilityUnavailableError).
//
// ORB-289 / ORB-286 round 5: a Notion link goes to the Notion API instead (lib/notion-page.ts) —
// the worker cannot sign in, and used to answer "fetch failed", which read as "the reader is down".
//
// W3A-s5 — TAINTS AFTER THE READ, NEVER BEFORE. A successful read brings back words Bendik did
// not write, so the turn it ran in is marked (docs/specs/2026-09-18-origin-model-design.md,
// "The in-turn taint rule"): the web and Google Docs branches are `third_party`; the Notion
// branch is `synced`, the spec's own answer to its fourth open question
// (origin-model-design.md:256-258) about whether a live Notion read earns the lower bar — taken
// as given, not re-argued here. A failed call taints nothing (the `await` throws before the
// taint line runs). UNTESTED INTERACTION, recorded rather than fixed: `read_url` also stays in
// `agent/hooks/origin-taint.ts`'s TAINTING_TOOLS as a blanket `third_party` (a hook cannot see
// which branch ran), and `taintTurn` only ever narrows — so if that hook's `action.result` event
// fires after this tool's own `synced` write, the turn ends up `third_party` regardless. Whether
// `read_url` should leave the hook's map entirely is a bigger cut than this slice makes.
//
// W7D-s3 — A LINK MET AFTER SOMEBODY ELSE'S WORDS ASKS FIRST. This tool is the one remaining path
// from untrusted TEXT to an outbound REQUEST: every file/shell/web tool in `agent/tools/` is a
// `disableTool()` sentinel, and this worker will fetch any host. So the approval policy is
// `asksAfterUntrustedText()` — not the permissions board. It reads the SAME per-turn taint record
// waves 3–4 built (no second heuristic), and so it asks only in a turn that has already read
// mail, a synced page or another web page; an ordinary "read this link I just sent you" is one
// call with no card, exactly as before (owner decision D1). A turn it cannot identify asks.
//
// The policy runs in the ORIGINAL turn, before eve parks on the card — which is the only place
// the taint is still readable: the harness ends the turn at the park point and the continuation
// arrives as a brand-new turn id, so `execute` below can never see it.
//
// AND THE CARD IS RE-CHECKED WHERE THERE WAS ONE. `assertApproval` (W7A-s6) answers the two
// questions eve does not: WHO tapped, and WHICH card they tapped (same arguments, still fresh).
// It runs only when a card was actually raised for THIS call — the `approval_asks` row W7A-s4's
// hook wrote at `input.requested`. An untainted read parks on nothing, so there is no row, and
// the call is byte-for-byte the call it was before this slice: no approver check, no ledger
// refusal. Making it unconditional instead would refuse a link opened in a session nobody tapped
// anything in — a schedule with no declared approver, for instance — which is a behaviour change
// this slice does not want and owner decision D1 does not ask for.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { readUrl, readUrlModelOutput } from "@lares/agent-kit/readability-client";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { asksAfterUntrustedText, TAINTED_FETCH_REASON } from "@lares/agent-kit/tainted-approval";
import { approvalLedger, callIdFrom } from "@lares/agent-kit/approval-ledger";
import { assertApproval } from "../lib/approvals.js";
import { notionPageIdFromUrl, readNotionPage } from "../lib/notion-page.js";
import { googleDocFromUrl, readGoogleDoc } from "../lib/google-doc.js";
import { driveApisFor } from "../lib/google-drive.js";

/**
 * Was a card raised for this exact call?
 *
 * The `approval_asks` row is the durable record of the park, keyed on the call id — the one
 * identity that survives it. Anything unreadable (no call id, box 086 not applied, the database
 * down) answers "no card", which is the same direction `assertApprovedCall` already documents:
 * evidence never fails an action. `askForCall` swallows its own errors; `getPool()` is called
 * outside that, so it is wrapped here too.
 */
async function cardWasRaised(ctx: unknown): Promise<boolean> {
  const callId = callIdFrom(ctx);
  if (callId === undefined) return false;
  try {
    return (await approvalLedger().ask(callId)) !== null;
  } catch {
    return false;
  }
}

export default defineTool({
  description:
    "Read a web link (e.g. one Bendik sent), read-only. A web page comes back as its title + " +
    "body text, a link to a PDF as its text, and a picture (JPEG/PNG/GIF/WebP) as the image " +
    "itself, which you can look at. A notion.so / notion.site link is read through the Notion " +
    "API instead and works for pages shared with Saga's Notion integration. A Google Docs / " +
    "Sheets / Slides / Drive link is read through Bendik's own Google accounts (read-only). " +
    "Name failures " +
    "honestly: ReadabilityUnavailableError = the reader service is down; ReadabilityTargetError " +
    "= the reader is fine but couldn't fetch THAT link (the reason is in the message); " +
    "ReadabilityNoContentError = a page with no usable article text (paywall stub, listing); " +
    "NotionPageUnavailableError = a Notion page not shared with the integration; " +
    "GoogleDocUnavailableError = a Google document not reachable (the reason says why). " +
    `Opening a link can ask the owner first: ${TAINTED_FETCH_REASON}.`,
  inputSchema: z.object({ url: z.string() }),
  // `input`, not `{ url }`: `assertApproval` fingerprints the RAW first argument, and a
  // destructured-and-rebuilt object hashes differently from the one the card was shown (W7A-s6).
  async execute(input, ctx) {
    if (await cardWasRaised(ctx)) await assertApproval(ctx, "read_url", input);
    const { url } = input;
    if (notionPageIdFromUrl(url)) {
      const result = await readNotionPage(url);
      const k = turnKeyFrom(ctx);
      if (k) taintTurn(k, "synced");
      return result;
    }
    if (googleDocFromUrl(url)) {
      const result = await readGoogleDoc(url, { apis: () => driveApisFor() });
      const k = turnKeyFrom(ctx);
      if (k) taintTurn(k, "third_party");
      return result;
    }
    const result = await readUrl(url);
    const k = turnKeyFrom(ctx);
    if (k) taintTurn(k, "third_party");
    return result;
  },
  approval: asksAfterUntrustedText(),
  toModelOutput: readUrlModelOutput,
});
