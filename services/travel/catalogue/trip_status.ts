/**
 * agent/tools/trip_status.ts — read-only trip registry lookup, admin-DM only (ORB-157
 * follow-up #2, 2026-08-24).
 *
 * Why a TOOL when the turn context already carries the `## Turer` registry: Marcel's persona
 * drills "never assert a fact without a tool result" (the discipline that stops invented
 * weather, routes and maps links) — and it works so well that he refused to give a hard
 * yes/no on "er gruppa linket?" even with the registry marked FASIT in his instructions,
 * because he had no *oppslag han kunne kjøre* ("jeg har ikke noe eget oppslag", twice, live,
 * both with the registry in-prompt). A static claim in context loses to that discipline by
 * design. This tool is the lookup his own rules demand: config.json read fresh per call,
 * answerable with a tool result, immune to transcript self-conditioning.
 *
 * Admin-DM only, same gate as `link_group`: the registry spans EVERY trip (including ones a
 * given family group has nothing to do with), so a group chat never sees it — a group's own
 * trip already rides its turn context.
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { isAllowedAdmin } from "../lib/principals.js";
import { TripStore } from "../lib/trip-store.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

export interface TripStatusDeps {
  store(): TripStore;
}

export const defaultTripStatusDeps: TripStatusDeps = {
  store: () => new TripStore(dataRoot()),
};

const inputSchema = z.object({});

export function createTripStatusTool(deps: TripStatusDeps) {
  return defineTool({
    description:
      "List every trip with its true, current group-link state — read fresh from the trip " +
      "configuration. THE authoritative lookup for questions like 'is the group linked?', " +
      "'which trips exist?', 'what are the dates?'. Admin-DM only. Trust this result over " +
      "anything said earlier in the conversation, including your own previous messages.",
    inputSchema,
    async execute(_input, ctx) {
      const caller = callerAuth(ctx.session.auth);
      const chatType = caller?.attributes?.["chat_type"];
      const userId = caller?.attributes?.["user_id"];
      if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
        throw new Error("trip_status: admin-DM only");
      }

      const trips = deps.store()
        .trips()
        .map((t) => ({
          slug: t.slug,
          name: t.name,
          start: t.start,
          end: t.end,
          timezone: t.timezone,
          linked: t.chatId !== undefined,
          groupChatId: t.chatId ?? null,
        }));
      return { trips };
    },
  });
}

export default createTripStatusTool(defaultTripStatusDeps);
