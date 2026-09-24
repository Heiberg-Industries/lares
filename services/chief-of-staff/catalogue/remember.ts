/**
 * agent/tools/remember.ts — store something Bendik has told her, in his words (ORB-167).
 *
 * Ported in SHAPE from `services/travel/agent/tools/remember.ts` — an ungated, model-called
 * note-to-self, and the ONLY way a fact reaches the store — but not in storage: Marcel's facts
 * are about a trip and live in that trip's `trip.md`; Saga's are about Bendik and live in
 * `standing_facts` (`lib/standing-facts.ts`, `sql/002-standing-facts.sql`).
 *
 * UNGATED, deliberately. Every gated tool Saga has reaches something outside this box — an
 * email, a calendar invite, a CRM record, a Brain commit. Writing down what he just said reaches
 * nobody: it changes what SHE knows, not what the world sees. Putting an approval card in front
 * of "husk: jeg tar toget" would cost more of his attention than the correction it saves. Its
 * `agent.json` grant is therefore `memory: write` (renamed from `facts`, ORB-183) — an ungated write, which the declaration
 * conformance test (`tests/agent-declaration.test.ts`) checks per-tool.
 *
 * WHAT MAKES A ROW LEGITIMATE is a contract carried mostly by the description below, because
 * that is where it can be: no code can tell his sentence from a fluent paraphrase of it. Two
 * failures ARE mechanical, and `rejectFact` refuses both — an empty fact, and one that is true
 * only today ("I'm in Oslo until 14:00 today", said on 2026-08-25, which is precisely the
 * correction that must NOT become standing). A refusal comes back as a message, not a throw:
 * the model can requote him, and a bad memory never costs him the turn.
 *
 * A THIRD FAILURE IS MECHANICAL TOO, and was missed on the first pass (review fix): a turn with
 * NO HUMAN IN IT. Ungated does not mean unattributed. The 08:00 and 20:00 briefs run as the app
 * principal with no utterance of his anywhere in them, and their prompts now carry the standing
 * facts block plus "apply these" — so the model reading tomorrow's Travel row beside the train
 * fact has everything it needs to call `remember("he stays at Scandic before early flights")`,
 * which `rejectFact` would happily pass. The result is a sentence in SAGA's words living forever
 * under the heading "his own words" — the one thing this store must never hold. `humanTurnRefusal`
 * (lib/approvals.ts) therefore requires an allowlisted HUMAN on `ctx.session.auth.current`, the
 * same allowlist every gated tool here checks, and the brief prompts name both tools in their
 * REPORT ONLY line so the model is told as well as blocked.
 *
 * REPLACING A FACT IS THE SAME ACT, SO IT IS THE SAME TOOL (W4A-s2). `supersedes` names the fact
 * a new one closes, and both gates above stand in front of it unchanged: an unattended turn and
 * a turn that has read somebody else's words are refused BEFORE the id is ever looked at. That is
 * why closing a fact lives here rather than in its own tool — a second door would be a second
 * place to get those two checks right, and this store already has the one write path it wants.
 *
 * A FOURTH CHECK: WHAT WAS FORGOTTEN DOES NOT COME BACK BY ITSELF (W5B-s3, ORB-167 follow-up).
 * `forget` writes a one-way hash of the retired words into `forget_ledger`
 * (`@lares/agent-kit/forget-ledger`) so a later import or the nightly dream cannot quietly
 * reintroduce them. This tool is the other door those words could come back through, so it is
 * checked here too — but ONLY for a fresh fact (`supersedes` names an explicit replacement, which
 * is a decision the owner just made, not a resurrection) and only once (`evenThoughForgotten` is
 * the owner's one-step way to mean it anyway, once they have been told). A hit REFUSES with the
 * date it was forgotten, never with the forgotten words themselves — the ledger holds no words to
 * quote. When the owner does override, the ledger row is cleared in the SAME transaction that
 * writes the fact (`rememberFactClearingForgotten`), so the ledger can never go on contradicting
 * a standing fact that now says otherwise. A missing ledger table means no check was possible, so
 * it means no refusal — the same fail-open shape `forget` already uses.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { stampFor, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { isMissingLedgerTable, removeForgotten, wasForgotten } from "@lares/agent-kit/forget-ledger";
import { humanTurnRefusal } from "../lib/approvals.js";
import { configuredOwnerId } from "../lib/identity-client.js";
import {
  MAX_FACT_LENGTH,
  STANDING_FACT_CATEGORIES,
  UnknownFactError,
  forgetFact,
  isMissingColumnError,
  rejectFact,
  rememberFact,
  rememberFactClearingForgotten,
  supersedeFact,
  type StandingFact,
} from "../lib/standing-facts.js";

export default defineTool({
  description:
    "Remember something Bendik has just TOLD you, so he never has to say it twice. Store it " +
    "in HIS OWN WORDS, quoted from what he actually wrote this turn — never your summary of " +
    "it, never something you inferred from his calendar or his mail. If he did not say it, " +
    "there is nothing to remember. " +
    "Only STANDING things: a fact or preference that will still be true next week (\"jeg tar " +
    "alltid toget til Tønsberg\", \"en intro-samtale uten sted er alltid digital\"). Something " +
    "true for one day is NOT a standing fact — \"I'm in Oslo until 14:00 today\" is about " +
    "today, so use it this turn and let it go; storing it would make every future brief wrong. " +
    `Give the category (${STANDING_FACT_CATEGORIES.join(", ")}) and keep the fact to one ` +
    `sentence, at most ${MAX_FACT_LENGTH} characters. ` +
    "`people` and `places` are facts about someone or somewhere — say them plainly and they " +
    "belong on that person's or that place's page as well; `travel`, `schedule` and " +
    "`preference` are standing instructions about how to act, and they change what you do " +
    "rather than what you know. " +
    "This sends nothing and tells nobody — it is your own note, and it is the only way any " +
    "fact is remembered past this conversation, so never claim to have remembered something " +
    "without calling it. When a new fact replaces an old one, pass `supersedes` with the old " +
    "fact's id so the two stay linked — call `forget` only to retire a fact outright, with " +
    "nothing replacing it. If this comes back refused because the owner asked to forget it " +
    "before, tell them so plainly, in your own words — never quote wording back at them, because " +
    "none is kept — and only call this again with `evenThoughForgotten` once they have said, in " +
    "this conversation, that it is true again and should be kept.",
  inputSchema: z.object({
    fact: z
      .string()
      .describe("Bendik's own words, quoted from this conversation — not a paraphrase."),
    category: z.enum(STANDING_FACT_CATEGORIES),
    supersedes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "the id of the fact this replaces, from the block of what you have been told — use it " +
          "instead of calling `forget` and `remember` separately, so the two rows stay linked",
      ),
    evenThoughForgotten: z
      .boolean()
      .optional()
      .describe(
        "Set only when the owner has been told this was forgotten and says to keep it anyway.",
      ),
  }),
  async execute({ fact, category, supersedes, evenThoughForgotten }, ctx) {
    // WHO is speaking, before WHAT was said: a fact quoted from nobody is not a quote.
    const notHim = humanTurnRefusal(
      ctx.session?.auth,
      "A standing fact is something Bendik said, in his own words, on this turn.",
    );
    if (notHim) return { remembered: false as const, message: notHim };

    // W3A-s7 — Owner decision A4: a tainted turn REFUSES rather than storing at a lower trust
    // class. `standing_facts`'s CHECK constraint (sql/004-standing-facts-origin.sql) admits only
    // `owner`, so once this turn has read somebody else's words there is no class left this row
    // could honestly carry — storing it as `third_party` would put a row here that the origin
    // model's own hard rule says must never reach a system prompt, i.e. a fact the owner believes
    // was remembered and which never applies. A visible refusal he can act on beats that silently.
    const key = turnKeyFrom(ctx);
    const stamped = key ? stampFor("owner", key) : "third_party";
    if (stamped !== "owner") {
      return {
        remembered: false as const,
        message:
          "Not stored. Earlier in this turn you read something written by someone else, so " +
          "anything written down now would carry that source, and a standing fact has to be the " +
          "owner's own words. Say it again in a fresh message and it will be stored.",
      };
    }

    const refusal = rejectFact(fact);
    if (refusal) return { remembered: false as const, message: refusal };

    // W5B-s3 — what was forgotten does not come back by itself. Checked only for a FRESH fact:
    // `supersedes` is the owner naming an explicit replacement by id, which is a decision they just
    // made, not a resurrection, so it bypasses this check entirely (see the tool's doc comment).
    // `evenThoughForgotten` is their one-step way to mean it anyway, once they have been told — this
    // check runs even then, so the write below knows there IS a ledger entry to clear.
    if (supersedes === undefined && !evenThoughForgotten) {
      let forgotten: Awaited<ReturnType<typeof wasForgotten>> = null;
      try {
        // HOT-PATH HONESTY (W5I-s7): CANONICAL_USER_ID is the fail-soft configured owner key
        // (`ownerId()`), read once at process start, not a live register lookup — this runs
        // inside a turn, and a `users` round-trip on every `remember` would cost the turn for a
        // value that practically never changes mid-process. `checkOwnerKeyAgreement` (W5I-s5b,
        // `lib/identity-client.ts`) is what actually verifies this key still agrees with the
        // register, once per process, and raises a repair rather than a throw when it does not —
        // by the time that repair fires, a mismatched write may already have happened, but no
        // FURTHER one goes unnoticed. `wasForgotten` itself also refuses a value that does not
        // even LOOK canonical (`assertCanonicalOwner`).
        forgotten = await wasForgotten(getPool(), { owner: configuredOwnerId(), kind: "fact", words: fact });
      } catch (err) {
        // No ledger table — no way to check, so no refusal. The same fail-open shape `forget`
        // already uses for the opposite direction.
        if (!isMissingLedgerTable(err)) throw err;
      }
      if (forgotten) {
        const date = forgotten.forgottenAt.toISOString().slice(0, 10);
        return {
          remembered: false as const,
          reason: "forgotten" as const,
          message:
            `You asked me to forget that on ${date}, so I have not put it back. If it is true ` +
            "again, tell me to remember it anyway and I will.",
        };
      }
    }

    // The turn id, so any row can be traced back to the exchange it came from. Falls back to
    // the session id, and then to a marker rather than an empty string — a row whose
    // provenance is unknown must SAY so, not look like a row nobody bothered to fill in.
    const sourceTurn = ctx.session?.turn?.id ?? ctx.session?.id ?? "unknown";

    // CANONICAL_USER_ID, not a resolved principal: the principal check above already guarantees
    // the writer is the allowlisted human, and live principal→user resolution is Phase 3's
    // reader-path work (multi-user substrate plan) — a half-wiring here would break brief turns,
    // which run as the app principal with no session user to resolve.
    const replacement = { fact, category, sourceTurn, userId: configuredOwnerId() };

    if (supersedes === undefined) {
      let stored: StandingFact;
      if (evenThoughForgotten) {
        // ONE TRANSACTION: the fact is written and the ledger entry for these exact words is
        // cleared together, or neither happens — see `rememberFactClearingForgotten`'s header.
        try {
          // Same hot-path honesty as the `wasForgotten` call above: `replacement.userId` is
          // CANONICAL_USER_ID, the fail-soft configured key, not a fresh register read — see that
          // call site's comment for why, and `checkOwnerKeyAgreement` (W5I-s5b) for what backstops it.
          stored = await rememberFactClearingForgotten(getPool(), replacement, (client) =>
            removeForgotten(client, { owner: replacement.userId, kind: "fact", words: replacement.fact }),
          );
        } catch (err) {
          if (!isMissingLedgerTable(err)) throw err;
          // The transaction above rolled itself back, so nothing was written yet — this second
          // call is the only writer of the fact, not a second attempt at one. There is no ledger
          // row to clear on a box that does not have the table at all.
          stored = await rememberFact(getPool(), replacement);
        }
      } else {
        stored = await rememberFact(getPool(), replacement);
      }
      return {
        remembered: true as const,
        id: stored.id,
        message: `Noted — standing from now on (${stored.category}, id ${stored.id}).`,
      };
    }

    // WHICH fact this replaces is the MODEL's judgement, and it arrives as an id it was shown in
    // the standing-facts block — never a text match done quietly in code. A paraphrase match would
    // close the wrong fact on a near-miss ("I take the train to the coast" vs "I take the train to
    // work") and there would be nothing in the exchange to show it had happened. An id is
    // checkable: it either names one of this owner's standing facts or it does not.
    try {
      const { retired, stored } = await supersedeFact(getPool(), supersedes, replacement);
      return {
        remembered: true as const,
        id: stored.id,
        linked: true as const,
        message:
          `Noted — standing from now on (${stored.category}, id ${stored.id}). Fact ${retired.id} ` +
          "is closed and linked to it: still on record, no longer applying.",
      };
    } catch (err) {
      // A guessed id, another member's fact, or one that was already replaced. A sentence, not a
      // throw — the model can read the ids again and call this properly, and a wrong guess never
      // costs the turn or writes half a change.
      if (err instanceof UnknownFactError) {
        return {
          remembered: false as const,
          message:
            `There is no standing fact with id ${supersedes} to replace — it is not one of the ` +
            "owner's standing facts, or it has already been replaced. Nothing was written. Read the " +
            "ids in the block of what you have been told and call this again with the right one, or " +
            "with no id at all if this is simply a new fact.",
        };
      }
      if (!isMissingColumnError(err)) throw err;

      // DEPLOY FAIL-SOFT. This installation applies SQL by hand, possibly days after the image
      // that reads the new columns is deployed. Without `superseded_by` there is no link to write,
      // but there is still a correction to record — so do what this tool has always done, close
      // the old row and add the new one, and say plainly that the two are not joined up.
      console.warn(
        "standing_facts has no superseded_by column yet — apply " +
          "services/chief-of-staff/sql/005-standing-facts-validity.sql on this box. The change was " +
          "recorded as a retirement plus a new fact, which is the old behaviour: correct, but with " +
          "nothing recording that the two rows are the same fact changing.",
      );
      const closed = await forgetFact(getPool(), supersedes, configuredOwnerId());
      const stored = await rememberFact(getPool(), replacement);
      return {
        remembered: true as const,
        id: stored.id,
        linked: false as const,
        message: closed
          ? `Noted — standing from now on (${stored.category}, id ${stored.id}), and fact ${closed.id} no longer applies.`
          : `Noted — standing from now on (${stored.category}, id ${stored.id}). Fact ${supersedes} was not closed; check whether it is still listed.`,
      };
    }
  },
});
