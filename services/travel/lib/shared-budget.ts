/**
 * lib/shared-budget.ts — the ONE daily token budget for the whole agent.
 *
 * Lifted out of `agent/channels/telegram.ts` (ORB-107) for the same reason as
 * `lib/telegram-credentials.ts`: the sweep runner can no longer import the channel, because
 * the channel now imports the runner. The invariant this file exists to protect was already
 * written down at both call sites and is worth stating once, here:
 *
 * ONE `Budget` INSTANCE, shared by the gatekeeper's gate decisions and /sveip's booking
 * extraction. Two separate instances against the same file silently lose writes — each saves
 * from its own last-known `used` value, so the later write clobbers the earlier one instead
 * of accumulating (review fix, finding 8). Old Marcel had the identical single instance
 * (`bin/marcel.ts:1058`, passed into makeGateDecide/makeExtractBooking/makeDistill alike).
 *
 * Lives under MARCEL_DATA_ROOT (the persistent /srv/eve-marcel bind mount), never /tmp: /tmp
 * is the container's tmpfs and resets on every restart, silently giving the daily cap a fresh
 * budget each time the container recycles.
 *
 * Constructing a `Budget` only touches `fs.existsSync` on a maybe-absent path (see
 * lib/budget.ts), so this is safe at module scope during `eve build` — unlike anything that
 * reads a secret or resolves a model id.
 */
import path from "node:path";

import { Budget } from "./budget.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function budgetFile(): string {
  return process.env["MARCEL_BUDGET_FILE"] ?? path.join(dataRoot(), "budget.json");
}

function dailyTokenBudget(): number {
  return Number(process.env["MARCEL_DAILY_TOKEN_BUDGET"] ?? "2000000");
}

/**
 * Europe/Oslo, not a per-trip timezone. The daily cap is deliberately NOT per-trip — one
 * instance spans however many trips are active (zero, one, or several) at once, so there is no
 * single "the trip's tz" to anchor it to. Europe/Oslo matches the rest of this fleet's global
 * day-boundary convention, and `lib/sveip-run.ts` anchors the cross-trip Reise-mail sweep the
 * same way for the identical reason.
 */
function budgetTz(): string {
  return process.env["MARCEL_BUDGET_TZ"] ?? "Europe/Oslo";
}

export const sharedBudget = new Budget(budgetFile(), dailyTokenBudget(), budgetTz());
