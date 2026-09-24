/**
 * agent/tools/sveip.ts — the model-facing way to start a Reise-inbox sweep.
 *
 * ## What moved, and why (ORB-107)
 *
 * The sweep itself now lives in `lib/sveip-run.ts`. This file is the tool that lets the model
 * start one when ASKED conversationally ("kan du sveipe innboksen?"). The `/sveip` COMMAND no
 * longer comes through here at all — `agent/channels/telegram.ts`'s `onMessage` dispatches it
 * straight to `startSveip`, past the model, beside the kill-switch branch.
 *
 * That split exists because on 2026-08-17 the model refused four consecutive `/sveip`s
 * ("Sveipen kjører allerede fra i sted") on the strength of a stale belief: a sweep it had
 * acked at 13:44 was killed by a deploy, and the completion report is a raw Telegram send the
 * session never sees, so nothing could ever correct it. A command whose execution depends on
 * the model's memory of an event the model cannot observe is not a command. The marker file is
 * the arbiter now, and it is consulted inside `startSveip` on both paths.
 *
 * What keeps THIS path honest is `agent/instructions/trip-context.ts`'s per-turn sweep-status
 * line, read from the same marker: the model is told, every turn, whether a sweep is actually
 * running.
 *
 * ## What stayed here
 *
 * The admin-DM gate. It is a tool-local check on `ctx.session.auth`, not just the channel's
 * private-chat allowlist, because this tool's toolset is NOT scoped per-session: a group-chat
 * turn (gated by the `Gatekeeper`, which can let any group member's message trigger a "speak"
 * turn) could otherwise let the model reach for a Gmail sweep from a context no allowlist
 * checked. The command path has its own, stricter equivalent — it requires a private chat from
 * the admin id before it will even look at the text.
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { isAllowedAdmin } from "../lib/principals.js";
import {
  SVEIP_ACK,
  defaultSveipDeps,
  startSveip,
  type SveipDeps,
} from "../lib/sveip-run.js";
import { SWEEP_ALREADY_RUNNING } from "../lib/sweep-marker.js";

// Re-exported so the modules that already reach for these keep one import site, and so tests
// that exercise the tool can keep asserting on the same names (agent/instrumentation.ts and
// agent/schedules/proximity.ts both use tgSend/adminChatId; tests/extraction-rethink.test.ts
// uses composeCompletionReport).
export { adminChatId, composeCompletionReport, tgSend, type SveipDeps } from "../lib/sveip-run.js";

function callerAuth(auth: SessionAuth | undefined): SessionAuth["current"] {
  return auth?.current ?? auth?.initiator ?? null;
}

/** Admin-DM-only gate — see this file's top-of-file doc comment for why a tool-local check is
 *  needed in addition to the channel's own private-chat allowlist. Fails closed on anything
 *  that isn't unambiguously "the admin, in a private chat": missing auth, a group/supergroup
 *  chat_type, or a user id that `lib/principals.ts`'s `isAllowedAdmin` doesn't recognise. */
function assertAdminDm(auth: SessionAuth | undefined): void {
  const caller = callerAuth(auth);
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
    throw new Error("sveip: admin-DM only");
  }
}

export function createSveipTool(deps: SveipDeps) {
  return defineTool({
    description:
      "Sveip Reise-innboksen (Gmail-labelen 'Reise', siste år) for bookinger på nytt og fyll " +
      "inn bookings.md for hver tur som treffer. Kjøres i bakgrunnen — kan ta flere minutter " +
      "— og et sammendrag sendes som egen DM når det er ferdig, IKKE i dette svaret. Bruk kun " +
      "i admin-DM, ingen input. Om et sveip allerede kjører sier verktøyet selv ifra — ikke " +
      "avslå å kalle det basert på hva du tror du husker fra tidligere i samtalen.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      assertAdminDm(ctx.session.auth);
      const outcome = await startSveip(deps);
      return outcome === "already-running" ? SWEEP_ALREADY_RUNNING : SVEIP_ACK;
    },
  });
}

export default createSveipTool(defaultSveipDeps);
