// services/console/lib/crm-status.ts
// Reads the read-only CRM sync-status endpoint on ops-1 (services/crm-status) and turns raw
// Twenty fields into one honest headline per mailbox.
//
// Everything here except getCrmStatus() is a pure function, so the orderings that make the
// section true are tested without a network or a database.
import { readSecret } from "./secrets";

/** Mirrors ChannelRow in services/crm-status/lib/query.ts — the endpoint's wire shape. */
export interface CrmChannelDTO {
  handle: string;
  isSyncEnabled: boolean;
  syncStatus: string;
  syncStage: string | null;
  syncStageStartedAt: string | null;
  throttleFailureCount: number;
  throttleRetryAfter: string | null;
  syncedAt: string | null;
  authFailedAt: string | null;
}

export interface CrmStatusDTO {
  /** The endpoint's own read time, rendered as "as of …". Empty string when unavailable. */
  at: string;
  channels: CrmChannelDTO[];
  /** Set (never `false`) when the endpoint could not be read. */
  unavailable?: true;
}

export type CrmChannelState =
  | "paused"
  | "token expired"
  | "failing"
  | "throttled"
  | "not yet synced"
  | "syncing";

/**
 * One headline per mailbox, first match wins. The ORDER is the point.
 *
 * `paused` outranks the status word deliberately: crm-sync-guard.sh pauses a looping channel by
 * setting isSyncEnabled = false, while Twenty's MessagingRelaunchFailedMessageChannelJob
 * independently resets syncStatus back to ACTIVE every 30 minutes. So a paused, dead mailbox
 * reads perfectly healthy to anything that trusts the enum. Reading the switch first is what
 * makes this section true rather than merely plausible.
 *
 * Every *applicable* raw fact still prints as a detail line beneath the headline, so the
 * headline never suppresses evidence.
 */
export function deriveState(c: CrmChannelDTO, now: Date): CrmChannelState {
  if (!c.isSyncEnabled) return "paused";
  if (c.authFailedAt !== null) return "token expired";
  if (c.syncStatus.startsWith("FAILED_")) return "failing";
  if (c.throttleRetryAfter !== null && new Date(c.throttleRetryAfter) > now) return "throttled";
  if (c.syncedAt === null) return "not yet synced";
  return "syncing";
}

const HUMAN_NEEDED: ReadonlySet<CrmChannelState> = new Set<CrmChannelState>([
  "paused",
  "token expired",
  "failing",
  "throttled",
]);

/** Whether this row needs a person — and therefore offers a copy-prompt. */
export function needsHuman(state: CrmChannelState): boolean {
  return HUMAN_NEEDED.has(state);
}

const SITUATION: Record<CrmChannelState, string> = {
  paused: "has sync switched off (`isSyncEnabled = false`)",
  "token expired": "has a Google token that failed auth",
  failing: "is failing to sync",
  throttled: "is being throttled",
  "not yet synced": "has never completed a sync",
  syncing: "is syncing",
};

/**
 * A paste-ready prompt for a Claude Code or Codex session.
 *
 * Two constraints, both tested:
 *   - Built ONLY from facts already on the row. No invented state, no guessed cause. A field
 *     absent from the DTO is absent from the prompt.
 *   - It instructs diagnosis, never a blind re-enable. The resume UPDATE is deliberately not in
 *     the prompt and not on the page — pasting it before the cause is fixed is exactly how the
 *     2026-07 Gmail quota doom loop would restart.
 */
export function buildCopyPrompt(c: CrmChannelDTO, state: CrmChannelState): string {
  const facts = [`Twenty reports \`syncStatus = ${c.syncStatus}\``];
  if (c.syncStage) facts.push(`sync stage \`${c.syncStage}\``);
  if (c.throttleFailureCount > 0) facts.push(`${c.throttleFailureCount} throttle failures`);
  if (c.throttleRetryAfter) facts.push(`throttled until ${c.throttleRetryAfter}`);
  facts.push(c.syncedAt ? `last successful sync ${c.syncedAt}` : "no successful sync on record");
  facts.push(
    c.authFailedAt
      ? `the account's token failed auth at ${c.authFailedAt}`
      : "the account's token has not failed auth",
  );
  return [
    `The Twenty CRM mailbox \`${c.handle}\` on ops-1 ${SITUATION[state]}.`,
    `${facts.join(", ")}.`,
    "Diagnose the cause before re-enabling — the guard exists because re-enabling a still-broken channel restarts a Gmail quota doom loop.",
    "Background: `services/crm/crm-sync-guard.sh` and `docs/solutions/2026-07-20-gmail-user-rate-limit-no-backoff.md`.",
    "ops-1 is reachable over Tailscale at 100.91.129.38.",
  ].join(" ");
}

// A fresh literal per call, not a shared module-level const — this object (and its `channels`
// array) gets handed straight to render(). A `const` only freezes the binding, not the value; a
// stray downstream mutation (e.g. `status.channels.push(...)`) would otherwise poison every later
// degraded render for the lifetime of the server process. Mirrors getNotionSyncStatus() in
// ./queries.ts, which does the same for the same reason.
function unavailable(): CrmStatusDTO {
  return { at: "", channels: [], unavailable: true };
}

/**
 * Validates one row at the wire boundary.
 *
 * The service and the console deploy to different hosts by different mechanisms (a Coolify click
 * on ops-1 vs a CI-digest pin on the agent box), so version skew between them is the normal state
 * during any rollout — a field rename on the service side is invisible to the console's `tsc`.
 * Without this, a row missing `isSyncEnabled` makes `deriveState` read `!undefined` as `true` and
 * report a healthy mailbox as "paused" — a confident false claim, the exact inverse of what this
 * feature exists to guarantee. A row missing `syncStatus` throws inside the server component
 * instead of inside `getCrmStatus()`, so "never throws" would not save the page from a 500.
 *
 * Requires only the three fields the renderer hard-depends on; everything else is normalised
 * rather than rejected on.
 */
export function toChannel(u: unknown): CrmChannelDTO | null {
  if (typeof u !== "object" || u === null) return null;
  const r = u as Record<string, unknown>;
  if (
    typeof r["handle"] !== "string" ||
    typeof r["isSyncEnabled"] !== "boolean" ||
    typeof r["syncStatus"] !== "string"
  ) {
    return null;
  }
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    handle: r["handle"],
    isSyncEnabled: r["isSyncEnabled"],
    syncStatus: r["syncStatus"],
    syncStage: str(r["syncStage"]),
    syncStageStartedAt: str(r["syncStageStartedAt"]),
    throttleFailureCount: typeof r["throttleFailureCount"] === "number" ? r["throttleFailureCount"] : 0,
    throttleRetryAfter: str(r["throttleRetryAfter"]),
    syncedAt: str(r["syncedAt"]),
    authFailedAt: str(r["authFailedAt"]),
  };
}

/**
 * Server-side fetch with a short timeout, degrading to `unavailable` on ANY failure — the
 * pattern getNotionSyncStatus() already uses. An ops-1 outage must not take /integrations down,
 * and the section must never render as an empty table, which reads as "no problems".
 */
export async function getCrmStatus(): Promise<CrmStatusDTO> {
  const url = process.env["CRM_STATUS_URL"];
  // readSecret requires an explicit CRM_STATUS_TOKEN_FILE pointing at the mount — it does NOT
  // fall back to /run/secrets/<name> the way agent-runtime's ctx.secret() does.
  const token = readSecret("CRM_STATUS_TOKEN");
  if (!url || !token) return unavailable();
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!res.ok) return unavailable();
    const body = (await res.json()) as unknown;
    if (
      typeof body !== "object" || body === null ||
      !Array.isArray((body as { channels?: unknown }).channels)
    ) {
      return unavailable();
    }
    const { at, channels: rawChannels } = body as { at?: unknown; channels: unknown[] };
    const channels: CrmChannelDTO[] = [];
    for (const raw of rawChannels) {
      const c = toChannel(raw);
      // Any bad row degrades the whole response — dropping just that row and rendering the
      // rest is another way to read as "no problems".
      if (c === null) return unavailable();
      channels.push(c);
    }
    return { at: typeof at === "string" ? at : "", channels };
  } catch {
    return unavailable();
  }
}
