// Mint a fiscal year's statutory deadline calendar onto one entity. GATED — a wrong mint
// scatters a whole year of wrong dates, and every seeded rule's `evidenceRule` says "owner
// confirms" for exactly this reason (`@lares/agent-kit/deadlines`'s own header): the mint IS
// the moment a human checks the year's dates against the authority, not a formality on top
// of it.
//
// THE CARD: `packages/agent-kit/src/approval-summary.ts`'s `deadline_mint_statutory` details
// formatter re-derives the row list from the RAW (pre-validated) input via the same
// `mintYear()` this tool calls — eve's approval API has no separate "prepare" step (confirmed
// against `remind_set.ts`, the gated-write reference this task was pointed at: its card is
// built entirely from input, in `execute()` it is too late), so the only way to put real
// dates on the card before `execute()` runs is to compute them again, synchronously, from the
// same input the model supplied — the same technique `vault_write`'s formatter already uses
// to derive a path from a title. `execute()` ALSO returns every inserted row below, so the
// model's own confirmation back to the owner can name them, independent of what the card
// rendered.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { mintYear } from "@lares/agent-kit/deadlines";
import { ownerDay } from "@lares/agent-kit/proactivity";
import { createDeadline } from "../lib/deadlines-store.js";
import { ownerId } from "../lib/principals.js";
import { ownerTz } from "../lib/owner-clock.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Mint a fiscal year's statutory deadline calendar (Norwegian AS terms — tax and filing " +
    "dates, annual accounts, the ordinary general meeting) onto one entity. Requires the " +
    "owner's approval; the card lists every date this would add — confirm each one against the " +
    "authority before approving, since this file believes a rule until told otherwise and a " +
    "date can move. `omit` drops rule keys that don't apply to this company (e.g. no VAT " +
    "registration); an unknown key throws rather than being silently ignored. A row already " +
    "present for the same entity, rule and date is skipped, so minting the same year twice is " +
    "a no-op. Minting a year that has already started adds only the terms still ahead — " +
    "already-past dates are skipped unless `includePast: true`, and the result names the ones " +
    "it left out so you can offer to add any of them by hand.",
  inputSchema: z.object({
    entity: z.string().min(1),
    fiscalYear: z.number().int(),
    jurisdiction: z.literal("NO-AS"),
    omit: z.array(z.string()).optional(),
    includePast: z
      .boolean()
      .optional()
      .describe("Mint dates that have already passed too. Default false."),
  }),
  approval: approvalFor("deadline_mint_statutory"),
  async execute(input, ctx) {
    await assertApproval(ctx, "deadline_mint_statutory", input);
    const { entity, fiscalYear, jurisdiction, omit, includePast } = input;

    // The owner's day, never the server's: `mintYear` refuses to guess it (see its own header),
    // because the boundary between "still ahead" and "already gone" is a calendar day on HIS
    // clock — the ORB-124/128/204 rule.
    const now = new Date();
    const today = ownerDay(now, await ownerTz());
    const { minted, skippedPast } = mintYear(jurisdiction, fiscalYear, {
      omit,
      today,
      ...(includePast === true ? { includePast: true } : {}),
    });
    const pool = getPool();
    const owner = ownerId();

    let inserted = 0;
    let skipped = 0;
    const rows: Array<{ id: string; ruleKey: string; title: string; dueDate: string }> = [];

    for (const m of minted) {
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM deadlines WHERE owner = $1 AND entity = $2 AND rule_key = $3 AND due_date = $4::date`,
        [owner, entity, m.ruleKey, m.dueDate],
      );
      if (existing.length > 0) {
        skipped++;
        continue;
      }
      const row = await createDeadline(pool, {
        owner,
        entity,
        title: m.title,
        source: m.source,
        dueDate: m.dueDate,
        recurrence: m.recurrence,
        consequence: m.consequence,
        evidenceRule: m.evidenceRule,
        ruleKey: m.ruleKey,
        createdBy: "user",
      });
      inserted++;
      rows.push({ id: row.id, ruleKey: row.ruleKey ?? m.ruleKey, title: row.title, dueDate: row.dueDate });
    }

    // `skippedPast` is NAMED, not merely counted: a mid-year mint that reported "inserted 9" for a
    // 12-rule year would look like a broken rule set, and the owner who does want a January row
    // has to know which one to ask for.
    return {
      inserted,
      skipped,
      rows,
      today,
      skippedPast: skippedPast.length,
      skippedPastRows: skippedPast.map((m) => ({ ruleKey: m.ruleKey, title: m.title, dueDate: m.dueDate })),
    };
  },
});
