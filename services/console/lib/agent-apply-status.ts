// Where an agent's restart stands after Apply or Start, for the agent edit page (its Status card and
// its Connect doors section). No server code: client components import it.
//
// Apply and Start ask the keeper to (re)start the agent on its saved definition and wait for the
// answer (`definition.reconcile`, up to 90 seconds). The answer is the runtime state the keeper
// reads, `{ pending, reason, running, healthy }`, or a failure that says what the agent was left
// on: back on the earlier definition, restored but stopped, or needing recovery. A start can come
// back "running, not answering yet" (a first start after an upgrade can take minutes); the page
// then keeps reading the runtime state by itself until the agent answers (ADR 0031).
import type { RunState } from "@lares/ui/patterns";
import type { RuntimeState } from "./builder";

/** What the page knows about its own last Apply or Start. */
export type ApplyRun =
  | { phase: "idle" }
  | { phase: "applying"; label: string }
  | { phase: "applied"; at: number }
  | { phase: "failed"; at: number; why: string };

/** Ready for `RunStatus`. `active`: keep reading the runtime state. */
export interface AgentRunView { state: RunState; when?: string; why?: string; active: boolean }

/** A started agent that is still not answering after this long is shown as failed, and the page stops asking. */
export const NOT_ANSWERING_MS = 10 * 60_000;

export const APPLYING_WHY = "Restarting the agent with the saved definition. This takes about a minute. Keep this page open.";
export const STARTING_WHY = "Started, not answering yet. A first start after an upgrade can take several minutes. This page checks by itself.";
export const ANSWERING_WHY = "Running and answering.";
export const NOT_ANSWERING_WHY = "Started, but still not answering after 10 minutes. Its log says why.";

/** "at 14:03", on this browser's clock: the time the page itself saw it happen. */
export function atTime(at: number): string {
  const d = new Date(at);
  return `at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Pure. `notAnsweringSince`: when this page first saw the agent running and not answering (null
 * when it has not). null result: nothing in progress or just finished, so the page shows its plain
 * sentence about the agent instead.
 */
export function agentRunStatus(run: ApplyRun, runtime: RuntimeState | undefined, now: number, notAnsweringSince: number | null): AgentRunView | null {
  if (run.phase === "applying") return { state: "running", why: run.label || APPLYING_WHY, active: false };
  if (run.phase === "failed") return { state: "failed", when: atTime(run.at), why: run.why, active: false };
  if (runtime?.running === true && runtime.healthy === false) {
    if (notAnsweringSince !== null && now - notAnsweringSince >= NOT_ANSWERING_MS) {
      return { state: "failed", why: NOT_ANSWERING_WHY, active: false };
    }
    return { state: "running", why: STARTING_WHY, active: true };
  }
  if (run.phase === "applied" && runtime?.running === true && runtime.healthy === true) {
    return { state: "finished", when: atTime(run.at), why: ANSWERING_WHY, active: false };
  }
  return null;
}
