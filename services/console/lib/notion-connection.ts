// services/console/lib/notion-connection.ts
//
// The words of the Notion page's top line and its two steps (Connect; Which agents may use Notion),
// decided here once from the keeper's credential status so the page and its tests read the same
// thing. Pure: it reads nothing, so the browser part of the page imports it too.
//
// What is true underneath (services/keeper/lib/credential-*.ts), unchanged by this file:
//   - a new key is saved apart from the one in use ("candidate") and checked against Notion at once;
//   - only a key that passed its check can be started ("pending-apply" → apply);
//   - starting it, stopping Notion, and switching an agent on or off restart the agents that use the
//     key; a switch that fails puts the previous key back by itself (the `rollback` progress list);
//   - an agent is given the key one at a time by a grant; the keeper honours a grant for a ready
//     chief-of-staff agent only;
//   - only the installation's credential administrator (the owner) can do any of it.
import type { CredentialStatus } from "@lares/agent-kit/credential-lifecycle";

/** An agent that may be given the Notion key: its definition name and the name people see. Read on
 *  the server by `notionAgents` (lib/notion-agents.ts); this file is pure, so the page can use it too. */
export interface NotionAgent { name: string; displayName: string }

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A name as people see it: an agent's display name, the Notion sync's plain name, else the name. */
export function shownName(name: string, names: Readonly<Record<string, string>>): string {
  return names[name] ?? (name === "notion-sync" ? "the Notion sync" : name);
}

/** Which agents get the key now: switched on here (a grant), or through the installation's own
 *  configuration (an agent that reads the key with no grant, so it has no switch). */
export function notionUsers(status: CredentialStatus): { granted: string[]; byConfig: string[]; stale: string[] } {
  const grants = status.grants ?? [];
  const granted = grants.filter((g) => !g.stale).map((g) => g.agent);
  const byConfig = status.consumers
    .filter((c) => c.category === "owned-agent" && !granted.includes(c.name))
    .map((c) => c.name);
  return { granted, byConfig, stale: grants.filter((g) => g.stale).map((g) => g.agent) };
}

/** The keeper is moving the key (or putting the old one back): the page keeps itself up to date. */
export function isSwitching(status: CredentialStatus): boolean {
  return status.state === "applying" || status.state === "disconnecting" ||
    status.phase === "applying" || status.phase === "disconnecting" || status.phase === "rolling-back";
}

/** The last switch failed and the previous key was put back: the keeper keeps that run's rollback
 *  list until the next switch starts. */
export function switchWasUndone(status: CredentialStatus): boolean {
  return !isSwitching(status) && status.rollback.length > 0;
}

/** Step 1 is done: a key is in use and nothing is half-way. */
export function isConnected(status: CredentialStatus): boolean {
  return !!status.activeRevision && status.state === "applied" && !status.guidance;
}

/** The plain answer to the last check of a key. The check proves the key is valid; it does not say
 *  which pages the connection can read. Null when no check is recorded. */
export function checkLine(status: CredentialStatus): string | null {
  const t = status.test;
  if (!t) return null;
  switch (t.outcome) {
    case "passed": return "Lares reached Notion with this key.";
    case "refused": return "Notion refused this key — copy it again from Notion.";
    case "unavailable": return "Your server could not reach Notion.";
    case "rate-limited": return "Notion asked Lares to wait. Check again in a minute.";
    case "unexpected": return "Notion gave an answer Lares did not expect. Check again in a minute.";
  }
}

/** The last check was of the key in use, and it could not reach Notion. */
export function cannotReach(status: CredentialStatus): boolean {
  return !!status.activeRevision && status.test?.revision === status.activeRevision && status.test.outcome === "unavailable";
}

/** The one sentence at the top of the page. `names` maps an agent's definition name to its display name. */
export function topSentence(status: CredentialStatus | null, names: Readonly<Record<string, string>>): string {
  if (!status || status.state === "unavailable") return "Lares cannot read the state of the Notion connection right now. Reload the page in a minute.";
  if (isSwitching(status)) {
    const restarting = status.consumers.map((c) => shownName(c.name, names));
    const what = status.phase === "rolling-back" ? "That did not work; going back to the previous key"
      : status.state === "disconnecting" || status.phase === "disconnecting" ? "Stopping Notion in Lares"
      : status.candidateRevision ? "Switching to the new key"
      : "Changing which agents may use Notion";
    return restarting.length
      ? `${what}; ${listNames(restarting)} ${restarting.length === 1 ? "restarts" : "restart"} for a moment.`
      : `${what}.`;
  }
  if (status.guidance === "inspect-journal" || status.state === "recovery-required") return "A change to the Notion key stopped half-way. Ask whoever runs your server to look at it.";
  if (status.guidance) return "Notion is not connected yet: this server is not ready to keep a Notion key.";
  if (!status.activeRevision) return "Notion is not connected yet.";
  if (cannotReach(status)) return "Lares cannot reach Notion from your server: ask whoever runs your server to let it reach api.notion.com, then check the key again.";
  const { granted, byConfig } = notionUsers(status);
  const users = [...granted, ...byConfig].map((n) => shownName(n, names));
  return users.length
    ? `Notion is connected; ${listNames(users)} may use it.`
    : "Notion is connected; no agent may use it yet. Choose one below.";
}
