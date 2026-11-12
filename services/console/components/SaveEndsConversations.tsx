import { TakesEffect } from "./TakesEffect";

/**
 * Saving a change to an agent ends its open web-chat conversations, and with them any approval still
 * waiting in one: the conversations hold the agent's access revision and, if they read notes, the
 * definition they read them under, and a save moves both on. The installation owner accepted this on
 * 12 Nov 2026 on condition that the page says so before Save. Every page that saves an agent's
 * definition shows this one sentence; to withdraw it, change only this file.
 */
export const SAVE_ENDS_CONVERSATIONS =
  "Saving a change ends this agent's open web-chat conversations, and any approval waiting in them. Start a new conversation afterwards.";

export function SaveEndsConversations() {
  return <TakesEffect text={SAVE_ENDS_CONVERSATIONS} />;
}
