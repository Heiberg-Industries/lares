/**
 * catalogue/facts_list.ts — read the owner's standing facts back (W4A-s4 follow-up).
 *
 * THE HOLE THIS CLOSES. `lib/standing-facts.ts`'s `FACT_LOOKUP_TOOL` names the tool an agent
 * could call to read back a fact the per-session character budget left out of the "## What I
 * have been told" block — until this tool existed, that name was `null`, because nothing here
 * listed standing facts back to the model at all (`remember` writes one, `forget` retires one by
 * id, neither reads the table back). A budget that dropped the oldest facts with no such tool
 * would be a one-way door: words the owner actually said, gone from the only place the agent can
 * see them, with no call it could make to get them back. This tool is that call, so
 * `buildFactsCore` can honestly start cutting at the budget instead of only reporting.
 *
 * READ-ONLY AND UNGATED, same posture as `remember`: this reaches nobody outside the box, it
 * only reads rows the CHECK constraint (`sql/004-standing-facts-origin.sql`) already restricts
 * to `origin = 'owner'`, and it returns only what the owner said — no third-party text, no
 * inference. Bounded to `MAX_STANDING_FACTS`, the same ceiling the injected block itself has
 * always used, so this tool cannot become an unbounded read the block never was.
 *
 * W5A-s3: records every id this call actually hands back (kind `standing_fact`, `memory_reads`,
 * box 075) so a later `memory_used` call can say this turn's answer opened them — the same
 * fire-and-forget posture `recordRead` documents (never throws, never delays the reply). A read
 * whose turn cannot be named (no session id, no turn id on `ctx`) records nothing rather than
 * guess.
 *
 * `retired: true` (owner ruling, 2026-09-19 afternoon) — "what have I retired?" `forget` only
 * ever sets `retired_at` on a row; nothing else listed it back, so this is the smallest change
 * that closes that hole: the same tool, one more optional input, read-only, still nothing but
 * `standing_facts` for the canonical owner. It NEVER touches the forget ledger (that table holds
 * a one-way hash, not words, so there is nothing there to show) and a retired fact returned here
 * never enters the per-session facts block or the turn's correction note — both are built from
 * `listActiveFacts` alone, which a retired row has already dropped out of. `false` or absent
 * behaves exactly as before this input existed.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { configuredOwnerId } from "../lib/identity-client.js";
import {
  MAX_STANDING_FACTS,
  RETIRED_FACTS_LIMIT,
  STANDING_FACT_CATEGORIES,
  listActiveFacts,
  listRetiredFacts,
} from "../lib/standing-facts.js";
import { recordRead } from "../lib/memory-reads.js";

/** Postgres "relation does not exist" (42P01) — the shape a box with no `standing_facts` table
 *  at all would produce (never seen on a real installation past `sql/002`, but `queryFacts`'s
 *  own retry ladder only covers a missing 004/005 COLUMN, not a missing table, so this is the
 *  last line before a throw would otherwise cost the turn). Same code every other missing-table
 *  check in this service uses (`catalogue/memory_used.ts`, `lib/agent-notes.ts`). */
function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

export default defineTool({
  description:
    "List the owner's standing facts — everything in \"## What I have been told\", plus any " +
    "older ones the character budget left out of that block. Read-only; call it when the block " +
    "says facts were left out, or whenever you need to see the full list rather than what fit. " +
    "Newest first, optionally filtered to one category. Pass `retired: true` instead to see " +
    "what the owner has RETIRED — facts they told you to forget, newest retirement first, with " +
    "when each was stated and when it was retired. That is how the owner sees or recovers what " +
    "they retired: bringing one back is never something you do on your own — only the owner " +
    "saying it again, and then `remember` (with `evenThoughForgotten` if it refuses).",
  inputSchema: z.object({
    category: z
      .enum(STANDING_FACT_CATEGORIES)
      .optional()
      .describe(`Restrict to one category — ${STANDING_FACT_CATEGORIES.join(", ")}. Ignored when \`retired\` is true.`),
    retired: z
      .boolean()
      .optional()
      .describe(
        "When true, list the owner's RETIRED facts instead of the standing ones — newest " +
          "retirement first, up to 50. Use this only to answer the owner asking what they have " +
          "retired or forgotten; never to bring one back yourself.",
      ),
  }),
  async execute({ category, retired }, ctx) {
    if (retired) {
      let page: Awaited<ReturnType<typeof listRetiredFacts>>;
      try {
        page = await listRetiredFacts(getPool(), configuredOwnerId(), RETIRED_FACTS_LIMIT);
      } catch (err) {
        if (!isMissingTable(err)) throw err;
        return {
          facts: [],
          message: "I cannot list retired facts on this installation yet.",
        };
      }
      return {
        facts: page.facts.map((f) => ({
          id: f.id,
          text: f.fact,
          category: f.category,
          statedAt: f.statedAt.toISOString(),
          retiredAt: f.retiredAt.toISOString(),
          ...("supersededBy" in f ? { supersededBy: f.supersededBy } : {}),
        })),
        message: page.cut
          ? `Showing the ${RETIRED_FACTS_LIMIT} most recently retired facts — more exist.`
          : `${page.facts.length} retired fact${page.facts.length === 1 ? "" : "s"}.`,
      };
    }

    const facts = await listActiveFacts(getPool(), configuredOwnerId(), MAX_STANDING_FACTS);
    const filtered = category ? facts.filter((f) => f.category === category) : facts;

    const sessionId = ctx?.session?.id;
    const turnId = ctx?.session?.turn?.id;
    if (typeof sessionId === "string" && typeof turnId === "string") {
      void recordRead(getPool(), {
        sessionId,
        turnId,
        owner: configuredOwnerId(),
        kind: "standing_fact",
        refs: filtered.map((f) => String(f.id)),
      }).catch(() => {});
    }

    return {
      facts: filtered.map((f) => ({ id: f.id, fact: f.fact, category: f.category })),
    };
  },
});
