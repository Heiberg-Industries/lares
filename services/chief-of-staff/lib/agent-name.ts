// The agent's own name, as the keeper hands it to the container (LARES_AGENT_NAME, taken from the
// agent's definition folder). Every table that records "which agent" (ratchet, reminders,
// initiations, the digest queue) is keyed by it, so a schedule, a tool and the console agree on it
// by reading it, never by spelling it. The fallback is the role's own name, for a run with no
// keeper (a test, a one-off script).
export const ROLE_NAME = "chief-of-staff";

export function agentName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env["LARES_AGENT_NAME"]?.trim();
  return name ? name : ROLE_NAME;
}
