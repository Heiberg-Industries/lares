/**
 * agent/tools/shopping_add.ts — adds an item to the trip's shopping list, ported from old
 * Marcel's `tools.shopping_add` (`services/marcel/lib/brain.ts:293-300`) PLUS the write it used
 * to only queue: old Marcel's `shopping_add` tool pushed a `{ type: "shopping_add", item }`
 * action that a separate daemon loop (`bin/marcel.ts`'s `performActions`,
 * `bin/marcel.ts:235-236`: `deps.store.append(trip, SHOPPING_MD, "- " + action.item)`)
 * persisted after the reply was sent. eve-marcel has no such daemon loop to hand a queued
 * action to, so — matching `remember.ts`'s own established pattern (Task 6) — this tool
 * collapses that indirection: `execute()` writes directly into `TripStore`'s `shopping.md`.
 *
 * `shopping.md`'s raw content is what Finding 1's dynamic trip-context instructions render
 * under "## Handleliste" — this tool (and `shopping_remove.ts`) is the only way that section's
 * content changes.
 *
 * Boundary: the model must never claim to have added something to the shopping list without
 * calling this tool.
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { TripStore } from "../lib/trip-store.js";
import { resolveCurrentTrip, type TripResolution } from "../lib/current-trip.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

// ORB-157: shared resolver — see lib/current-trip.ts for the contract.
async function currentTrip(store: TripStore, auth: SessionAuth | undefined, slug?: string): Promise<TripResolution> {
  return resolveCurrentTrip(store, auth, { slug });
}

const SHOPPING_MD = "shopping.md";

export interface ShoppingAddDeps {
  store(): TripStore;
  currentTrip(store: TripStore, auth: SessionAuth | undefined, slug?: string): Promise<TripResolution>;
}

export const defaultShoppingAddDeps: ShoppingAddDeps = {
  store: () => new TripStore(dataRoot()),
  currentTrip,
};

const inputSchema = z.object({
  item: z.string().min(1),
  slug: z
    .string()
    .optional()
    .describe(
      "trip slug — only meaningful in the admin DM, and only when several trips are active or " +
        "upcoming; a group always uses its own linked trip",
    ),
});

export function createShoppingAddTool(deps: ShoppingAddDeps) {
  return defineTool({
    description:
      "Add an item to the trip's shopping list ('## Handleliste'), written directly into the " +
      "trip's own shopping.md — durable across the whole trip, visible to every future turn. " +
      "Never claim to have added something without calling this tool.",
    inputSchema,
    async execute({ item, slug }, ctx) {
      const store = deps.store();
      const res = await deps.currentTrip(store, ctx.session.auth, slug);
      if (!res.ok) return { error: res.error };
      store.append(res.trip, SHOPPING_MD, `- ${item}`);
      return { ok: true };
    },
  });
}

export default createShoppingAddTool(defaultShoppingAddDeps);
