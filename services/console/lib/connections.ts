// services/console/lib/connections.ts
// One row per (connection, instance). Status is split by CUSTODY: what the console holds it can
// read directly; what the box holds it must NOT claim to see, so that half is evidenced by use.
import { pool } from "./db";
import { listAgents, type AgentFolder } from "./agents";
import { listGoogleAccounts, googleOrgs, googleOrgClientConfig } from "./accounts";
import {
  connections, declaredConsumers, parseConnectionRef, connectionsByCapability,
  type ConnectionDef,
} from "@lares/agent-kit/connections";
import type { ConnectionRowDTO, GoogleAccountDTO } from "./contracts";

export interface AuditUse { capability: string; argsSummary: string | null; at: Date }

/** True when an audit row is evidence the capability actually RAN — not a scope denial, a
 *  pending confirm proposal nobody has approved yet, or an execution failure. Mirrors the five
 *  outcomes agent-runtime's runTurn()/resolveConfirmation() write under the same
 *  `<capability>.<action>` action (lib/agent.ts): "DENIED by scope" (:52), "proposed: …" (:61),
 *  "failed: …" (:76) and "failed after confirm: …" (:122) are NOT use; a plain summary,
 *  "autonomous: …" (:88) and "executed after confirm" (:132) are. Without this, an expired
 *  credential throwing on every call writes a fresh audit row per throw and the connection reads
 *  as freshly, healthily used — the exact failure this page exists to catch. */
export function isEvidenceOfUse(argsSummary: string | null): boolean {
  if (argsSummary === null) return true;
  return !argsSummary.startsWith("DENIED") && !argsSummary.startsWith("failed") && !argsSummary.startsWith("proposed:");
}

/** Newest successful use per CONNECTION, from each audit action's `<capability>.<tool>` prefix.
 *  Rolls up every ref regardless of whether it names an instance — safe to read directly only
 *  when a connection has exactly ONE instance (then any evidence can only mean that instance).
 *  A multi-instance connection's per-instance status must NOT read this map; see
 *  `lastUsedByInstance` below. Rows that fail `isEvidenceOfUse` (denied/proposed/failed) are
 *  skipped — they prove the capability was ATTEMPTED, not that it worked. */
export function lastUsedByConnection(
  uses: readonly AuditUse[],
  capConnections: Record<string, string[]>,
): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const use of uses) {
    if (!isEvidenceOfUse(use.argsSummary)) continue;
    const refs = capConnections[use.capability];
    if (!refs) continue;                       // e.g. "workflow.*" — not a registered capability
    for (const ref of refs) {
      const { connectionId } = parseConnectionRef(ref);
      const prev = out.get(connectionId);
      if (!prev || use.at > prev) out.set(connectionId, use.at);
    }
  }
  return out;
}

/** Newest successful use per INSTANCE ("gateway:nora"), from refs that name the instance
 *  EXPLICITLY. A capability whose ref is unqualified ("google") is evidence for the connection
 *  only — it cannot say which client instance served the call — so it contributes nothing here.
 *  This is the only host-custody evidence a multi-instance connection may trust for its
 *  per-instance status; broadcasting connection-level evidence across sibling instances would be
 *  exactly the attribution guess `lastUsed` already refuses to make. Rows that fail
 *  `isEvidenceOfUse` are skipped, same as `lastUsedByConnection` above. */
export function lastUsedByInstance(
  uses: readonly AuditUse[],
  capConnections: Record<string, string[]>,
): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const use of uses) {
    if (!isEvidenceOfUse(use.argsSummary)) continue;
    const refs = capConnections[use.capability];
    if (!refs) continue;
    for (const ref of refs) {
      const { connectionId, instanceId } = parseConnectionRef(ref);
      if (instanceId === undefined) continue;  // unqualified — connection-level only, not this
      const key = `${connectionId}:${instanceId}`;
      const prev = out.get(key);
      if (!prev || use.at > prev) out.set(key, use.at);
    }
  }
  return out;
}

export interface BuildInput {
  agents: AgentFolder[];
  accounts: GoogleAccountDTO[];
  /** Google orgs with a resolvable client pair on this host. */
  configuredOrgs: string[];
  lastUsed: Map<string, Date>;
  /** Per-instance evidence — see `lastUsedByInstance`. The only signal a MULTI-instance,
   *  host-custody connection may use for an individual instance's status. */
  instanceLastUsed: Map<string, Date>;
  /** Capability id → connection refs — see connections.ts's `connectionsByCapability`. */
  connectionsByCapability: Record<string, string[]>;
}

/** For a console-custody connection, the catalogue alone is not the row set: an operator can
 *  register a client (`GOOGLE_CLIENT_ID_<ORG>`) or connect a mailbox for an org the catalogue
 *  never declared. Both must still get a visible, removable row — otherwise a live mailbox is
 *  invisible and stuck (Remove only renders inside a row). Union order: catalogue instances
 *  first (they carry the real label), then configured orgs, then orgs that only exist because a
 *  mailbox is stored for them — each of the latter two falls back to showing its bare id, same
 *  as a catalogue instance with no explicit `label`. */
function consoleInstances(
  def: ConnectionDef,
  configuredOrgs: readonly string[],
  accounts: readonly GoogleAccountDTO[],
): { id: string; label?: string }[] {
  const byId = new Map<string, { id: string; label?: string }>();
  for (const inst of def.instances) byId.set(inst.id, inst);
  for (const org of configuredOrgs) if (!byId.has(org)) byId.set(org, { id: org });
  for (const acct of accounts) if (!byId.has(acct.org)) byId.set(acct.org, { id: acct.org });
  return [...byId.values()];
}

export function buildConnectionRows(input: BuildInput): ConnectionRowDTO[] {
  const rows: ConnectionRowDTO[] = [];

  for (const [connectionId, def] of connections) {
    const instances = def.custody === "console"
      ? consoleInstances(def, input.configuredOrgs, input.accounts)
      : def.instances;
    const single = instances.length === 1;
    const used = input.lastUsed.get(connectionId) ?? null;

    for (const inst of instances) {
      const usedBy = consumersFor(connectionId, inst.id, input.agents, input.connectionsByCapability);
      const accounts = def.custody === "console"
        ? input.accounts.filter((a) => a.org === inst.id)
        : [];

      // With one instance, connection-level evidence is unambiguous — it can only mean this
      // instance. With several, only an instance-qualified ref counts; an unqualified hit on
      // the connection must not be broadcast onto every sibling instance as "live".
      const instanceUsed = single ? used : input.instanceLastUsed.get(`${connectionId}:${inst.id}`) ?? null;

      let status: ConnectionRowDTO["status"];
      let detail: string;
      if (def.custody === "console") {
        const configured = input.configuredOrgs.includes(inst.id);
        if (accounts.length > 0 && configured) {
          status = "live";
          // The HONEST aggregate across mailboxes is the minimum, not the maximum: a 4-scope
          // and a 3-scope mailbox is "3 scopes" of guaranteed coverage, not 4 — Math.max here
          // hid exactly the under-scoped mailbox that silently broke calendar writes before
          // (see GOOGLE_SCOPES's comment in accounts.ts).
          const scopes = Math.min(...accounts.map((a) => a.scopeCount));
          detail = `${accounts.length} mailbox${accounts.length === 1 ? "" : "es"} · ${scopes} scopes`;
        } else if (accounts.length > 0) {
          // A mailbox is enrolled but this host has no client pair for its org — the client
          // may have been rotated out, or never matched this org in the first place. Without
          // it nobody can refresh those tokens, so this is not "live".
          status = "partial";
          detail = `${accounts.length} mailbox${accounts.length === 1 ? "" : "es"}, no client to refresh`;
        } else if (configured) {
          status = "partial";
          detail = "client configured, no mailbox";
        } else {
          status = "missing";
          detail = "no client";
        }
      } else if (instanceUsed) {
        status = "live";
        detail = "in use";
      } else {
        // The console does not mount host secrets; absence of evidence is not absence of the file.
        status = "unknown";
        detail = "no recorded use";
      }

      rows.push({
        connectionId,
        instanceId: inst.id,
        label: single ? def.label : `${def.label} · ${inst.label ?? inst.id}`,
        custody: def.custody,
        status,
        detail,
        lastUsed: single && used ? used.toISOString() : null,
        usedBy,
        accounts,
      });
    }
  }
  return rows;
}

/** Agents from their grants; services, doors and the console from declaredConsumers. */
function consumersFor(
  connectionId: string,
  instanceId: string,
  agents: AgentFolder[],
  capConnections: Record<string, string[]>,
): string[] {
  const out = new Set<string>();

  for (const agent of agents) {
    for (const grant of agent.grants) {
      if (grant.scope === "none") continue;
      const refs = capConnections[grant.capability] ?? [];
      for (const ref of refs) {
        if (matches(ref, connectionId, instanceId)) out.add(agent.name);
      }
    }
  }
  for (const consumer of declaredConsumers) {
    for (const ref of consumer.connections) {
      if (matches(ref, connectionId, instanceId)) out.add(consumer.name);
    }
  }
  return [...out].sort();
}

function matches(ref: string, connectionId: string, instanceId: string): boolean {
  const parsed = parseConnectionRef(ref);
  if (parsed.connectionId !== connectionId) return false;
  return parsed.instanceId === undefined || parsed.instanceId === instanceId;
}

export async function getConnectionRows(): Promise<ConnectionRowDTO[]> {
  const [agents, accounts, uses] = await Promise.all([
    listAgents(),
    listGoogleAccounts(),
    pool
      // Bounded to 90 days: `audit` is an append-only log of every outbound action with no
      // index, so an unbounded scan gets more expensive forever. Deciding which of these rows
      // is genuine EVIDENCE OF USE (as opposed to a denial, a proposal, or a failure) happens
      // in TypeScript — see `isEvidenceOfUse` — not here, because a row's newest audit entry
      // for a capability can be a failure while an earlier row in the window was a real
      // success; only the un-aggregated rows let `lastUsedByConnection`/`lastUsedByInstance`
      // tell those apart and fall through to the real evidence.
      .query<{ capability: string; argsSummary: string | null; at: Date }>(
        `SELECT split_part(action, '.', 1) AS capability, args_summary AS "argsSummary", at
         FROM audit
         WHERE at > now() - interval '90 days'`,
      )
      .then((r) => r.rows)
      .catch(() => [] as AuditUse[]),
  ]);
  return buildConnectionRows({
    agents,
    accounts,
    // "Known org" is not "has a client on this host" — googleOrgClientConfig is the function
    // that actually resolves the secret pair, so it (not the static org list) decides whether
    // "missing" can fire. Without this filter every known org reads as "configured", even one
    // whose client secrets were never mounted.
    configuredOrgs: googleOrgs().map((o) => o.id).filter((id) => googleOrgClientConfig(id) !== null),
    lastUsed: lastUsedByConnection(uses, connectionsByCapability),
    instanceLastUsed: lastUsedByInstance(uses, connectionsByCapability),
    connectionsByCapability,
  });
}
