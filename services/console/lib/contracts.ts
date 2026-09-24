// The typed surface the console reads/commands speak. Both the API route handlers
// and the React screens import these — the single shared contract.
export type AutonomyLevel = "autonomous" | "gated" | "never";
export type AgentStatus = "idle" | "running" | "waiting";

export interface CapabilityDTO {
  name: string;
  scope: "none" | "read" | "write" | "write-with-confirm";
  defaultLevel: AutonomyLevel;   // the capability-wide level — the only one the approval check reads
}
export interface AgentSummaryDTO {
  name: string;
  role: string;                  // the role chip, e.g. "Sales"
  status: AgentStatus;
  pendingApprovals: number;
  capabilities: string[];
}
export interface AgentDetailDTO {
  name: string;
  role: string;
  status: AgentStatus;
  capabilities: CapabilityDTO[];
}
export interface AuditRowDTO { at: string; agent: string; action: string; summary: string | null; }

export interface BoardRowDTO {
  agent: string;
  displayName: string;
  capability: string;
  /** The ratchet key's third column. "" for every capability whose level is capability-wide; for
   *  `vault` it is the AREA (W5C-s8 — the area is the action), so one grant is three rows. */
  action: string;
  /** What to call that action on screen ("Shared notes"), or null when there is none to name. */
  actionLabel: string | null;
  scope: string;
  level: AutonomyLevel;
  source: { kind: "board"; by: string; at: string } | { kind: "definition" };
  controllable: boolean;
  lockedTools: Array<{ tool: string; reason: string }>;
  evidence: { asked: number; autonomous: number; denied: number; locked: number; failedClosed: number; lastAt: string | null };
  /** What the OWNER answered, not what the policy decided (see `evidence` above) — from
   *  `approval_asks` (box 086) via `@lares/agent-kit/approval-stats`. `rate` is null when nobody
   *  has answered a card yet, never a percentage of nothing. */
  answers: { approved: number; cancelled: number; neverAnswered: number; rate: number | null };
  /** True when at least one of this row's tools has a clean, long-enough history and could be
   *  suggested for "act on its own" (`couldActOnItsOwn`, owner decision B4). A SUGGESTION ONLY:
   *  nothing reads this to change a level — the owner moves the dial by hand. */
  couldGraduate: boolean;
}

export interface GoogleAccountDTO {
  principal: string;
  email: string;
  org: string;
  scopeCount: number;
  connectedAt: string; // YYYY-MM-DD
}

export interface GoogleOrg {
  id: string;
  label: string;
}

export interface ConnectionRowDTO {
  connectionId: string;
  instanceId: string;
  /** "google · zero7" — what the row is called on screen. */
  label: string;
  custody: "console" | "host" | "foreign";
  status: "live" | "partial" | "missing" | "unknown";
  detail: string;
  /** ISO timestamp, or null when unknown or unattributable. */
  lastUsed: string | null;
  usedBy: string[];
  /** Enrolled mailboxes — console-custody rows only; empty for every other row. */
  accounts: GoogleAccountDTO[];
}

export interface VoiceProposed { core: string; english: string; norsk: string; learnedAt: string; sampleSize: number }
export interface VoiceCardDTO {
  /** `default` (the shared fallback card + learn settings) or a mailbox address (ORB-176, sql/033). */
  id: string;
  core: string; english: string; norsk: string;
  modelEn: string; modelNo: string;
  learnKey: string; lookbackDays: number; cap: number;
  learnStatus: string; learnMessage: string;
  proposed: VoiceProposed | null;
}
export interface VoiceExampleDTO { id: string; lang: "en" | "no"; snippet: string; included: boolean }

/**
 * The exact command that resolves a frozen notion-sync row, ON THE BOX.
 *
 * The console shows it verbatim rather than the friendlier `notion-sync resolve
 * <path> --keep md|notion`, because that commander CLI does not exist where the
 * sync runs: the box has no lares checkout and the shared image ships
 * services/notion-sync alone, so the entrypoint's `--resolve` flag is the only
 * runnable form (final review, I1). `<path>` is the one part a human substitutes.
 *
 * Quiesce first, like every other one-shot: `exec` starts a SECOND process in the
 * container and the daemon's don't-re-enter guard is process-local, so a tick
 * firing into a resolve would be two engines on the same row. See
 * docs/runbooks/notion-sync.md §"Go live".
 */
export const NOTION_RESOLVE_COMMAND =
  "docker compose -f /opt/agent-box/compose.yaml exec -T notion-sync " +
  "/app/node_modules/.bin/tsx services/notion-sync/bin/notion-sync.ts " +
  "--resolve <path> --keep md|notion";
