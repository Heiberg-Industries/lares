import {assertManagedRuntimeCurrent, managedIdentity} from './door-authority.js';
// The permissions board's approval check (agent-definitions spec, Part 3; ORB-278 step 1). Every gated
// tool's `approval` is this policy. It decides per call:
//   1. the board's level for (agent, capability) from the `ratchet` table, else the agent's own level;
//   2. never → denied (with a reason the model relays) — for EVERY tool, always-ask ones included
//      (final review F3: 🚫 only tightens; no setting loosens always-ask);
//   3. always-ask by engine policy (money, delete, first contact, publish, changing its own autonomy) → ask;
//   4. autonomous → run, gated → ask.
// The read is cached for 30 s per (agent, capability) and times out after 5 s. An unreadable table, an
// unknown tool or a missing agent name → ask. An outage costs a click, never an unapproved write.
// eve evaluates this module at `eve build` with no database: nothing here touches the pool until a call.
import type { ApprovalStatus } from "eve/tools/approval";
import { areaOfTool, capabilityOfTool, FIRST_CONTACT_REASON, mustAlwaysAsk, mustAlwaysAskExceptContact, RECIPIENTS_OF } from "./always-ask.js";
import { getPool } from "./db.js";
import { type AutonomyLevel, autonomyOf, parseManifest } from "./manifest.js";
import { type ApprovalDecision, KitRatchet, recordApprovalEvent } from "./ratchet.js";

export const APPROVAL_CACHE_MS = 30_000;

/** true = this recipient has been in touch with the owner before; throwing = could not tell
 *  (the caller asks rather than treating a failed lookup as "unknown"/"known" either way). */
export type ContactHistory = (recipient: string, toolInput: unknown) => Promise<boolean>;

/** Fix-round-1 review, I7: a hung history lookup must cost a click, never the whole turn. Each
 *  recipient's check gets this long before it counts as "could not be read" (the same fail-
 *  closed treatment as a throw) — whatever is actually slow (a Gmail search, an unreachable
 *  network replica) never blocks approval indefinitely. */
export const CONTACT_HISTORY_TIMEOUT_MS = 10_000;

/** Final review F8: the permissions-table read gets the same treatment — past this, it counts as
 *  unreadable and the call asks. */
export const BOARD_READ_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface BoardDeps {
  explicitLevel(agent: string, capability: string, action?: string): Promise<AutonomyLevel | null>;
  /** `callId` is eve's id for the call: eve consults the policy again when an answered card
   *  resumes, with the same id, so the evidence keeps one row per id (final review F6). */
  record(e: { agent: string; capability: string; tool: string; decision: ApprovalDecision; reason: string; callId?: string }): Promise<void>;
  now(): number;
}

const productionDeps: BoardDeps = {
  explicitLevel: (agent, capability, action) => new KitRatchet(getPool()).explicitLevel(agent, capability, action),
  record: async (e) => {
    try {
      await recordApprovalEvent(getPool(), e);
    } catch (err) {
      console.error(`[board] approval evidence not recorded: ${(err as Error).message}`);
    }
  },
  now: () => Date.now(),
};
let depsOverride: BoardDeps | null = null;
export const setBoardDeps = (deps: BoardDeps | null) => { depsOverride = deps; };

const cache = new Map<string, { level: AutonomyLevel | null; at: number }>();
export const clearBoardCache = () => cache.clear();

export async function decideApproval(
  input: {
    agent: string; tool: string; capability: string; startingLevel: AutonomyLevel;
    /** eve's parsed call input — only read by a tool listed in RECIPIENTS_OF. */
    toolInput?: unknown;
    /** Only consulted for a tool listed in RECIPIENTS_OF, and only once the board says autonomous. */
    contactHistory?: ContactHistory;
    action?: string;
  },
  deps: BoardDeps,
): Promise<{ status: ApprovalStatus; decision: ApprovalDecision; reason: string }> {
  const recipientsOf = RECIPIENTS_OF[input.tool];
  // A history-checked contact tool skips only the CONTACT static lock — its "ask first" is
  // decided per call, below, once the level is known. Any OTHER always-ask category
  // (money/delete/publish) still locks, same as every other tool (fix-round-1
  // review, I8 — the original code skipped mustAlwaysAsk wholesale for a RECIPIENTS_OF tool,
  // which would have silently bypassed a future money/delete/publish tool that also happened
  // to be history-checked).
  const forced = recipientsOf !== undefined
    ? mustAlwaysAskExceptContact(input.tool)
    : mustAlwaysAsk(input.tool);

  // Final review F3 (controller ruling): a locked tool still reads the level, but only so that 🚫
  // can refuse it. Nothing below can loosen the lock: an unreadable table asks with the lock's
  // own reason (as before), and any other level asks.
  const key = `${input.agent}/${input.capability}/${input.action ?? ""}`;
  let explicit: AutonomyLevel | null;
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < APPROVAL_CACHE_MS) explicit = hit.level;
  else {
    try {
      explicit = await withTimeout(deps.explicitLevel(input.agent, input.capability, input.action), BOARD_READ_TIMEOUT_MS, "permissions table read");
      cache.set(key, { level: explicit, at: deps.now() });
    } catch {
      if (forced.ask) return { status: "user-approval", decision: "locked", reason: forced.reason };
      return { status: "user-approval", decision: "failed-closed", reason: "the permissions table could not be read — asking first" };
    }
  }
  const level = explicit ?? input.startingLevel;
  if (level === "never") {
    const reason = `${input.capability} is switched off for ${input.agent} on the permissions board`;
    return { status: { type: "denied", reason }, decision: "denied", reason };
  }
  if (forced.ask) return { status: "user-approval", decision: "locked", reason: forced.reason };

  if (recipientsOf) {
    // gated (or an unrecognised level) → ask, same as any other tool — no need to read who
    // this goes to, and no history lookup, until the board actually says autonomous.
    if (level !== "autonomous") return { status: "user-approval", decision: "asked", reason: "set to ask first" };

    const recipients = recipientsOf(input.toolInput);
    if (recipients === null) {
      return { status: "user-approval", decision: "locked", reason: "could not read who this goes to — asking first" };
    }
    if (recipients.length === 0) {
      return { status: "not-applicable", decision: "autonomous", reason: "contacts nobody" };
    }
    if (!input.contactHistory) {
      return { status: "user-approval", decision: "locked", reason: FIRST_CONTACT_REASON };
    }
    let everyoneKnown = true;
    try {
      // `recipients` is already deduplicated (always-ask.ts's `extractAddresses`) — no address
      // is ever checked twice for one call. Each check gets its own timeout so one hung
      // recipient cannot silently stall the rest, or the whole approval, indefinitely.
      for (const recipient of recipients) {
        if (!(await withTimeout(input.contactHistory(recipient, input.toolInput), CONTACT_HISTORY_TIMEOUT_MS, "contact history check"))) {
          everyoneKnown = false;
          break;
        }
      }
    } catch {
      return { status: "user-approval", decision: "locked", reason: "contact history could not be read — asking first" };
    }
    if (everyoneKnown) {
      return { status: "not-applicable", decision: "autonomous", reason: "every recipient has been in touch before" };
    }
    return { status: "user-approval", decision: "locked", reason: FIRST_CONTACT_REASON };
  }

  if (level === "autonomous") return { status: "not-applicable", decision: "autonomous", reason: "set to act on its own" };
  return { status: "user-approval", decision: "asked", reason: "set to ask first" };
}

/** The slice of eve's `ApprovalContext` this policy reads. `session.id` is what lets the
 *  definition fallback resolve from the SAME read the session's persona and model came from —
 *  eve's `ApprovalContext extends SessionContext`, so it is always there in production; it is
 *  optional here because this policy is also called directly from tests. */
export interface ApprovalCallContext {
  toolInput?: unknown;
  callId?: string;
  session?: { id?: string };
}

/** The value a tool puts in `approval`. Bound at module load to the agent's manifest and the
 *  tool's name; `opts.contactHistory` (Saga's `lib/contact-history.ts`'s `isKnownRecipient`)
 *  is only consulted for a tool listed in RECIPIENTS_OF. The returned function takes eve's own
 *  approval context, reading `ctx.toolInput` — see `ApprovalContext` in
 *  node_modules/eve/dist/src/public/definitions/approval.d.ts, and `meeting_followup_send.ts`'s
 *  `followupApproval` for the same shape already in use. */
export function boardApproval(
  manifest: unknown,
  tool: string,
  opts?: {
    contactHistory?: ContactHistory;
    action?: string;
    defaultLevel?: AutonomyLevel;
    /** ORB-278 step 2: the DEFINITION's level for this capability, read per call. Without it the
     *  fallback is whatever the image was built with, which is exactly the frozen autonomy this
     *  whole step exists to end. Saga has 16 `ratchet` rows and those still win where they
     *  exist; Marcel and Calliope have none, so for two of the three agents this fallback is the
     *  only thing deciding.
     *
     *  Resolved lazily, and PER SESSION — not per process. `sessionId` is passed through so this
     *  call shares the conversation's own single read of the definition, which is both why it is
     *  a map lookup after the first call of that session and why the persona the model was given
     *  can never disagree with the level applied to its writes. A definition edited on the box
     *  therefore reaches the next conversation, not the next container.
     *
     *  It must NEVER be read at module load: eve evaluates this module during `eve build`, with
     *  no definition mounted and no database.
     *
     *  `defaultLevel` still outranks it. That option is an explicit per-action override (Saga's
     *  draft-only writes), not an image default, so a definition must not quietly undo it. */
    startingLevel?: (capability: string, sessionId?: string) => Promise<AutonomyLevel>;
  },
): (ctx?: ApprovalCallContext) => Promise<ApprovalStatus> {
  const m = parseManifest(manifest);
  const capability = capabilityOfTool(tool);
  // ── THE AREA IS THE ACTION (W5C controller ruling, 2026-09-19) ──────────────────────────────
  // One `vault` capability replaced `brain`, `atlas` and `memory`, and the capability WAS the
  // ratchet key: `atlas_resolve_proposal` read `(agent, "atlas", "")` and `forget` read
  // `(agent, "memory", "")`. Left alone, the merge would have put both on ONE row — switching the
  // shared-store proposal lane to ✓ would have switched `forget` to ✓ with it. So a vault tool's
  // key is `(agent, "vault", <its area>)`: "private", "shared" or "facts", which is 1:1 with the
  // three old capability rows, so nothing merges and nothing widens.
  //
  // DERIVED HERE, ONCE, and never at a call site: a vault tool added tomorrow cannot forget to
  // pass an action. An EXPLICIT `action` from the caller still wins — that option is a deliberate
  // per-action override (the draft-only mail writes are one), and this derivation must not quietly
  // undo it.
  const action = opts?.action ?? (capability === "vault" ? areaOfTool(tool) : undefined);
  // A vault tool the area table does not know has no key of its own. Falling back to the bare
  // capability row would put it back on the merged `action = ''` row this ruling exists to empty,
  // so it fails closed exactly as an unknown capability does below — it asks, every time.
  const vaultWithoutArea = capability === "vault" && action === undefined;
  return async (ctx?: ApprovalCallContext) => {
    // Neutral images carry a role name in their compiled manifest. The verified runtime
    // identity selects the installation's board rows, cache namespace and audit owner.
    let agent = m.name;
    try {
      agent = managedIdentity()?.name ?? m.name;
      await withTimeout(assertManagedRuntimeCurrent(), BOARD_READ_TIMEOUT_MS, 'managed connection authority');
    }
    catch { return {type:'denied',reason:'The owner connection changed or is unavailable. Apply current connection changes before approving actions.'}; }
    const deps = depsOverride ?? productionDeps;
    const callId = ctx?.callId;
    if (!capability || !agent || vaultWithoutArea) {
      // Evidence never fails an action. `approval_events` (038_permissions_board.sql) carries no
      // `action` column, so the area is not a field of its own here — the `tool` column names it,
      // and `areaOfTool` reads the area back off that wherever the evidence is counted per area.
      const reason = vaultWithoutArea ? "vault tool with no area — asking first" : "unknown tool";
      void deps.record({ agent: agent ?? "unknown", capability: capability ?? "unknown", tool, decision: "failed-closed", reason, callId }).catch(() => {});
      return "user-approval";
    }
    // The `.catch(() => "gated")` is the fail-closed half: an unreadable definition mid-call must
    // ask, never act. Same treatment an unreadable `ratchet` table already gets.
    const startingLevel = opts?.defaultLevel
      ?? (opts?.startingLevel
        ? await opts.startingLevel(capability, ctx?.session?.id).catch(() => "gated" as AutonomyLevel)
        : autonomyOf(m, capability));
    const d = await decideApproval(
      {
        agent, tool, capability, startingLevel,
        action,
        toolInput: ctx?.toolInput, contactHistory: opts?.contactHistory,
      },
      deps,
    );
    // Evidence never fails an action.
    void deps.record({ agent, capability, tool, decision: d.decision, reason: d.reason, callId }).catch(() => {});
    return d.status;
  };
}
