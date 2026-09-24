// Record that a meeting follow-up's approval card was declined (LAR-28) — the other half of the
// dead end this ticket closes. `meeting_followup_send`'s own approval gate can only say yes or
// no; it has no way to write anything back once a human taps 👎. eve simply resumes THIS agent's
// own turn with the rejection and lets the conversation continue from there — see
// `agent/schedules/meeting-followup.ts`'s module header ("DENIED, AND WHY THE SCHEDULE DOES NOT
// WRITE IT") for why nothing else in this codebase can observe that decision at all: the
// schedule's own tick has long since finished waiting by the time a human actually taps.
//
// This tool's ONLY caller is that resumed turn. The schedule's own send-turn prompt
// (`buildSendTurnPrompt`, agent/schedules/meeting-followup.ts) tells the model, in the SAME turn
// it is asked to call `meeting_followup_send`, to call this — with the same `notionPageId` — if
// and only if that call comes back declined by a human. Nothing here re-checks that condition;
// the model is trusted the same way it is already trusted to compose the email in the first
// place, and a wrong or speculative call costs at most one page being reconsidered on a later
// tick, which the hash-diff check in `claimMeeting` would then refuse anyway if nothing actually
// changed.
//
// DELIBERATELY UNGATED, like `gmail_read`/`gmail_search`/`gmail_signature` (see the "gmail"
// capability doc, packages/agent-kit/src/persona/capability-docs.ts): it changes nothing a human
// can see from the outside — only this feature's own internal bookkeeping — so gating it would
// mean the declining tap itself has to be approved a SECOND time before it can even be written
// down.
//
// NARROWER THAN A BARE `recordOutcome` CALL, ON PURPOSE (LAR-28 review fix round 1): being
// ungated and model-callable means a confused or prompt-injected turn could call this against
// ANY notionPageId it has seen mentioned, not only the one it was just gated on. `recordOutcome`'s
// own guard is only `outcome <> 'sent'` — wide enough that such a call against a deliberately
// `'skipped'` (internal-only) meeting, or one already `'denied'`, would flip it to `'denied'`
// too, which then makes it re-readable and re-draftable the next time that page is edited for any
// reason. `recordDenial` (lib/meeting-followup-store.ts) is the narrow store function this tool
// actually calls: it only ever moves a `'queued'` row (a card genuinely pending an answer) or the
// in-flight `'error'` sentinel to `'denied'`, never creates a row, and never touches `'sent'`,
// `'skipped'` or an already-`'denied'` row. The `recorded` field this tool returns is exactly
// whether that row existed and changed — never a blind `true`.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { recordDenial } from "../lib/meeting-followup-store.js";

export default defineTool({
  description:
    "Record that Bendik declined a meeting follow-up's approval card. Call this with the same " +
    "notionPageId given to meeting_followup_send, and only immediately after that call comes " +
    "back denied or rejected by a human tap — never for a series switched off by policy, and " +
    "never speculatively. This does not send or delete anything, and it only actually changes " +
    "a card that is still pending an answer — it never affects a meeting already sent, already " +
    "skipped, or already recorded as declined. It only lets the next automatic pass tell a " +
    "declined card apart from one still awaiting an answer, so a later correction to the " +
    "meeting page can be picked up and re-drafted.",
  inputSchema: z.object({ notionPageId: z.string() }),
  async execute(input) {
    const recorded = await recordDenial(getPool(), input.notionPageId);
    return { recorded, notionPageId: input.notionPageId };
  },
});
