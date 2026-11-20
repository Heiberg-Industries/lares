// "Your accounts": the member's own connected accounts as the flat list the page shows.
// Pure on purpose: the page reads the data, this only shapes it.
import type { ConnectedAccountView } from "@lares/agent-kit/authority-contract";

export type AccountService = "google" | "microsoft";
export type AccountStatusWord = "Working" | "Needs reconnect" | "Failed";
export interface AccountEntry {
  id: string; service: AccountService; serviceName: string; label: string; generation: number;
  ok: boolean; revoked: boolean;
  status: AccountStatusWord;
  /** When the account was last read successfully, when that is recorded. */
  lastRead?: string;
  /** The agents working on this account. */
  usedBy: string[];
  /** The plain sentence about a problem, naming the address. Absent when the account works. */
  problem?: string;
}

/** What a problem account says on this page, naming the address. Not the agent page's mailbox wording. */
const PROBLEM: Record<Exclude<ConnectedAccountView["status"], "ok">, (address: string, provider: string) => string> = {
  needs_reconsent: a => `${a} needs your permission again. Reconnect it.`,
  revoked: (a, provider) => `${a} was disconnected at ${provider}. Reconnect it to use it again.`,
  error: a => `${a} could not be checked. Try reconnecting it.`,
};
export function accountProblemSentence(status: Exclude<ConnectedAccountView["status"], "ok">, address: string, used: boolean, provider = "Google"): string {
  return PROBLEM[status](address, provider) + (used ? " An agent that works on it is paused until then." : "");
}

/** One word per account. Permission asked again and a disconnected account both need the person to reconnect. */
export function accountStatusWord(status: ConnectedAccountView["status"]): AccountStatusWord {
  return status === "ok" ? "Working" : status === "error" ? "Failed" : "Needs reconnect";
}

const NAMES: Record<AccountService, string> = { google: "Google", microsoft: "Microsoft" };

export function buildAccountList(accounts: readonly ConnectedAccountView[], uses: readonly { agent: string; accountId: string }[]): AccountEntry[] {
  const list: AccountEntry[] = [];
  for (const a of accounts) {
    if (a.connectorId !== "google" && a.connectorId !== "microsoft") continue;
    const used = uses.filter(u => u.accountId === a.id);
    list.push({
      id: a.id, service: a.connectorId, serviceName: NAMES[a.connectorId], label: a.providerAccount.label, generation: a.generation,
      ok: a.status === "ok", revoked: a.status === "revoked", status: accountStatusWord(a.status),
      ...(a.lastUsedAt ? { lastRead: a.lastUsedAt } : {}),
      usedBy: [...new Set(used.map(u => u.agent))],
      ...(a.status !== "ok" ? { problem: accountProblemSentence(a.status, a.providerAccount.label, used.length > 0, NAMES[a.connectorId]) } : {}),
    });
  }
  return list;
}
