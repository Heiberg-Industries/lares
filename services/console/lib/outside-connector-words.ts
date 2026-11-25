// The sentences the outside-tools pages use for a connector. No server code: client components import it.
export type ConnectorAuth = "none" | "token" | "signin";
export type ConnectorStateName = "setup" | "connected" | "retired";

/** One sentence on what the check of the server found. */
export function foundSentence(kind: ConnectorAuth): string {
  if (kind === "none") return "Found the server. It needs no login.";
  if (kind === "token") return "Found the server. It asks for a token.";
  return "Found the server. It uses a sign-in page, and sign-in comes in a later release, so it cannot be used yet.";
}

export function stateWords(state: ConnectorStateName, auth: ConnectorAuth, agents: number): string {
  if (auth === "signin") return "Sign-in comes later";
  if (state === "setup" && agents === 0) return "Setting up";
  return agents === 0 ? "Not used yet" : "Connected";
}

export function stateTone(state: ConnectorStateName, auth: ConnectorAuth, agents: number): "quiet" | "attention" | "success" | "error" {
  if (auth === "signin") return "attention";
  if (agents > 0) return "success";
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
