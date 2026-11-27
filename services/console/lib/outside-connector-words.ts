// The sentences the outside-tools pages use for a connector. No server code: client components import it.
import { RUN_STATES } from "@lares/ui/patterns";
export type ConnectorAuth = "none" | "token" | "signin";
export type ConnectorStateName = "setup" | "connected" | "retired";

/** One sentence on what the check of the server found. */
export function foundSentence(kind: ConnectorAuth): string {
  if (kind === "none") return "Found the server. It needs no login.";
  if (kind === "token") return "Found the server. It asks for a token.";
  return "Found the server. It uses a sign-in page, and sign-in comes in a later release, so it cannot be used yet.";
}

/**
 * How one agent's saved connection stands against what the agent runs, from the keeper's own read
 * (`outside.connections.get`, its `applicationStatus`, `appliedConnections` and `waitingForKey`):
 * `applied`, the agent runs it as saved; `pending`, saved and not applied yet (the agent restarts when
 * it is); `waiting-key`, left out of the agent until its token is stored; `unavailable`, the keeper
 * cannot tell, because the agent has never been started with a saved definition.
 */
export type ConnectionApplication = "applied" | "pending" | "waiting-key" | "unavailable";

/** Per agent name, per connection name. An agent whose state could not be read is absent. */
export type ApplicationStates = Record<string, Record<string, ConnectionApplication>>;

/** Whether a connector reached the agents that have it. Its words follow the status words (ADR 0031). */
export interface ConnectorReach { state: "connected" | "waiting" | "failed" | "unknown"; why?: string }

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Pure. Connected only when every agent that has the connector runs it as saved. One that cannot be
 * told is Failed, with why; one still to be applied, or waiting for its token, is Waiting, with why.
 * `states` null: nothing could be read, so nothing is claimed.
 */
export function connectorReach(slug: string, uses: readonly { agent: string; displayName: string }[], states: ApplicationStates | null): ConnectorReach {
  if (uses.length === 0) return { state: "unknown" };
  if (states === null) return { state: "unknown", why: "Whether it reached the agents could not be read just now." };
  const by = (s: ConnectionApplication | undefined) => uses.filter((u) => states[u.agent]?.[slug] === s).map((u) => u.displayName);
  const unread = uses.filter((u) => states[u.agent]?.[slug] === undefined).map((u) => u.displayName);
  const unavailable = by("unavailable"), pending = by("pending"), key = by("waiting-key");
  if (unavailable.length) {
    const one = unavailable.length === 1;
    return { state: "failed", why: `Lares cannot tell whether ${listNames(unavailable)} ${one ? "uses" : "use"} it, because ${one ? "it has" : "they have"} not been started with a saved definition yet. Start ${one ? "it" : "them"} in Edit agent.` };
  }
  if (pending.length || key.length) {
    const parts = [
      ...(pending.length ? [`Saved for ${listNames(pending)}, not applied yet. It takes effect when the agent restarts with Apply in Edit agent.`] : []),
      ...(key.length ? [`Waiting for its token for ${listNames(key)}.`] : []),
    ];
    return { state: "waiting", why: parts.join(" ") };
  }
  if (unread.length) return { state: "unknown", why: `Whether it reached ${listNames(unread)} could not be read just now.` };
  return { state: "connected" };
}

/** The badge for whether a connection reached its agents. */
export function reachWords(reach: ConnectorReach): string {
  return { connected: "Connected", waiting: RUN_STATES.waiting.label, failed: RUN_STATES.failed.label, unknown: "Status unavailable" }[reach.state];
}

export function reachTone(reach: ConnectorReach): "quiet" | "attention" | "success" | "error" {
  return { connected: "success" as const, waiting: "attention" as const, failed: "error" as const, unknown: "quiet" as const }[reach.state];
}

export function stateWords(state: ConnectorStateName, auth: ConnectorAuth, agents: number, reach: ConnectorReach): string {
  if (auth === "signin") return "Sign-in comes later";
  if (state === "setup" && agents === 0) return "Setting up";
  return agents === 0 ? "Not used yet" : reachWords(reach);
}

export function stateTone(state: ConnectorStateName, auth: ConnectorAuth, agents: number, reach: ConnectorReach): "quiet" | "attention" | "success" | "error" {
  if (auth === "signin") return "attention";
  if (agents > 0) return reachTone(reach);
  return state === "setup" ? "attention" : "quiet";
}

export function nextActionWords(state: ConnectorStateName, auth: ConnectorAuth, agents: number): string {
  if (auth === "signin") return "Waits for sign-in";
  if (agents === 0) return "Choose who can use it";
  return state === "setup" ? "Continue" : "Open";
}

export function authWords(auth: ConnectorAuth): string {
  return auth === "none" ? "No login" : auth === "token" ? "Token" : "Sign-in page";
}

export const REMOVE_WARNING = "Removing takes this connector off every agent and deletes the token Lares holds for it. Running agents restart, which ends their open conversations.";
