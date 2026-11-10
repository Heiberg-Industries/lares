/**
 * Is the person in this private conversation the agent's current owner?
 *
 * The owner is read the same way the agent mailbox reads it (`loadOwner`: `agent_access`, for a ready,
 * valid, runtime-controlled agent). The person is the console admission pinned to the session when it
 * began, never anything the model or the input says. ANY failure (no admission, not a human turn,
 * not a managed agent, a lookup error) means "not the owner".
 */
import { getPool } from "@lares/agent-kit/db";
import { consoleAdmission } from "@lares/agent-kit/console-turn-authority";
import { managedIdentity } from "@lares/agent-kit/door-authority";

type Lookup = (agent: string, incarnation: string) => Promise<string | null>;
const defaultLookup: Lookup = async (agent, incarnation) => {
  const { loadOwner } = await import("./agent-mailbox.js");
  return loadOwner(getPool(), agent, incarnation);
};

export async function callerIsAgentOwner(ctx: unknown, lookup: Lookup = defaultLookup): Promise<boolean> {
  try {
    const s = (ctx as { session?: { auth?: { current?: unknown; initiator?: unknown } | null; initiator?: unknown } } | undefined)?.session;
    const initial = consoleAdmission(s?.auth?.initiator ?? s?.initiator);
    if (!initial || initial.purpose !== "human") return false;
    // A turn that carries its own human admission must be the same person who opened the session.
    const current = consoleAdmission(s?.auth?.current);
    if (current && (current.purpose !== "human" || current.memberId !== initial.memberId)) return false;
    const own = managedIdentity(process.env);
    if (!own) return false;
    const owner = await lookup(own.name, own.incarnation);
    return typeof owner === "string" && owner.length > 0 && owner === initial.memberId;
  } catch {
    return false;
  }
}
