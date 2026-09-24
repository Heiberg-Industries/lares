/**
 * Read-only client for the network sqlite replica (`@lares/network`), consumed by the
 * `network_who_at` / `network_dormant` / `network_person` tools.
 *
 * Ported from `services/agent-runtime/lib/adapters/network-query.ts`'s `makeNetworkQuery`
 * and backed by `services/network/lib/queries.ts`'s `whoAt`/`dormantQueue`/`personProfile`
 * (same package the agent box uses — see its `lib/network-source.ts`). A fresh read-only
 * handle is opened PER CALL and closed in a `finally`, matching the old adapter's own
 * comment: the replica is swapped with an atomic daily-replace, so holding a long-lived
 * handle risks reading mid-swap.
 *
 * ORB-51: a missing/unreadable db file (unmounted `/srv/network`, wrong path, replica
 * never synced) — or a db that opens fine but holds zero contacts (schema present, sync
 * never actually ran) — both throw `NetworkUnavailableError`. Neither may look like a
 * real zero-hit query, which is a legitimate answer (`network_who_at` on a company nobody
 * knows, `network_person` on a name that isn't there) and returns its normal empty shape.
 */
import { createRequire } from "node:module";
import type { Db } from "@lares/network/lib/db.js";

// Loaded via createRequire, not a static import: vite 5.4 (vitest's loader) predates
// `node:sqlite` in its builtin list and tries to bundle it as a bare "sqlite" package —
// and the test files reach this module through more than one loader context, so a config
// exclusion has to be repeated per context while createRequire is invisible to all of them.
// Node itself (24, the runtime) resolves it natively either way.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import {
  whoAt,
  dormantQueue,
  personProfile,
  type WhoAtRow,
  type DormantRow,
  type PersonProfile,
} from "@lares/network/lib/queries.js";

export class NetworkUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkUnavailableError";
  }
}

const DEFAULT_DB_PATH = "/srv/network/network.db";

/** Read from env per call, never at module scope — matches the orakel/readability clients. */
function dbPath(): string {
  return process.env["NETWORK_DB_PATH"] ?? DEFAULT_DB_PATH;
}

// node:sqlite, NOT better-sqlite3, and the difference is load-bearing (2026-08-14 incident):
// better-sqlite3's C++ Database destructor unregisters an env-cleanup hook at GC time even
// on a CLOSED handle, and eve runs turns in worker environments that terminate before GC
// runs — the unregister then hits a dead env and ABORTS THE WHOLE PROCESS
// (`Assertion failed: (env) != nullptr` in Database::~Database), wedging the in-flight turn
// behind a dead worker's lock for ~14 minutes. Deterministic close does not prevent it; the
// destructor still runs. node:sqlite is a core module with core-managed teardown, and the
// query functions above only use prepare/get/all, which both drivers share. Do not "simplify"
// this back to @lares/network's openDbReadOnly inside this service.
function openHealthy(): Db {
  const path = dbPath();
  let db: Db;
  try {
    db = new DatabaseSync(path, { readOnly: true }) as unknown as Db;
  } catch (err) {
    throw new NetworkUnavailableError(`network db not readable: ${path}`, err);
  }
  let n: number;
  try {
    n = (db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
  } catch (err) {
    db.close();
    throw new NetworkUnavailableError(`network db at ${path} is missing the contacts table (not migrated / wrong file)`, err);
  }
  if (n === 0) {
    db.close();
    throw new NetworkUnavailableError(`network db at ${path} has zero contacts — replica not synced`);
  }
  return db;
}

function withDb<T>(fn: (db: Db) => T): T {
  const db = openHealthy();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function networkWhoAt(company: string): WhoAtRow[] {
  return withDb((db) => whoAt(db, company));
}

export function networkDormant(limit?: number): DormantRow[] {
  return withDb((db) => dormantQueue(db, limit));
}

export function networkPerson(name: string): PersonProfile | null {
  return withDb((db) => personProfile(db, name));
}

/**
 * ORB-278 step 1, Task 3b — the network leg of `lib/contact-history.ts`'s `isKnownRecipient`:
 * has the OWNER reached OUT to this email address before?
 *
 * OUTBOUND ONLY, by owner ruling D-B (fix round 1, task-3b-fix1-findings.md): "been in touch"
 * means the owner WROTE TO them — an inbound-only row (they messaged him, he never replied or
 * wrote first) must not count, or a stranger — or a prompt-injection message crafted to look
 * like an approach — could manufacture "known" status just by sending one message in. The
 * first version of this function was direction-unfiltered ("any interaction, either
 * direction"); this is the fix-round-1 correction, matching `networkOutboundAfter`'s own
 * `direction = 'outbound'` filter (a different query, same underlying rule).
 *
 * Email identities match case-insensitively (`LOWER(id.value)` against a lower-cased input),
 * matching `networkOutboundAfter`'s own reasoning: Gmail/Calendar addresses and the replica's
 * import case are not guaranteed to agree.
 */
export function networkHasOutboundInteraction(email: string): boolean {
  return withDb((db) => {
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM interactions i
           JOIN identities id ON id.contact_id = i.contact_id
          WHERE id.kind = 'email' AND LOWER(id.value) = ? AND i.direction = 'outbound'
          LIMIT 1`,
      )
      .get(email.toLowerCase()) as { hit: number } | undefined;
    return row !== undefined;
  });
}

/**
 * ORB-45 Task 10, B2 — the network-side leg of `resolveElsewhere` (lib/obligation-resolution.ts):
 * did an outbound iMessage or an ANSWERED outbound call reach this counterparty after their last
 * message? Metadata only — `content` is NULL on every row this replica carries (stripped before
 * the box ever sees it; see services/network/lib/replica.ts), and this query never selects it.
 *
 * Email identities match case-insensitively on both sides (`LOWER(id.value)` against a
 * lower-cased input) — Gmail/Calendar addresses arrive in whatever case the source used, and the
 * replica's own import case isn't guaranteed either. `slack_user` identities are compared as-is:
 * Slack user ids are opaque tokens (case IS the identity), not a display string to normalize.
 */
export function networkOutboundAfter(
  ids: { emails: string[]; slackUserId?: string },
  since: Date,
): { channel: "imessage" | "call"; at: Date } | null {
  return withDb((db) => {
    const emails = ids.emails.map((e) => e.toLowerCase());
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (emails.length > 0) {
      conditions.push(`(id.kind = 'email' AND LOWER(id.value) IN (${emails.map(() => "?").join(",")}))`);
      params.push(...emails);
    }
    if (ids.slackUserId) {
      conditions.push(`(id.kind = 'slack_user' AND id.value = ?)`);
      params.push(ids.slackUserId);
    }
    if (conditions.length === 0) return null;
    const row = db
      .prepare(
        `SELECT i.channel AS channel, MAX(i.at) AS at FROM interactions i
           JOIN identities id ON id.contact_id = i.contact_id
          WHERE (${conditions.join(" OR ")}) AND i.at > ?
            AND ((i.channel = 'imessage' AND i.direction = 'outbound') OR (i.channel = 'call' AND i.direction = 'outbound' AND i.answered = 1))
          GROUP BY i.channel ORDER BY at DESC LIMIT 1`,
      )
      .get(...params, since.toISOString()) as { channel: "imessage" | "call"; at: string } | undefined;
    return row ? { channel: row.channel, at: new Date(row.at) } : null;
  });
}
