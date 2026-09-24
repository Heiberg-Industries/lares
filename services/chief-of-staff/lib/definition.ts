// THIS agent's definition, resolved once PER SESSION (agent-definitions spec, Part 3).
//
// WHY PER SESSION AND NOT PER PROCESS. The spec's Part 3 table resolves instructions, model,
// tools and skills at SESSION START — the model now on the session's first STEP, which eve 0.60
// made the earliest scope that can carry a constructed provider rather than a routable model id
// (packages/agent-kit/src/definition-model.ts); it is still once per conversation, before any
// model call. ADR-0015's promise to the owner is that a definition
// edited on the box "applies at the next conversation" with nothing rebuilt and nothing
// restarted. A process-lifetime memo quietly broke that: `resolveDefinition` is not itself a
// read cache (it re-reads the folder on every call — the "cache" in its name is the Postgres
// last-valid row), so memoising its promise forever meant a hand edit reached the agent only at
// the next CONTAINER, which is the frozen-agent problem this whole step exists to end.
//
// WHY A MEMO AT ALL. Four consumers read this — the instructions resolver, the model resolver,
// the approval fallback and the registry — and re-reading the folder per consumer would let two
// of them disagree WITHIN one conversation: a persona describing one set of duties while the
// approval fallback applies another. So the unit of agreement is the session. Every consumer
// that has a session passes its id (eve gives `session.id` on both `DynamicResolveContext` and
// `ApprovalContext`), and they all share that session's single read.
//
// A REJECTION IS NEVER PINNED. Pinning a rejected promise wedged the agent until restart after
// one transient database blip — the opposite of the fail-closed-but-recoverable behaviour
// `resolveDefinition` is built for.
//
// With LARES_DEFINITION_DIR unset this resolves to this service's own committed agent.json +
// agent/voice.md with no duties: the neutral default, which is what every test and every
// `eve build` sees.
//
// PATHS COME FROM process.cwd(), NOT import.meta.url. `eve build` inlines lib/ into
// .output/server/index.mjs, so at runtime `new URL("..", import.meta.url)` resolves to
// .output/server/ — two levels below the app root, and the workspace path above it would miss
// packages/ entirely. cwd is the app root by construction: eve spawns the built server with
// `cwd: resolve(appRoot)` (node_modules/eve/dist/.../start-production-server.js), and
// `registerAgent` has read the compiled manifest off cwd since ORB-278 step 1. Under vitest,
// cwd is this package's root for the same reason.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveDefinition, type Resolved } from "@lares/agent-kit/definition-cache";
import { deployedToolsFor } from "@lares/agent-kit/persona";

import manifest from "../agent.json";
import { emitSignal } from "./signal-emit.js";

/** The role template ships in the image: the builder does `COPY packages/agent-kit
 *  packages/agent-kit` (templates/ is not in .dockerignore) and the overlay's runtime stage
 *  does `COPY --from=build /app /app`, so /app/packages/agent-kit/templates/chief-of-staff/role.md
 *  is present beside the app. No Dockerfile change was needed for this. */
const ROLE_TEMPLATE = "chief-of-staff";

/** The pin instrumentation's `setup` reads under. eve documents `setup` as a non-ALS callback
 *  with no session context, and what the agent BOOTED on is genuinely a process-lifetime fact,
 *  so a process-lifetime pin is the right answer there — passed explicitly rather than inferred
 *  from a missing argument, so no caller can land on it by accident.
 *
 *  eve's session ids are uuids, so this cannot collide with one in practice; and if it somehow
 *  did, the cost is that one session shares the boot read, not that anything is mis-attributed. */
export const BOOT = "__boot__";

/** How many sessions keep a pinned definition at once. */
const MAX_PINNED = 64;

const pinned = new Map<string, Promise<Resolved>>();

/**
 * This agent's definition for `sessionId`, read once and shared by every consumer of that
 * session. Pass `BOOT` where there is no session (instrumentation's `setup`).
 *
 * The argument is REQUIRED — `thisAgent(ctx?.session?.id)` must be spelled out at every call
 * site, so that an absent id is a visible decision rather than a default.
 */
export function thisAgent(sessionId: string | undefined): Promise<Resolved> {
  // NO USABLE KEY -> A FRESH, UNPINNED READ. eve builds its resolver context as
  // `session: { id: get(SessionIdKey) ?? "" }`, and `""` is not nullish — so collapsing an
  // empty id onto a shared key would hand every conversation in the process the same definition
  // forever, with no signal. That is the bug this whole change removed, wearing a different hat.
  // Re-reading costs one folder read and is always correct.
  if (sessionId === undefined || sessionId.trim() === "") return resolveFresh();

  const hit = pinned.get(sessionId);
  if (hit !== undefined) {
    // Re-insert so this session counts as most recently used.
    pinned.delete(sessionId);
    pinned.set(sessionId, hit);
    return hit;
  }

  const resolving = resolveFresh().catch((err: unknown) => {
    // Drop the pin so the NEXT consumer retries rather than inheriting a permanent failure.
    // Only ever removes this key's own entry, and only if it is still this promise — a later
    // successful read for the same session must not be thrown away by an earlier failure.
    if (pinned.get(sessionId) === resolving) pinned.delete(sessionId);
    throw err;
  });
  pinned.set(sessionId, resolving);

  // Bounded, and eviction reaches only the least recently touched session. THE TRADE, STATED
  // HONESTLY: a live-but-idle conversation evicted by 64 newer ones will re-read on its next
  // approval call and can get a NEWER definition than the persona that session was given —
  // exactly the intra-session disagreement the pin exists to prevent. The exposure is narrow
  // rather than absent: instructions are read once at `session.started` and the model resolver
  // reads once on the session's FIRST `step.started` (eve 0.60 allows a constructed provider at
  // no earlier scope — see packages/agent-kit/src/definition-model.ts), after which it reuses
  // the alias it pinned and never reads again. So the exposure is a window of one step between
  // those two reads, plus the approval fallback, which is the only consumer that reads later in
  // the session. Accepted deliberately over
  // an unbounded map (ORB-278 step 2 review round 2).
  while (pinned.size > MAX_PINNED) {
    const oldest = pinned.keys().next();
    if (oldest.done === true) break;
    pinned.delete(oldest.value);
  }

  return resolving;
}

/** One read of the definition folder. Async throughout: every failure — including a missing
 *  role template — must arrive as a REJECTION, never as a synchronous throw out of whichever
 *  callback happened to call first. `setup()` in particular is called by eve unguarded. */
async function resolveFresh(): Promise<Resolved> {
  const serviceDir = process.cwd();
  return resolveDefinition({
    // RULING R11 (2026-09-16): the agent's identity is an INPUT, never inferred from a file that
    // may be corrupt. The keeper sets LARES_AGENT_NAME beside LARES_DEFINITION_DIR; with no folder
    // mounted this is the service's own committed name, which is what every test and every
    // `eve build` sees. Without it, a folder of unparseable bytes has no identity to attribute a
    // failure to — and the two ways of guessing one (grepping the raw file, or a process-global
    // memo of the last name seen) were both tried and both wrong: the first cannot read garbage,
    // the second let one agent boot on another's persona.
    agentName: process.env["LARES_AGENT_NAME"] ?? (manifest as { name: string }).name,
    serviceDir,
    roleMd: await readFile(roleMdPath(serviceDir), "utf8"),
    deployedTools: deployedToolsFor(serviceDir),
    // An invalid hand edit is an operational failure the owner must see. `emitSignal`'s default
    // payload (app-exception / error) is exactly right for it and needs no new route row —
    // LAR-40 gives the emitter a `kind` later, and a follow-up can reshape this then.
    onInvalid: (agent, reason) => {
      void emitSignal(`definition-invalid:${agent}`, `${agent} is running on its last valid definition`, reason);
    },
  });
}

/** Where the engine-owned role template lives, relative to the app root. Exported so the
 *  session-start resolvers read the same bytes this one validated against. */
export function roleMdPath(serviceDir: string = process.cwd()): string {
  return join(serviceDir, "..", "..", "packages", "agent-kit", "templates", ROLE_TEMPLATE, "role.md");
}
