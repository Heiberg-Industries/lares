// List the owner's standing deadlines to institutions. Read-only, ungated — matches the
// plan's TOOL verdict for `deadline_list` (only `mint_statutory`/`done`/`dismiss` are gated).
//
// `daysToDue` is computed HERE, on the owner's clock (`@lares/agent-kit/deadlines`'s
// `daysToDue`, the same function the ladder and the brief use), rather than stored on the
// row — the row only ever holds `due_date`, and "how many days out" changes every day the row
// sits open.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { daysToDue } from "@lares/agent-kit/deadlines";
import { listDeadlines } from "../lib/deadlines-store.js";
import { ownerId } from "../lib/principals.js";
import { ownerTz } from "../lib/owner-clock.js";

export default defineTool({
  description:
    "List the owner's deadlines to institutions — tax and filing terms, annual accounts, " +
    "renewals — soonest due first. Never answer 'what is due' from memory; call this. " +
    "`status` defaults to open; pass 'all' to include done/dismissed rows too. `withinDays` " +
    "narrows to rows due on or before that many days out (an overdue row is always included, " +
    "since its day has already passed).",
  inputSchema: z.object({
    status: z.enum(["open", "done", "dismissed", "all"]).optional(),
    withinDays: z.number().int().nonnegative().optional(),
  }),
  async execute({ status, withinDays }) {
    const tz = await ownerTz();
    const now = new Date();
    const rows = await listDeadlines(getPool(), ownerId(), {
      status: status ?? "open",
      ...(withinDays !== undefined ? { dueWithinDays: withinDays, now, tz } : {}),
    });
    return {
      deadlines: rows.map((r) => ({
        id: r.id,
        entity: r.entity,
        title: r.title,
        dueDate: r.dueDate,
        daysToDue: daysToDue(r.dueDate, now, tz),
        recurrence: r.recurrence,
        source: r.source,
        consequence: r.consequence,
        status: r.status,
        rung: r.rung,
        vendor: r.vendor,
        amount: r.amount,
        currency: r.currency,
      })),
    };
  },
});
