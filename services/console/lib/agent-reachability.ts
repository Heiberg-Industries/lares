/**
 * Telling "the agent is not running" apart from "this conversation is gone or not yours".
 *
 * The chat proxy (`lib/chat-proxy.ts`) marks the two answers that mean the agent itself cannot be
 * reached — it is not registered as ready, or its door did not answer — with this header. A 403
 * (access refused) and an answer that came from the agent never carry it. The chat page asks once
 * when a conversation fails (no polling) and words the failure by what comes back.
 */
export const AGENT_STATE_HEADER = "x-lares-agent-state";
export const AGENT_NOT_RUNNING = "not-running";

/** The one asking: the agent's health route through the proxy. True only for the proxy's own
 *  not-running mark; any other answer, or no answer at all, is "do not know" (false). */
export async function agentNotRunning(name: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await doFetch(`/api/chat/${encodeURIComponent(name)}/eve/v1/health`, { cache: "no-store" });
    return response.headers.get(AGENT_STATE_HEADER) === AGENT_NOT_RUNNING;
  } catch {
    return false;
  }
}

/** The plain words, and the command that fixes it. Same instruction as the "not started yet" page. */
export function notRunningSay(displayName: string, name: string): string {
  return `${displayName} is not running right now. On the server, run: sudo lares agent start ${name}`;
}
