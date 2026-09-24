/**
 * agent/tools/shopping_remove.ts — removes an item from the trip's shopping list, ported from
 * old Marcel's `tools.shopping_remove` (`services/marcel/lib/brain.ts:302-309`) PLUS the write
 * it used to only queue: old Marcel's daemon-side `removeShoppingItem`
 * (`bin/marcel.ts:220-225`) did a case-insensitive substring match against each line of
 * shopping.md and rewrote the file with matching lines dropped. Collapsed here the same way
 * `remember.ts`/`shopping_add.ts` collapse their own queue-then-daemon-persists indirection —
 * `execute()` writes directly.
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

/** Ported verbatim from old Marcel's `removeShoppingItem` (`bin/marcel.ts:220-225`): drops
 *  every line whose lowercased text contains the lowercased `item` as a substring — a whole
 *  "- solkrem" line goes if `item` is "solkrem" OR just "sol". Exported for its own unit test. */
export function removeShoppingLine(shoppingMd: string, item: string): string {
  const needle = item.toLowerCase();
  const kept = shoppingMd.split("\n").filter((line) => !line.toLowerCase().includes(needle));
  return kept.join("\n");
}

export interface ShoppingRemoveDeps {
  store(): TripStore;
  currentTrip(store: TripStore, auth: SessionAuth | undefined, slug?: string): Promise<TripResolution>;
}

export const defaultShoppingRemoveDeps: ShoppingRemoveDeps = {
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

export function createShoppingRemoveTool(deps: ShoppingRemoveDeps) {
  return defineTool({
    description:
      "Remove an item from the trip's shopping list ('## Handleliste') — matches any line " +
      "containing the given text (case-insensitive), written directly into the trip's own " +
      "shopping.md.",
    inputSchema,
    async execute({ item, slug }, ctx) {
      const store = deps.store();
      const res = await deps.currentTrip(store, ctx.session.auth, slug);
      if (!res.ok) return { error: res.error };
      const existing = store.read(res.trip, SHOPPING_MD);
      store.write(res.trip, SHOPPING_MD, removeShoppingLine(existing, item));
      return { ok: true };
    },
  });
}

export default createShoppingRemoveTool(defaultShoppingRemoveDeps);
