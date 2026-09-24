/**
 * agent/tools/link_group.ts — links a Telegram group chat to a trip, admin-DM only. Resolves
 * old Marcel's `offerLink` inline-button flow (`services/marcel/bin/marcel.ts:544-553` builds
 * the offer, `701-711` handles the tap): old Marcel offered trip buttons with
 * `callback_data: "link:<slug>:<chatId>"` and linked on tap. Here the model calls this tool
 * directly once the admin has told it (in conversation) which trip a newly-joined group
 * belongs to — `agent/channels/telegram.ts`'s `onBotAddedToGroup` seam is what detects the
 * "bot just joined an unlinked group" moment this resolves, though composing/sending an
 * initial offer message is explicitly NOT that seam's job (see its own doc comment: "This
 * task never composes or sends that offer itself — only detects the moment and hands it
 * off") and stays out of this task's scope too.
 *
 * Old Marcel also posted an LLM-composed "intro" message into the newly-linked group on link
 * (`deps.compose("intro", trip, {})`). This port keeps that as a single deterministic
 * Norwegian line instead of a second LLM call from inside a tool — matching this codebase's
 * "no model-composed content inside a tool" convention (e.g.
 * `agent/channels/telegram.ts`'s own fixed `BUDGET_EXCEEDED_ADMIN_TEXT`).
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";
import { sendTelegramMessage } from "eve/channels/telegram";

import { isAllowedAdmin } from "../lib/principals.js";
import { TripStore } from "../lib/trip-store.js";
import { telegramCredentials } from "../agent/channels/telegram.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

function assertAdminDm(auth: SessionAuth | undefined): void {
  const caller = callerAuth(auth);
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
    throw new Error("link_group: admin-DM only");
  }
}

export interface LinkGroupDeps {
  store(): TripStore;
  sendIntro(chatId: string, text: string): Promise<void>;
}

async function realSendIntro(chatId: string, text: string): Promise<void> {
  await sendTelegramMessage({
    credentials: telegramCredentials,
    chatId,
    body: { text },
    fetch: telegramFetch,
  });
}

export const defaultLinkGroupDeps: LinkGroupDeps = {
  store: () => new TripStore(dataRoot()),
  sendIntro: realSendIntro,
};

const inputSchema = z.object({
  chatId: z.string().min(1).describe("the Telegram group chat id to link"),
  tripSlug: z.string().min(1),
});

export function createLinkGroupTool(deps: LinkGroupDeps) {
  return defineTool({
    description:
      "Link a Telegram group chat to a trip — admin-DM only. Re-linking a chat that's already " +
      "linked to a different trip moves it there; re-linking a trip that already has a group " +
      "moves its binding to the new chat (the old group goes silent — the trip only ever " +
      "belongs to one group at a time). Posts a short intro into the newly linked group.",
    inputSchema,
    async execute({ chatId, tripSlug }, ctx) {
      assertAdminDm(ctx.session.auth);

      const store = deps.store();
      const trip = store.trips().find((t) => t.slug === tripSlug);
      if (!trip) return { error: `fant ingen tur med slug "${tripSlug}"` };

      store.linkChat(tripSlug, chatId);
      await deps.sendIntro(chatId, `👋 Hei! Jeg er Marcel og hjelper med "${trip.name}" i denne gruppa fra nå av.`);

      return { ok: true, slug: tripSlug, chatId };
    },
  });
}

export default createLinkGroupTool(defaultLinkGroupDeps);
