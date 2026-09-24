/**
 * catalogue/save_note.ts — an add-only note the agent may write mid-conversation (W4B-s5,
 * ADR-0018 rule 9's companion to the per-session core).
 *
 * WHAT THIS IS. Both model makers recommend a tool exactly this shape, because a conversation
 * can be interrupted at any time: a working note — "the owner prefers the summary first",
 * "waiting on the supplier's reply about X" — never a fact about the owner (`remember` is that
 * tool) and never a standing instruction.
 *
 * ADD-ONLY. There is no id in the input and no update path anywhere in this tool or in
 * `lib/agent-notes.ts` — a wrong or stale note is superseded by a newer one, never rewritten.
 *
 * NO ORIGIN ARGUMENT, EVER. The model is never asked, and never allowed, to say where a note
 * came from — that is computed by code: `const key = turnKeyFrom(ctx); const origin = key ?
 * stampFor("agent", key) : "third_party";`, the exact pattern WAVE-3-NOTES pins for every write
 * path. A note left on an ordinary turn is stamped `agent`; one left on a turn that has already
 * read someone else's words this turn (an email, a web page) is narrowed to `third_party`,
 * however the note is worded — and a turn whose key cannot be determined at all stamps
 * `third_party` too, the least trusted class, never the intended one (see
 * `@lares/agent-kit/origin-taint`'s header, "fails closed").
 *
 * THE WRITE STILL SUCCEEDS ON A TAINTED TURN — DELIBERATELY, UNLIKE `remember`. Owner decision
 * B3: a note is exactly where quoted material legitimately belongs, so refusing it would cost
 * the model its own working memory for no gain. The stamp is the answer, not a refusal.
 *
 * UNGATED, like `remember`: writing its own note reaches nobody outside this box. It does NOT
 * call `humanTurnRefusal` either, unlike `remember`/`forget` — a note is the agent's own, and a
 * scheduled turn with no owner present may legitimately want to leave one ("still waiting on X"
 * needs to survive past the brief that wrote it).
 *
 * NEVER READ BACK AS A FACT. `agent/instructions/standing-facts.ts` surfaces a session's OWN
 * notes on a later turn of the SAME conversation, and only the ones whose origin is safe to
 * reflect back — a `third_party`/`synced`-stamped note is kept, exactly as written, but is never
 * placed in front of the model again automatically, so outside text a turn happened to read can
 * never quietly re-enter the model's trusted context as "something I noted". Nothing reads a
 * note back in a LATER session yet — that is wave 5A's job.
 *
 * FAILS SOFT ON AN INSTALLATION THAT HAS NOT APPLIED 071. The model is told plainly, in one
 * sentence, and the turn carries on — nothing is thrown.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { stampFor, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { configuredOwnerId } from "../lib/identity-client.js";
import { AGENT_NOTE_KINDS, addNote, isMissingTableError, rejectNote } from "../lib/agent-notes.js";

export default defineTool({
  description:
    "Write down something you want to carry for the rest of this conversation — what you are " +
    "waiting on, what to watch, what to come back to. It is a note, not a rule: it never " +
    "overrides what the owner tells you, and it is never a fact about them — use `remember` " +
    "for that. A note about your own thinking may be shown back to you on a later turn of this " +
    "same conversation; one written just after reading someone else's words (an email, a page) " +
    "is still saved, but is never shown back to you automatically, so outside text can never " +
    "quietly become something you rely on. It sends nothing and tells nobody. One sentence, at " +
    "most 400 characters, and give it a kind: working, watch, or followup. There is no way to " +
    "edit or delete a note — if it is wrong or done, save a new one.",
  inputSchema: z.object({
    kind: z.enum(AGENT_NOTE_KINDS).describe("One of: working, watch, followup."),
    note: z.string().describe("One sentence, at most 400 characters."),
  }),
  async execute({ kind, note }, ctx) {
    const refusal = rejectNote(note);
    if (refusal) return { saved: false as const, message: refusal };

    // NARROWING ONLY, NEVER A REFUSAL — see the module header and Owner decision B3.
    const key = turnKeyFrom(ctx);
    const origin = key ? stampFor("agent", key) : "third_party";

    const sessionId = ctx.session?.id ?? "unknown";
    const turnId = ctx.session?.turn?.id ?? sessionId;

    try {
      await addNote(getPool(), {
        owner: configuredOwnerId(),
        agent: process.env["LARES_AGENT_NAME"] ?? "unknown",
        kind,
        note: note.trim(),
        origin,
        sessionId,
        turnId,
      });
      return { saved: true as const, message: "Noted." };
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      // DEPLOY FAIL-SOFT (this installation applies SQL by hand) — the same posture
      // `remember.ts`'s pre-005 fallback and `turn-capture.ts`'s missing-table warning take.
      return {
        saved: false as const,
        message:
          "Notes are not switched on for this installation yet — apply " +
          "services/box/sql/071_agent_notes.sql on this box. Nothing was written.",
      };
    }
  },
});
