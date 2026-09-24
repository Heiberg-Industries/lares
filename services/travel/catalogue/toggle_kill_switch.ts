/**
 * agent/tools/toggle_kill_switch.ts — flips Marcel's kill switch, admin-DM only. Ported from
 * old Marcel's `/marcel av|på` handler (`services/marcel/bin/marcel.ts:506-514`). The
 * mid-wizard variant (old Marcel additionally cleared any in-progress `/nytur` wizard state on
 * `av`) collapses into eve's own session cancellation — there is no separate wizard-state map
 * to clear here (see `nytur.ts`'s own doc comment: eve's session state replaced it entirely),
 * so this tool only ever does the one thing: flip the switch and confirm.
 *
 * The switch itself lives in `agent/channels/telegram.ts`'s `defaultDoorDeps`
 * (`isKillSwitchOn`/`setKillSwitch`, persisted to `TripStore`'s `MarcelConfig.killSwitch` —
 * `MARCEL_DATA_ROOT/config.json`, review fix finding 2, no longer an in-memory flag) — this
 * tool is the ONLY way a normal conversation turn can flip it (in either direction). Re-enabling
 * it ALSO has a channel-level shortcut, the raw `/marcel på` Telegram command
 * (`agent/channels/telegram.ts`'s `isKillSwitchReenable`) — the two paths write the exact same
 * persisted field, so they can never disagree, and `lib/trip-schedule.ts`/`lib/dream.ts` read
 * that same field too, so a schedule tick honors whatever either path last set.
 *
 * `on` matches `MarcelDoorDeps.setKillSwitch`'s own semantics literally: `on: true` means the
 * KILL SWITCH is on, i.e. Marcel goes silent; `on: false` turns it back off, i.e. Marcel is
 * active again. This mirrors `TripStore`'s own `MarcelConfig.killSwitch: boolean` field name.
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";
import { sendTelegramMessage } from "eve/channels/telegram";

import { isAllowedAdmin } from "../lib/principals.js";
import { telegramCredentials, defaultDoorDeps } from "../agent/channels/telegram.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

/** Returns the caller's own chat id (the admin's private chat) once the gate passes — this
 *  tool's own confirmation DM always targets that chat, never a fixed env var, since the gate
 *  already proved it IS the admin's private chat. */
function assertAdminDm(auth: SessionAuth | undefined): string {
  const caller = callerAuth(auth);
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  const chatId = caller?.attributes?.["chat_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId) || typeof chatId !== "string") {
    throw new Error("toggle_kill_switch: admin-DM only");
  }
  return chatId;
}

export interface ToggleKillSwitchDeps {
  setKillSwitch(on: boolean): void;
}

export const defaultToggleKillSwitchDeps: ToggleKillSwitchDeps = {
  setKillSwitch: (on) => defaultDoorDeps.setKillSwitch(on),
};

const inputSchema = z.object({
  on: z.boolean().describe("true = turn the kill switch ON (Marcel goes silent); false = turn it back off"),
});

export function createToggleKillSwitchTool(deps: ToggleKillSwitchDeps) {
  return defineTool({
    description:
      "Turn Marcel's kill switch on or off — admin-DM only. When on, Marcel ignores every " +
      "group AND private message except the raw '/marcel på' Telegram command.",
    inputSchema,
    async execute({ on }, ctx) {
      const chatId = assertAdminDm(ctx.session.auth);
      deps.setKillSwitch(on);
      await sendTelegramMessage({
        credentials: telegramCredentials,
        chatId,
        body: { text: on ? "Marcel er av. 😴" : "Marcel er på igjen. 🙋" },
        fetch: telegramFetch,
      });
      return { ok: true, on };
    },
  });
}

export default createToggleKillSwitchTool(defaultToggleKillSwitchDeps);
