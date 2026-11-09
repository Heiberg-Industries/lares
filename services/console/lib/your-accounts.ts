// "Your accounts": the member's own connected accounts, grouped into the service rows the page shows.
// Pure on purpose: the page reads the data, this only shapes it.
import type { ConnectedAccountView } from "@lares/agent-kit/authority-contract";

export type AccountService = "google" | "microsoft";
export interface AccountOption { id: string; label: string; generation: number; ok: boolean; revoked: boolean }
export interface ServiceRow {
  service: AccountService;
  name: string;
  line: string;
  accounts: AccountOption[];
  /** Agents working on one of these accounts. */
  usedBy: string[];
  /** Address of the first account that needs the member's attention, if any. */
  attention?: string;
}

const SERVICES: { service: AccountService; name: string; line: string }[] = [
  { service: "google", name: "Google", line: "Gmail and Calendar" },
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
    const attention = options.find(o => !o.ok)?.label;
    return { service, name, line, accounts: options, usedBy, ...(attention !== undefined ? { attention } : {}) };
  });
}
