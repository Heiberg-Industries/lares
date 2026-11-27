// The agent edit page's one owner of Apply and Start: it calls the keeper, keeps the runtime state
// the keeper answered with, and, while a started agent is not answering yet, re-reads that state by
// itself with `useKeepFresh` until it answers or ten minutes have passed (`agent-apply-status.ts`).
// The Status card and the Connect doors section both go through it, so a restart is followed and
// worded the same way wherever it was started from.
import { useEffect, useRef, useState } from "react";
import { agentRuntime, applyConnections } from "../app/actions/definition";
import type { RuntimeState } from "./builder";
import { agentRunStatus, APPLYING_WHY, type AgentRunView, type ApplyRun } from "./agent-apply-status";
import { useKeepFresh } from "./use-keep-fresh";

/** A failed Apply, carrying whether its outcome is known, in the shapes both callers read. */
export class ApplyFailedError extends Error {
  readonly outcomeMayBeUnknown: boolean;
  /** DoorSetup's name for the same thing. */
  readonly unknown: boolean;
  constructor(message: string, outcomeMayBeUnknown: boolean) {
    super(message);
    this.name = "ApplyFailedError";
    this.outcomeMayBeUnknown = outcomeMayBeUnknown;
    this.unknown = outcomeMayBeUnknown;
  }
}

export interface AgentRuntimeControl {
  runtime: RuntimeState | undefined;
  /** Where the last Apply or Start (or a start that is not answering yet) stands; null when nothing is. */
  status: AgentRunView | null;
  /** Which section started the last Apply, so the status can also be shown there. */
  from: "status" | "doors" | null;
  /** Apply the saved definition `hash` (restarts the agent). Throws `ApplyFailedError` when it fails. */
  apply(hash: string, opts?: { label?: string; from?: "status" | "doors" }): Promise<RuntimeState | undefined>;
  /** Re-read the runtime state; an unreadable state shows as unavailable, never as the old one. */
  reread(): Promise<void>;
  /** A save answered with this runtime state: it replaces the last Apply's outcome. */
  saved(next: RuntimeState | undefined): void;
  /** When the last Apply succeeded (this browser's clock), so other sections re-read what it changed. */
  appliedAt: number | null;
}

const notAnswering = (r: RuntimeState | undefined) => r?.running === true && r.healthy === false;

export function useAgentRuntime(name: string | undefined, initial: RuntimeState | undefined): AgentRuntimeControl {
  const [runtime, setRuntimeState] = useState(initial);
  const [run, setRun] = useState<ApplyRun>({ phase: "idle" });
  const [from, setFrom] = useState<"status" | "doors" | null>(null);
  // When this page first saw the agent started and not answering; the ten minutes count from here.
  const [since, setSince] = useState<number | null>(() => (notAnswering(initial) ? Date.now() : null));
  // Reads in a row that failed while a start was being followed: the start state is kept and asked
  // again. A count, not a flag, so every failure re-renders and the ten-minute limit can still end it.
  const [readFailures, setReadFailures] = useState(0);
  const latest = useRef(runtime);
  useEffect(() => { latest.current = runtime; }, [runtime]);

  function setRuntime(next: RuntimeState | undefined) {
    setRuntimeState(next);
    setReadFailures(0);
    setSince((s) => (notAnswering(next) ? (s ?? Date.now()) : null));
  }
  async function reread() {
    if (!name) return;
    let read: Awaited<ReturnType<typeof agentRuntime>> | null = null;
    try { read = await agentRuntime(name); } catch { read = null; }
    if (read?.ok) { setRuntime(read.result); return; }
    // While a start is being followed, one failed read is not an answer: keep following (the ten
    // minutes still count). Otherwise an unreadable state shows as unavailable, never as the old one.
    if (notAnswering(latest.current)) { setReadFailures((n) => n + 1); return; }
    setRuntime(undefined);
  }
  const status = agentRunStatus(run, runtime, Date.now(), since, readFailures > 0);
  useKeepFresh(status?.active === true, reread);

  async function apply(hash: string, opts: { label?: string; from?: "status" | "doors" } = {}) {
    if (!name) throw new ApplyFailedError("This agent has no name yet.", false);
    setFrom(opts.from ?? "status");
    setRun({ phase: "applying", label: opts.label ?? APPLYING_WHY });
    let response: Awaited<ReturnType<typeof applyConnections>>;
    try {
      response = await applyConnections({ name, hash });
    } catch {
      const why = "The console could not reach the server, so it is not known whether the agent restarted.";
      setRun({ phase: "failed", at: Date.now(), why });
      throw new ApplyFailedError(why, true);
    }
    if (!response.ok) {
      setRun({ phase: "failed", at: Date.now(), why: response.error.message });
      // A failed Apply can leave the agent on the earlier definition, or stopped: read what it is now.
      void reread();
      throw new ApplyFailedError(response.error.message, response.error.outcomeMayBeUnknown);
    }
    setRun({ phase: "applied", at: Date.now() });
    if (response.result) setRuntime(response.result);
    else await reread();
    return response.result;
  }

  function saved(next: RuntimeState | undefined) {
    setRun({ phase: "idle" });
    setFrom(null);
    setRuntime(next);
  }

  return { runtime, status, from, apply, reread, saved, appliedAt: run.phase === "applied" ? run.at : null };
}
