/**
 * catalogue/memory_used.ts — "which memories did you use?", answerable on any door (W5A-s5,
 * ADR-0017 rule 6, Owner decision A1: a tool, not a door command).
 *
 * ANSWERS ABOUT THE PREVIOUS TURN BY DEFAULT. The turn asking this question has (almost always)
 * not opened anything itself, so `previousTurnIn` finds the turn before it in the same session
 * and this tool reports on THAT one — the "answer" the owner means by "that answer". When there
 * is no earlier turn (the owner asked inside the session's first turn), `previousTurnIn` returns
 * null and this tool falls back to the CURRENT turn's own reads.
 *
 * READ-ONLY, UNGATED — the same posture as `facts_list` and `memory_proposals`: it reaches
 * nobody outside the box and returns only ids, paths and labels a call site already wrote at the
 * moment of reading (`lib/memory-reads.ts`'s `recordRead`, box 075) — never a note's own body.
 * Classified in `tests/origin-taint-reads.test.ts` as bringing back NO outside text, not as
 * tainting: a `kind`/`ref` pair the code itself recorded is not freeform prose someone else
 * wrote, the line this track actually defends against.
 *
 * THE LIMIT (Owner decision A2), STATED EVERYWHERE THIS SURFACES: a vault/atlas search is never
 * recorded — only a specific thing opened by id or by path. So the list can be shorter than what
 * was actually in front of the model, never longer — and an EMPTY list means "nothing was opened
 * by id or by path", not "I used nothing". The description below and the capability-doc rule
 * both say so, so the model never over-claims when relaying an empty answer to the owner.
 *
 * FAILS SOFT ON A BOX WHERE 075 HAS NOT BEEN APPLIED. `listMemoryUsed`/`previousTurnIn` already
 * swallow a missing-table error internally and answer as if nothing was found — which would be
 * indistinguishable from a genuinely empty answer. A direct probe query here catches Postgres's
 * `42P01` (undefined_table) first and answers with the file to apply instead.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { listMemoryUsed, previousTurnIn, memoryUsedMarkdown } from "@lares/agent-kit/memory-read";

/** Postgres' "relation does not exist" (42P01) — the shape an unapplied 075 migration
 *  produces, the same code every other missing-table check in this service uses. */
function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

const MISSING_TABLE_MESSAGE =
  "This installation does not record which memories an answer used yet — apply " +
  "services/box/sql/075_memory_reads.sql.";

export default defineTool({
  description:
    "List the remembered things the previous answer actually opened — standing facts from the " +
    "session's block, notes read by path, notes the agent left itself. Read-only. Call it when " +
    "the owner asks which memories you used, where something came from, or why you said what " +
    "you said; quote what it returns rather than recalling from the conversation. It lists only " +
    "what was opened by id or by path: a note found by searching and only skimmed is not " +
    "recorded, so never claim the list is everything that was in front of you.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const pool = getPool();

    try {
      await pool.query("SELECT 1 FROM memory_reads LIMIT 1");
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      return { turn: null, used: [], summary: MISSING_TABLE_MESSAGE };
    }

    const sessionId = ctx.session?.id;
    const askingTurnId = ctx.session?.turn?.id;
    if (typeof sessionId !== "string" || typeof askingTurnId !== "string") {
      return { turn: null, used: [], summary: memoryUsedMarkdown([]) };
    }

    const turn = (await previousTurnIn(pool, { sessionId, beforeTurnId: askingTurnId })) ?? askingTurnId;
    const used = await listMemoryUsed(pool, { sessionId, turnId: turn });

    return {
      turn,
      used: used.map((u) => ({ kind: u.kind, ref: u.ref, via: u.via })),
      summary: memoryUsedMarkdown(used),
    };
  },
});
