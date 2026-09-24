/**
 * agent/tools/persona_overlay.ts — regenerate a trip's destination persona overlay (ORB-96),
 * admin-DM only.
 *
 * The overlay is generated once at `/nytur` and then just sits in the trip directory as a plain
 * markdown file. That gives two edit paths for free: Bendik can open `persona-overlay.md` and
 * rewrite it by hand, or he can ask for a fresh one — this tool. It overwrites; there is no
 * versioning, because the file is cheap to regenerate and hand edits that mattered would have
 * been made deliberately (say so before regenerating if it looks hand-written).
 *
 * It calls `realPersonaOverlay` from nytur.ts rather than re-implementing generation, so the
 * regenerated overlay is byte-for-byte the same KIND of artifact the trip was created with.
 *
 * Admin-DM-only, same tool-local gate as every other admin tool here (see sveip.ts's own doc
 * comment for why a channel-level allowlist alone isn't enough).
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { isAllowedAdmin } from "../lib/principals.js";
import { realPersonaOverlay } from "./nytur.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function assertAdminDm(auth: SessionAuth | undefined): void {
  const caller = auth?.current ?? auth?.initiator ?? null;
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
    throw new Error("persona_overlay: admin-DM only");
  }
}

export interface PersonaOverlayDeps {
  store(): TripStore;
  generate(store: TripStore, trip: Trip): Promise<boolean>;
}

export const defaultPersonaOverlayDeps: PersonaOverlayDeps = {
  store: () => new TripStore(dataRoot()),
  generate: realPersonaOverlay,
};

const inputSchema = z.object({
  slug: z.string().min(1).describe("the trip's slug, e.g. 'the-big-apple'"),
});

export function createPersonaOverlayTool(deps: PersonaOverlayDeps) {
  return defineTool({
    description:
      "Regenerate the destination persona overlay for one trip — admin-DM only. Costs one " +
      "model call and OVERWRITES the trip's persona-overlay.md, so mention it first if the " +
      "existing overlay may have been hand-edited. Use when a trip has no overlay (its " +
      "generation failed at /nytur) or when the admin wants a different local flavour.",
    inputSchema,
    async execute({ slug }, ctx) {
      assertAdminDm(ctx.session.auth);

      const store = deps.store();
      const trip = store.trips().find((t) => t.slug === slug);
      if (!trip) return { error: `ingen tur med slug "${slug}"` };

      const written = await deps.generate(store, trip);
      return written
        ? { ok: true, slug, trip: trip.name, destination: trip.destination.name }
        : { error: `modellen svarte tomt — ${trip.name} har fortsatt ingen lokal farge` };
    },
  });
}

export default createPersonaOverlayTool(defaultPersonaOverlayDeps);
