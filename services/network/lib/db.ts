import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-paths.js";

export const DEFAULT_DB_PATH = join(stateRoot(), "network.db");

export const SCHEMA_VERSION = 5;

const DIGEST_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS digest_runs (
  id        INTEGER PRIMARY KEY,
  iso_week  TEXT NOT NULL UNIQUE,
  posted_at TEXT NOT NULL,
  summary   TEXT NOT NULL
);
`;

const HANDLES_TABLE = `
CREATE TABLE IF NOT EXISTS handles (
  id           INTEGER PRIMARY KEY,
  platform     TEXT NOT NULL,
  handle       TEXT,
  display_name TEXT,
  relation     TEXT NOT NULL,
  contact_id   INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  observed_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handles_unique
  ON handles(platform, relation, COALESCE(handle,''), COALESCE(display_name,''));
`;

/**
 * Per-conversation resume state for the Slack importer. `oldest` is the
 * high-water mark (a Slack `ts`): everything at/before it has been fully
 * imported, so the next run passes it as `conversations.history`'s `oldest`
 * param to avoid rescanning. `resume_cursor` is Slack's own pagination
 * cursor, set only when a run stops mid-backlog (budget exhausted before
 * reaching the top of the [oldest, now) window) so the next run continues
 * the same page walk instead of restarting it. `pending_high_water` carries
 * the newest ts seen across that multi-run walk until it completes, at
 * which point it is promoted to `oldest`.
 */
const SLACK_CURSORS_TABLE = `
CREATE TABLE IF NOT EXISTS slack_cursors (
  conversation_id     TEXT PRIMARY KEY,
  oldest              TEXT,
  resume_cursor       TEXT,
  pending_high_water   TEXT,
  updated_at          TEXT NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id                   INTEGER PRIMARY KEY,
  display_name         TEXT NOT NULL,
  company              TEXT,
  title                TEXT,
  source               TEXT NOT NULL,
  resolved             INTEGER NOT NULL DEFAULT 1,
  notes                TEXT,
  twenty_id_cache      TEXT,
  twenty_strength      TEXT,
  twenty_last_contacted TEXT,
  twenty_synced_at     TEXT
);
CREATE TABLE IF NOT EXISTS identities (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('email','phone','linkedin_url','twenty_id','instagram','meta_name','slack_user')),
  value      TEXT NOT NULL,
  source     TEXT NOT NULL,
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_identities_contact ON identities(contact_id);
CREATE TABLE IF NOT EXISTS interactions (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('linkedin','linkedin_invite','imessage','call','instagram','facebook','slack')),
  direction   TEXT CHECK (direction IN ('inbound','outbound')),
  at          TEXT NOT NULL,
  content     TEXT,
  external_id TEXT NOT NULL,
  answered    INTEGER,
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id, at);
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company     TEXT NOT NULL,
  title       TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (contact_id, company, title)
);
CREATE TABLE IF NOT EXISTS signals (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('job_change','promotion','company_switch','cadence_break','call_unreturned')),
  at         TEXT NOT NULL,
  evidence   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pulse (
  contact_id          INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  score               REAL NOT NULL,
  band                TEXT NOT NULL,
  dormant_warm        INTEGER NOT NULL DEFAULT 0,
  last_interaction_at TEXT,
  components          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_runs (
  id        INTEGER PRIMARY KEY,
  source    TEXT NOT NULL,
  ran_at    TEXT NOT NULL,
  file_hash TEXT,
  summary   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_overrides (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('merge','detach')),
  from_contact INTEGER NOT NULL,
  into_contact INTEGER,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
` + DIGEST_RUNS_TABLE + HANDLES_TABLE + SLACK_CURSORS_TABLE;

function migrateV1toV2(db: Database.Database): void {
  // v1 → v2 rebuild (CHECK constraints can't be altered in place)
  db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      db.exec(`
        ALTER TABLE contacts ADD COLUMN twenty_id_cache TEXT;
        ALTER TABLE contacts ADD COLUMN twenty_strength TEXT;
        ALTER TABLE contacts ADD COLUMN twenty_last_contacted TEXT;
        ALTER TABLE contacts ADD COLUMN twenty_synced_at TEXT;

        CREATE TABLE interactions_v2 (
          id          INTEGER PRIMARY KEY,
          contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          channel     TEXT NOT NULL CHECK (channel IN ('linkedin','linkedin_invite','imessage','call')),
          direction   TEXT CHECK (direction IN ('inbound','outbound')),
          at          TEXT NOT NULL,
          content     TEXT,
          external_id TEXT NOT NULL,
          answered    INTEGER,
          UNIQUE (channel, external_id)
        );
        INSERT INTO interactions_v2 (id, contact_id, channel, direction, at, content, external_id, answered)
          SELECT id, contact_id,
                 CASE WHEN channel='linkedin' AND content IS NULL THEN 'linkedin_invite' ELSE channel END,
                 direction, at, content, external_id,
                 CASE WHEN channel='call' THEN 1 ELSE NULL END
          FROM interactions;
        DROP TABLE interactions;
        ALTER TABLE interactions_v2 RENAME TO interactions;
        CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id, at);

        CREATE TABLE identities_v2 (
          id         INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL CHECK (kind IN ('email','phone','linkedin_url','twenty_id')),
          value      TEXT NOT NULL,
          source     TEXT NOT NULL,
          UNIQUE (kind, value)
        );
        INSERT INTO identities_v2 SELECT id, contact_id, kind, value, source FROM identities;
        DROP TABLE identities;
        ALTER TABLE identities_v2 RENAME TO identities;
        CREATE INDEX IF NOT EXISTS idx_identities_contact ON identities(contact_id);

        CREATE TABLE signals_v2 (
          id         INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL CHECK (kind IN ('job_change','promotion','company_switch','cadence_break','call_unreturned')),
          at         TEXT NOT NULL,
          evidence   TEXT NOT NULL
        );
        INSERT INTO signals_v2 SELECT id, contact_id, kind, at, evidence FROM signals;
        DROP TABLE signals;
        ALTER TABLE signals_v2 RENAME TO signals;
      `);
      // Stamp inside the transaction: pragma writes participate in the tx, so
      // commit + version stamp are atomic — a crash can never leave a v2-shaped
      // db still marked v1 (which would make the next open fail on ADD COLUMN).
      db.pragma("user_version = 2");
    });
    tx();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function migrateV3toV4(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE interactions_v4 (
          id          INTEGER PRIMARY KEY,
          contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          channel     TEXT NOT NULL CHECK (channel IN ('linkedin','linkedin_invite','imessage','call','instagram','facebook')),
          direction   TEXT CHECK (direction IN ('inbound','outbound')),
          at          TEXT NOT NULL,
          content     TEXT,
          external_id TEXT NOT NULL,
          answered    INTEGER,
          UNIQUE (channel, external_id)
        );
        INSERT INTO interactions_v4 SELECT id, contact_id, channel, direction, at, content, external_id, answered FROM interactions;
        DROP TABLE interactions;
        ALTER TABLE interactions_v4 RENAME TO interactions;
        CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id, at);

        CREATE TABLE identities_v4 (
          id         INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL CHECK (kind IN ('email','phone','linkedin_url','twenty_id','instagram','meta_name')),
          value      TEXT NOT NULL,
          source     TEXT NOT NULL,
          UNIQUE (kind, value)
        );
        INSERT INTO identities_v4 SELECT id, contact_id, kind, value, source FROM identities;
        DROP TABLE identities;
        ALTER TABLE identities_v4 RENAME TO identities;
        CREATE INDEX IF NOT EXISTS idx_identities_contact ON identities(contact_id);

        CREATE TABLE IF NOT EXISTS handles (
          id           INTEGER PRIMARY KEY,
          platform     TEXT NOT NULL,
          handle       TEXT,
          display_name TEXT,
          relation     TEXT NOT NULL,
          contact_id   INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
          observed_at  TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_handles_unique
          ON handles(platform, relation, COALESCE(handle,''), COALESCE(display_name,''));
      `);
      db.pragma("user_version = 4");
    });
    tx();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function migrateV4toV5(db: Database.Database): void {
  // v4 → v5 rebuild (CHECK constraints can't be altered in place): widens
  // interactions.channel and identities.kind to admit 'slack'/'slack_user',
  // and adds the slack_cursors table (a plain CREATE TABLE IF NOT EXISTS,
  // no rebuild needed for that one).
  db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE interactions_v5 (
          id          INTEGER PRIMARY KEY,
          contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          channel     TEXT NOT NULL CHECK (channel IN ('linkedin','linkedin_invite','imessage','call','instagram','facebook','slack')),
          direction   TEXT CHECK (direction IN ('inbound','outbound')),
          at          TEXT NOT NULL,
          content     TEXT,
          external_id TEXT NOT NULL,
          answered    INTEGER,
          UNIQUE (channel, external_id)
        );
        INSERT INTO interactions_v5 SELECT id, contact_id, channel, direction, at, content, external_id, answered FROM interactions;
        DROP TABLE interactions;
        ALTER TABLE interactions_v5 RENAME TO interactions;
        CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id, at);

        CREATE TABLE identities_v5 (
          id         INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL CHECK (kind IN ('email','phone','linkedin_url','twenty_id','instagram','meta_name','slack_user')),
          value      TEXT NOT NULL,
          source     TEXT NOT NULL,
          UNIQUE (kind, value)
        );
        INSERT INTO identities_v5 SELECT id, contact_id, kind, value, source FROM identities;
        DROP TABLE identities;
        ALTER TABLE identities_v5 RENAME TO identities;
        CREATE INDEX IF NOT EXISTS idx_identities_contact ON identities(contact_id);
      `);
      db.exec(SLACK_CURSORS_TABLE);
      db.pragma("user_version = 5");
    });
    tx();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function migrate(db: Database.Database): void {
  const v = db.pragma("user_version", { simple: true }) as number;
  if (v >= SCHEMA_VERSION) return;
  const hasTables = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='interactions'")
    .get() as { n: number };
  if (!hasTables.n) {
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (v < 2) migrateV1toV2(db);
  if (v < 3) {
    db.exec(DIGEST_RUNS_TABLE);
    db.pragma("user_version = 3");
  }
  if (v < 4) migrateV3toV4(db);
  if (v < 5) migrateV4toV5(db);
}

export type Db = Database.Database;

export function openDb(path: string = DEFAULT_DB_PATH): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function openDbReadOnly(path: string = DEFAULT_DB_PATH): Db {
  return new Database(path, { readonly: true, fileMustExist: true });
}
