/**
 * agent/tools/remember.ts — remembers a fact about the group, ported from old Marcel's
 * `tools.remember` (`services/marcel/lib/brain.ts:311-318`) PLUS the write it used to only
 * queue: old Marcel's `remember` tool pushed a `{ type: "remember", fact }` action that a
 * separate daemon loop (`bin/marcel.ts`'s `performActions` → `appendNotert`,
 * `bin/marcel.ts:199-218,239-240`) persisted after the reply was sent. eve-marcel has no such
 * daemon loop to hand a queued action to, so this task collapses that indirection: `execute()`
 * writes directly into `TripStore`'s `trip.md` "## Notert" section — a deliberate
 * simplification the brief calls out explicitly, not an oversight.
 *
 * `appendNotert` (ported byte-for-byte from `bin/marcel.ts:199-218`: insert under an existing
 * "## Notert" heading, before the next "## " heading, or create the section at the end of
 * trip.md when it doesn't exist yet) now lives in `lib/notert.ts` (Fix Wave B, Finding 2) — it
 * is shared with `agent/channels/telegram.ts`'s group `husk:` shortcut, which writes into the
 * exact same section the exact same way.
 *
 * Boundary: this tool is the ONLY way any fact makes it into trip.md's Notert section from a
 * MODEL call — the model must never claim to "remember" something without calling it.
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { TripStore } from "../lib/trip-store.js";
import { appendNotert } from "../lib/notert.js";
import { resolveCurrentTrip, type TripResolution } from "../lib/current-trip.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

// ORB-157: trip resolution now goes through the ONE shared resolver — group chats keep
// their own linked trip, the admin DM resolves the single active/upcoming trip (or an
// explicit slug). See lib/current-trip.ts for the full contract.
async function currentTrip(store: TripStore, auth: SessionAuth | undefined, slug?: string): Promise<TripResolution> {
  return resolveCurrentTrip(store, auth, { slug });
}

export interface RememberDeps {
  store(): TripStore;
  currentTrip(store: TripStore, auth: SessionAuth | undefined, slug?: string): Promise<TripResolution>;
}

export const defaultRememberDeps: RememberDeps = {
  store: () => new TripStore(dataRoot()),
  currentTrip,
};

const inputSchema = z.object({
  fact: z.string().min(1),
  slug: z
    .string()
    .optional()
    .describe(
      "trip slug — only meaningful in the admin DM, and only when several trips are active or " +
        "upcoming; a group always uses its own linked trip",
    ),
});

export function createRememberTool(deps: RememberDeps) {
  return defineTool({
    description:
      "Remember a fact about the group for later — written directly into the trip's own " +
      "trip.md under '## Notert', durable across the whole trip (not just this " +
      "conversation). Use for things worth recalling later (an allergy, a preference, a plan " +
      "change) — never for ephemeral chat content, and never claim to remember something " +
      "without calling this tool.",
    inputSchema,
    async execute({ fact, slug }, ctx) {
      const store = deps.store();
      const res = await deps.currentTrip(store, ctx.session.auth, slug);
      if (!res.ok) return { error: res.error };
      appendNotert(store, res.trip, fact);
      return { ok: true };
    },
  });
}

export default createRememberTool(defaultRememberDeps);
