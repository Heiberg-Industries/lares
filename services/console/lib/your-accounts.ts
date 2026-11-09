// "Your accounts": the member's own connected accounts, grouped into the service rows the page shows.
// Pure on purpose: the page reads the data, this only shapes it.
import type { ConnectedAccountView } from "@lares/agent-kit/authority-contract";

export type AccountService = "google" | "microsoft";
export interface AccountOption { id: string; label: string; generation: number; ok: boolean; revoked: boolean }

/** What a problem account says on this page, naming the address. Not the agent page's mailbox wording. */
const PROBLEM: Record<Exclude<ConnectedAccountView["status"], "ok">, (address: string) => string> = {
  needs_reconsent: a => `${a} needs your permission again. Reconnect it.`,
  revoked: a => `${a} was disconnected at Google. Reconnect it to use it again.`,
  error: a => `${a} could not be checked. Try reconnecting it.`,
};
export function accountProblemSentence(status: Exclude<ConnectedAccountView["status"], "ok">, address: string, used: boolean): string {
  return PROBLEM[status](address) + (used ? " An agent that works on it is paused until then." : "");
}
export interface ServiceRow {
  service: AccountService;
  name: string;
  line: string;
  accounts: AccountOption[];
  /** Agents working on one of these accounts. */
  usedBy: string[];
  /** The plain sentence about the first account that needs the member's attention, when none works. */
  attention?: string;
}

const SERVICES: { service: AccountService; name: string; line: string }[] = [
  { service: "google", name: "Google", line: "Gmail, Calendar and Drive" },
  { service: "microsoft", name: "Microsoft", line: "Work mailbox and calendar" },
];

export function buildServiceRows(accounts: readonly ConnectedAccountView[], uses: readonly { agent: string; accountId: string }[]): ServiceRow[] {
  return SERVICES.map(({ service, name, line }) => {
    const mine = accounts.filter(a => a.connectorId === service);
    const options = mine.map(a => ({
      id: a.id, label: a.providerAccount.label, generation: a.generation, ok: a.status === "ok", revoked: a.status === "revoked",
    }));
    const ids = new Set(mine.map(a => a.id));
    const usedBy = [...new Set(uses.filter(u => ids.has(u.accountId)).map(u => u.agent))];
    const bad = mine.find(a => a.status !== "ok");
    const attention = bad && bad.status !== "ok" && !options.some(o => o.ok)
      ? accountProblemSentence(bad.status, bad.providerAccount.label, uses.some(u => u.accountId === bad.id)) : undefined;
    return { service, name, line, accounts: options, usedBy, ...(attention !== undefined ? { attention } : {}) };
  });
}
