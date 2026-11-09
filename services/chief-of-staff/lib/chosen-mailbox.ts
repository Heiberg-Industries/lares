/**
 * The mailbox the agent's owner chose, opened once and shared by every reader in this process.
 *
 * This is the cache and the policy only: no Gmail, Calendar or Drive client is built here, and nothing
 * here writes. `lib/google.ts` (mail and calendar) and `lib/google-drive.ts` (Drive, read by `read_url`)
 * both go through it, so a window of many calls costs one refresh and every reuse is rechecked, with no
 * second refresh path. It lives apart from google.ts so the Drive reader does not import Gmail send code.
 */
import type { AgentMailboxDeps, AgentMailboxResult } from "./agent-mailbox.js";

const CHOSEN_WORK_MS = 10 * 60_000;
const CHOSEN_WINDOW_MS = 9 * 60_000;
const CHOSEN_UNAVAILABLE_MS = 30_000;
let chosenCache: { until: number; result: Promise<AgentMailboxResult> } | null = null;
let chosenDeps: AgentMailboxDeps = {};
/** Test seam: the pool, HTTP layer and definition the chosen-mailbox opening uses. Also forgets the open mailbox. */
export function __setChosenMailboxDepsForTests(deps: AgentMailboxDeps = {}): void { chosenDeps = deps; chosenCache = null; }

/** Test seam: pretend this mailbox result is open (null forgets it). */
export function __setChosenMailboxForTests(result: AgentMailboxResult | null): void {
  chosenCache = result ? { until: Number.POSITIVE_INFINITY, result: Promise.resolve(result) } : null;
}

export async function chosenMailbox(): Promise<AgentMailboxResult> {
  const hit = chosenCache;
  if (hit && hit.until > Date.now()) {
    const r = await hit.result;
    if (!r.ok || (await r.recheck())) return r;
    if (chosenCache === hit) chosenCache = null;
  }
  // Loaded on use: agent-mailbox builds on lib/google.ts.
  const { agentMailbox } = await import("./agent-mailbox.js");
  const entry = { until: Number.POSITIVE_INFINITY, result: agentMailbox("mail-readers", { ...chosenDeps, workMs: CHOSEN_WORK_MS }) };
  chosenCache = entry;
  const r = await entry.result;
  entry.until = Date.now() + (r.ok ? CHOSEN_WINDOW_MS : r.reason === "unavailable" ? CHOSEN_UNAVAILABLE_MS : 0);
  return r;
}

/** Nothing is chosen, or this process is not a managed agent. */
export const noMailbox = (r: AgentMailboxResult): boolean => !r.ok && (r.reason === "none" || r.reason === "not-managed");

export async function mailboxRefusal(message: string): Promise<Error> {
  const { AgentMailboxRefusedError } = await import("./agent-mailbox.js");
  return new AgentMailboxRefusedError(message);
}
/** The stored choice stopped holding (disconnected, reconnected, owner changed, ...). */
export const staleChoiceError = (): Promise<Error> =>
  mailboxRefusal("This agent's mailbox choice no longer holds; reconnect it in the console");
