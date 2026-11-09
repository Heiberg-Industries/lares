// Which of the owner's Google mailboxes an agent works on: the screen's data and its one set of
// plain sentences. Everything here is derived on the server; the page and the route both call it.
import { PgAccountStore } from "@lares/agent-kit/account-store";
import {
  AgentMailboxRefused, PgAgentMailboxStore, agentMayUsePersonalMailbox,
  type AgentMailboxReason, type AgentMailboxRefusal,
} from "@lares/agent-kit/agent-mailbox-store";
import { parseDefinition, type AgentDefinition } from "@lares/agent-kit/definition";
import { validateGooglePersonalScopes } from "@lares/agent-kit/personal-consent";
import { pool } from "./db";
import { googleOrgs } from "./accounts";

export type MailboxSentenceKey = AgentMailboxReason | AgentMailboxRefusal
  | "working" | "view-unavailable" | "no-account" | "google-not-configured" | "definition-unavailable";

const LINE = "Sorts new mail and writes reply drafts in Gmail, and can read your Drive files. It never sends.";
/** The only place a mailbox state or refusal becomes a sentence. A later redesign reuses it. */
const SENTENCES: Record<MailboxSentenceKey, (address: string) => string> = {
  working: () => LINE,
  none: () => `${LINE} No mailbox is chosen yet, so it does not sort mail.`,
  "view-unavailable": () => "The mailbox setting could not be loaded. Reload this page to try again.",
  "no-account": () => "No mailbox. Connect your Google account first, then choose it here.",
  "google-not-configured": () => "Google is not set up on this installation yet, so no mailbox can be chosen.",
  "generation-changed": a => `You reconnected ${a || "that account"}. Confirm that this agent may keep working on it.`,
  "account-not-ok": a => `${a || "That account"} was disconnected or needs your permission again. Reconnect it, or choose another mailbox.`,
  "scopes-not-draft": a => `${a || "That account"} can be read, but this agent may not write drafts in it. Reconnect it with “read + drafts”, which also lets the agent read your Drive files.`,
  "owner-changed": () => "This agent changed owner after its mailbox was chosen. Choose again.",
  "member-inactive": () => "Your membership is not active, so this agent cannot use your mailbox.",
  "not-granted": () => "This agent’s definition has no Gmail permission. Add one in Edit agent.",
  "not-owner": () => "Only this agent’s owner can choose its mailbox.",
  "account-unavailable": () => "That account is not available. Choose one of your connected Google accounts.",
  "definition-unavailable": () => "This agent’s definition could not be read. Reload this page to try again.",
};
export const accountStatusLabel = (key: MailboxSentenceKey, address = ""): string => SENTENCES[key](address);

export interface MailboxOption { accountId: string; resourceBindingId: string; address: string; canDraft: boolean }
export interface AgentMailboxViewDTO {
  agent: string;
  state: "unavailable" | "not-yours" | "google-not-configured" | "no-gmail-permission" | "no-account" | "choose" | "working" | "paused";
  title: "Mailbox" | "Mailbox paused";
  sentence: string;
  /** The owner's connected Google accounts that can be chosen. */
  options: MailboxOption[];
  /** The stored choice, even when it is paused. */
  chosen?: { accountId: string; resourceBindingId: string; address: string };
  /** Show "Confirm": the chosen account was reconnected and still allows drafts. */
  confirm?: boolean;
  /** Show "Reconnect" with the drafts permission: the chosen account's current generation. */
  reconnect?: { accountId: string; generation: number };
}

/** The member's Google accounts that can be chosen: connected, with a mailbox. */
export async function mailboxAccountOptions(member: { id: string }): Promise<MailboxOption[]> {
  return new PgAccountStore(pool).transaction(member.id, async db => {
    const { rows } = await db.query<{ account_id: string; resource_id: string; label: string; scopes: string[] | null }>(
      `SELECT c.id AS account_id, r.id AS resource_id, c.provider_label AS label,
         (SELECT t.scopes FROM connected_account_credentials cc
            JOIN oauth_tokens t ON t.id=cc.oauth_token_id AND t.principal=cc.owner_member_id AND t.provider=cc.connector_id
           WHERE cc.account_id=c.id AND cc.owner_member_id=c.owner_member_id AND cc.account_generation=c.generation) AS scopes
       FROM connected_accounts c
       JOIN connected_resource_bindings r ON r.connected_account_id=c.id AND r.owner_member_id=c.owner_member_id AND r.resource_kind='mailbox'
      WHERE c.owner_member_id=$1 AND c.connector_id='google' AND c.status='ok'
      ORDER BY c.provider_label, c.id`, [member.id]);
    return rows.map(r => {
      let canDraft = false;
      try { if (r.scopes) { validateGooglePersonalScopes(r.scopes, "read+mail-draft"); canDraft = true; } } catch { /* read-only consent */ }
      return { accountId: r.account_id, resourceBindingId: r.resource_id, address: r.label, canDraft };
    });
  });
}

/** Which agent works on which of this member's accounts. */
export async function listAgentUses(member: { id: string }): Promise<{ agent: string; accountId: string }[]> {
  return new PgAccountStore(pool).transaction(member.id, async db => {
    const { rows } = await db.query<{ agent: string; account_id: string }>(
      "SELECT agent, connected_account_id AS account_id FROM agent_account_bindings WHERE owner_member_id=$1 AND purpose='mailbox' ORDER BY agent",
      [member.id]);
    return rows.map(r => ({ agent: r.agent, accountId: r.account_id }));
  });
}

/** The agent's definition as the database holds it; undefined when it is missing or invalid. */
export async function agentDefinitionFor(agent: string): Promise<AgentDefinition | undefined> {
  const row = (await pool.query<{ definition: unknown }>(
    "SELECT definition FROM agent_definitions WHERE name=$1 AND status='valid'", [agent])).rows[0];
  if (!row) return undefined;
  try { return parseDefinition(row.definition); } catch { return undefined; }
}

/** Shown instead of the section when its data could not be loaded: one line, no control. */
export function mailboxUnavailableView(agent: string): AgentMailboxViewDTO {
  return { agent, state: "unavailable", title: "Mailbox", sentence: accountStatusLabel("view-unavailable"), options: [] };
}

export async function agentMailboxView(member: { id: string }, agent: string, definition: AgentDefinition,
  options: { googleConfigured?: boolean } = {}): Promise<AgentMailboxViewDTO> {
  const base = { agent, title: "Mailbox" as const, options: [] as MailboxOption[] };
  const say = (state: AgentMailboxViewDTO["state"], key: MailboxSentenceKey, extra: Partial<AgentMailboxViewDTO> = {}): AgentMailboxViewDTO =>
    ({ ...base, state, sentence: accountStatusLabel(key), ...extra });
  const owner = (await pool.query<{ owner_member_id: string }>(
    "SELECT owner_member_id FROM agent_access WHERE agent_name=$1", [agent])).rows[0]?.owner_member_id;
  if (owner !== member.id) return say("not-yours", "not-owner");
  if (!(options.googleConfigured ?? googleOrgs().length > 0)) return say("google-not-configured", "google-not-configured");
  if (!agentMayUsePersonalMailbox(definition)) return say("no-gmail-permission", "not-granted");

  const choices = await mailboxAccountOptions(member);
  const view = await new PgAgentMailboxStore(pool).get(member.id, agent);
  if (!view.binding) {
    return choices.length ? say("choose", "none", { options: choices }) : say("no-account", "no-account");
  }
  const { binding } = view;
  const chosen = { accountId: binding.accountId, resourceBindingId: binding.resourceBindingId, address: binding.accountLabel };
  const reason = view.reason;
  if (!reason) return { ...base, state: "working", sentence: accountStatusLabel("working"), options: choices, chosen };
  const account = await new PgAccountStore(pool).read(member.id, binding.accountId).catch(() => undefined);
  const paused = (extra: Partial<AgentMailboxViewDTO> = {}): AgentMailboxViewDTO => ({
    ...base, state: "paused", title: "Mailbox paused", sentence: accountStatusLabel(reason, chosen.address), options: choices, chosen, ...extra });
  const reconnect = account ? { accountId: account.id, generation: account.generation } : undefined;
  if (reason === "generation-changed") return paused({ confirm: true });
  return paused(reason === "scopes-not-draft" || reason === "account-not-ok" ? { ...(reconnect ? { reconnect } : {}) } : {});
}

/** What a refused choice says. */
export function refusalSentence(error: unknown): { code: string; sentence: string } {
  if (error instanceof AgentMailboxRefused) return { code: error.reason, sentence: accountStatusLabel(error.reason) };
  return { code: "outcome-unknown", sentence: "The result is not certain. Reload this page to see what was saved." };
}
