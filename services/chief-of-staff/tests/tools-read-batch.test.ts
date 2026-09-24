import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ToolContext } from "eve/tools";

import { openDb } from "@lares/network/lib/db.js";
import { NetworkUnavailableError } from "../lib/network-client.js";
import { getPool, closePool } from "@lares/agent-kit/db";
import { IdentityUnavailableError } from "../lib/identity-client.js";
import { StoreUnhealthyError } from "@lares/agent-kit/notes-store";
import { ReadabilityNoContentError } from "@lares/agent-kit/readability-client";

import networkWhoAt from "../catalogue/network_who_at.js";
import networkDormant from "../catalogue/network_dormant.js";
import networkPerson from "../catalogue/network_person.js";
import identityMyAddresses from "../catalogue/identity_my_addresses.js";
import { listTool } from "@lares/agent-kit/note-tools";
import readUrl from "../catalogue/read_url.js";
import digestRun from "../catalogue/digest_run.js";

/**
 * The read-tools batch (Task 4): network, identity, vault/atlas listing, read_url,
 * digest_run. Every tool that touches an external store proves both a real answer AND the
 * ORB-51 posture — a sick backend is a typed error the model sees, never an empty result
 * that looks like a legitimate zero-hit query.
 *
 * orakel_search/orakel_enrich_org/orakel_enrich_domain moved out of this file under
 * ORB-143: they're mounted from the @lares/agent-kit eve extension now
 * (agent-kit__orakel_*), and an extension tool's config binds only through eve's own
 * compiled-agent loader (it sets a mount-scoped `EXT_CONFIG_SCOPE` global while loading
 * each authored module — see eve's dist/src/internal/authored-module-map-loader.js), not
 * through a plain import the way this file's other tools are unit-tested. Coverage for the
 * client logic itself lives on unchanged in tests/orakel-client.test.ts (still exercising
 * the original, still-live services/chief-of-staff/lib/orakel-client.ts — kept because
 * commercial_who_to_contact.ts and lib/person-sources.ts call it directly, not through a
 * tool); tool resolution under the new prefixed name is verified against a running eve
 * instance instead (see task-1-report.md).
 *
 * vault_list moved into the same extension under ORB-143 Task 2, but — unlike orakel — the
 * list tool's execute() touches zero extension config (it reads VAULT_PATH/ATLAS_PATH from
 * process.env via storeRootForArea(), exactly as before), so reconstructing it directly from
 * @lares/agent-kit/note-tools below tests the real, unmodified logic without needing eve's
 * loader. See tools-readonly.test.ts's header for the same reasoning applied to
 * vault_search/vault_read/vault_backlinks.
 */

// These tools never read ctx — matches the posture already established in
// tests/tools-readonly.test.ts for the note-store hands.
const ctx = {} as ToolContext;

// ── network_who_at / network_dormant / network_person ────────────────────────────────

let netDir: string;

function buildNetworkDb(path: string): void {
  const db = openDb(path);
  const peter = db
    .prepare(`INSERT INTO contacts (display_name, company, title, source) VALUES (?, ?, ?, 'test')`)
    .run("Peter Karlsson", "Curamando", "Consultant").lastInsertRowid as number;
  const cold = db
    .prepare(`INSERT INTO contacts (display_name, company, source) VALUES (?, ?, 'test')`)
    .run("Cold Contact", "OtherCo").lastInsertRowid as number;
  db.prepare(
    `INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components) VALUES (?, ?, ?, ?, ?, '{}')`,
  ).run(peter, 80, "WARM", 0, "2026-06-01T00:00:00Z");
  db.prepare(
    `INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components) VALUES (?, ?, ?, ?, ?, '{}')`,
  ).run(cold, 10, "COLD", 1, "2025-01-01T00:00:00Z");
  db.prepare(`INSERT INTO identities (contact_id, kind, value, source) VALUES (?, 'email', ?, 'test')`).run(
    peter,
    "peter@curamando.example",
  );
  db.prepare(
    `INSERT INTO interactions (contact_id, channel, direction, at, external_id) VALUES (?, 'imessage', 'inbound', ?, 'q-1')`,
  ).run(peter, "2026-06-01T00:00:00Z");
  db.close();
}

afterEach(() => {
  if (netDir) rmSync(netDir, { recursive: true, force: true });
  delete process.env["NETWORK_DB_PATH"];
});

describe("network_who_at / network_dormant / network_person", () => {
  it("who_at returns hits ranked by warmth, matching loosely on company", async () => {
    netDir = mkdtempSync(join(tmpdir(), "eve-network-"));
    const dbPath = join(netDir, "network.db");
    buildNetworkDb(dbPath);
    process.env["NETWORK_DB_PATH"] = dbPath;

    const rows = (await networkWhoAt.execute({ company: "curamando" }, ctx)) as { displayName: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe("Peter Karlsson");
  });

  it("who_at returns an empty array for a real zero-match query, not an error", async () => {
    netDir = mkdtempSync(join(tmpdir(), "eve-network-"));
    const dbPath = join(netDir, "network.db");
    buildNetworkDb(dbPath);
    process.env["NETWORK_DB_PATH"] = dbPath;

    expect(await networkWhoAt.execute({ company: "nobody-works-here" }, ctx)).toEqual([]);
  });

  it("dormant returns only the dormant-warm contacts", async () => {
    netDir = mkdtempSync(join(tmpdir(), "eve-network-"));
    const dbPath = join(netDir, "network.db");
    buildNetworkDb(dbPath);
    process.env["NETWORK_DB_PATH"] = dbPath;

    const rows = (await networkDormant.execute({}, ctx)) as { displayName: string; dormantWarm: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe("Cold Contact");
    expect(rows[0]!.dormantWarm).toBe(true);
  });

  it("person returns a fuzzy-matched profile with identities and interactions", async () => {
    netDir = mkdtempSync(join(tmpdir(), "eve-network-"));
    const dbPath = join(netDir, "network.db");
    buildNetworkDb(dbPath);
    process.env["NETWORK_DB_PATH"] = dbPath;

    const profile = (await networkPerson.execute({ name: "peter karlsson" }, ctx)) as {
      contact: { displayName: string };
      identities: { kind: string; value: string }[];
    } | null;
    expect(profile?.contact.displayName).toBe("Peter Karlsson");
    expect(profile?.identities).toEqual([{ kind: "email", value: "peter@curamando.example" }]);
  });

  it("person returns null for a real no-match, not an error", async () => {
    netDir = mkdtempSync(join(tmpdir(), "eve-network-"));
    const dbPath = join(netDir, "network.db");
    buildNetworkDb(dbPath);
    process.env["NETWORK_DB_PATH"] = dbPath;

    expect(await networkPerson.execute({ name: "nobody at all" }, ctx)).toBeNull();
  });

  it("throws NetworkUnavailableError when the db file does not exist", async () => {
    netDir = mkdtempSync(join(tmpdir(), "eve-network-"));
    process.env["NETWORK_DB_PATH"] = join(netDir, "not-there.db");

    await expect(networkWhoAt.execute({ company: "anything" }, ctx)).rejects.toThrow(NetworkUnavailableError);
  });

  it("throws NetworkUnavailableError when the db exists but has zero contacts (unsynced replica)", async () => {
    netDir = mkdtempSync(join(tmpdir(), "eve-network-"));
    const dbPath = join(netDir, "empty.db");
    openDb(dbPath).close(); // schema only, no rows — the "replica never synced" case
    process.env["NETWORK_DB_PATH"] = dbPath;

    await expect(networkDormant.execute({}, ctx)).rejects.toThrow(NetworkUnavailableError);
    await expect(networkPerson.execute({ name: "anyone" }, ctx)).rejects.toThrow(NetworkUnavailableError);
  });
});

// ── identity_my_addresses / digest_run — real Postgres (ORB-45: no mocked Pool) ──────

describe("identity_my_addresses and digest_run", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
    const pool = getPool();
    await pool.query(`
      CREATE TABLE users (
        id text PRIMARY KEY,
        display_name text NOT NULL,
        primary_email text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE user_aliases (
        system text NOT NULL,
        alias text NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (system, alias)
      );
      CREATE TABLE digest_requests (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent        text        NOT NULL,
        requested_by text        NOT NULL,
        door         text        NOT NULL,
        thread_ref   text        NOT NULL,
        status       text        NOT NULL DEFAULT 'pending',
        created_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT digest_requests_status_ck CHECK (status IN ('pending','claimed'))
      );
      INSERT INTO users (id, display_name, primary_email) VALUES ('bendik', 'Bendik Heiberg', 'owner@owner.example');
      INSERT INTO user_aliases (system, alias, user_id) VALUES
        ('email', 'owner@project.example', 'bendik'),
        ('email', 'owner@owner.example', 'bendik'),
        ('slack', 'U_EXAMPLE_OWNER', 'bendik');
    `);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
    delete process.env["DATABASE_URL"];
  });

  it("identity_my_addresses returns the owner's email aliases", async () => {
    // Both seed rows land in the same INSERT (identical created_at), so the query's
    // secondary ORDER BY alias applies — sorted rather than insertion-order asserted.
    const result = (await identityMyAddresses.execute({}, ctx)) as { addresses: string[] };
    expect(result).toEqual({ addresses: ["owner@owner.example", "owner@project.example"] });
  });

  it("identity_my_addresses returns an empty list for a real 'nothing on file' answer", async () => {
    await getPool().query(`DELETE FROM user_aliases WHERE system = 'email'`);
    try {
      expect(await identityMyAddresses.execute({}, ctx)).toEqual({ addresses: [] });
    } finally {
      await getPool().query(
        `INSERT INTO user_aliases (system, alias, user_id) VALUES ('email', 'owner@project.example', 'bendik'), ('email', 'owner@owner.example', 'bendik')`,
      );
    }
  });

  it("identity_my_addresses throws IdentityUnavailableError when the registry is unreachable", async () => {
    await closePool();
    const badEnv = { DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/nope" } as NodeJS.ProcessEnv;
    getPool(badEnv); // seed the singleton with a connection that will fail to connect

    await expect(identityMyAddresses.execute({}, ctx)).rejects.toThrow(IdentityUnavailableError);

    await closePool();
    getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv); // restore for later tests
  });

  it("digest_run inserts exactly one queue row the untouched saga-digest schema expects", async () => {
    process.env["SLACK_ALLOWED_USER_IDS"] = "U_EXAMPLE_OWNER";
    try {
      const result = (await digestRun.execute({}, ctx)) as { requestId: string };
      expect(result.requestId).toBeTruthy();

      const { rows } = await getPool().query(
        `SELECT agent, requested_by, door, thread_ref, status FROM digest_requests WHERE id = $1`,
        [result.requestId],
      );
      expect(rows).toEqual([
        { agent: "saga", requested_by: "U_EXAMPLE_OWNER", door: "slack", thread_ref: "U_EXAMPLE_OWNER", status: "pending" },
      ]);
      const { rows: countRows } = await getPool().query(`SELECT COUNT(*) AS n FROM digest_requests`);
      expect(Number(countRows[0].n)).toBe(1);
    } finally {
      await getPool().query(`DELETE FROM digest_requests`);
      delete process.env["SLACK_ALLOWED_USER_IDS"];
    }
  });
});

// ── vault_list, in each area ──────────────────────────────────────────────────────────
//
// W5C-s3: one list tool, told which area. The separate `atlas_list` this block used to import
// is gone; both cases below now go through the same object with a different `area`.

let storeDir: string;

afterEach(() => {
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  delete process.env["VAULT_PATH"];
  delete process.env["ATLAS_PATH"];
});

// Both areas granted, standing in for the definition read the catalogue file wires in.
const vaultList = listTool({ areas: () => ["private", "shared"] });

describe("vault_list, in each area", () => {
  it("lists every note path in the private area", async () => {
    storeDir = mkdtempSync(join(tmpdir(), "eve-list-"));
    const brain = join(storeDir, "brain");
    mkdirSync(join(brain, "ventures"), { recursive: true });
    writeFileSync(join(brain, "ventures", "soma.md"), "# SOMA\n");
    writeFileSync(join(brain, "index.md"), "Index\n");
    process.env["VAULT_PATH"] = brain;

    const result = (await vaultList.execute({ area: "private" }, ctx)) as { notes: string[]; files: number };
    expect(result.files).toBe(2);
    expect(result.notes.sort()).toEqual(["index.md", "ventures/soma.md"]);
  });

  it("lists the shared area independently of the private one", async () => {
    storeDir = mkdtempSync(join(tmpdir(), "eve-list-"));
    const atlas = join(storeDir, "atlas");
    mkdirSync(atlas, { recursive: true });
    writeFileSync(join(atlas, "orakel.md"), "# Orakel\n");
    process.env["ATLAS_PATH"] = atlas;

    expect(await vaultList.execute({ area: "shared" }, ctx)).toEqual({ notes: ["orakel.md"], files: 1 });
  });

  it("an unmounted/empty store is an error, never an empty list", async () => {
    storeDir = mkdtempSync(join(tmpdir(), "eve-list-"));
    process.env["VAULT_PATH"] = join(storeDir, "not-mounted");

    await expect(vaultList.execute({ area: "private" }, ctx)).rejects.toThrow(StoreUnhealthyError);
  });
});

// ── read_url ───────────────────────────────────────────────────────────────────────────

let readabilityServer: Server | undefined;
let readabilityTokenDir: string;

beforeEach(() => {
  readabilityTokenDir = mkdtempSync(join(tmpdir(), "readability-token-"));
  writeFileSync(join(readabilityTokenDir, "readability-token"), "test-token\n");
  process.env["READABILITY_TOKEN_FILE"] = join(readabilityTokenDir, "readability-token");
});

afterEach(async () => {
  delete process.env["READABILITY_URL"];
  delete process.env["READABILITY_TOKEN_FILE"];
  rmSync(readabilityTokenDir, { recursive: true, force: true });
  if (readabilityServer) {
    await new Promise<void>((resolve) => readabilityServer!.close(() => resolve()));
    readabilityServer = undefined;
  }
});

describe("read_url", () => {
  it("returns the article title and text", async () => {
    const longText = "A".repeat(400);
    readabilityServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: "A Real Article", text: longText }));
    });
    const port = await new Promise<number>((resolve) => {
      readabilityServer!.listen(0, "127.0.0.1", () => resolve((readabilityServer!.address() as AddressInfo).port));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    const result = (await readUrl.execute({ url: "https://example.com/article" }, ctx)) as { title: string; text: string };
    expect(result).toEqual({ title: "A Real Article", text: longText });
  });

  it("throws ReadabilityNoContentError for a page with no usable article text", async () => {
    readabilityServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: "Stub", text: "too short" }));
    });
    const port = await new Promise<number>((resolve) => {
      readabilityServer!.listen(0, "127.0.0.1", () => resolve((readabilityServer!.address() as AddressInfo).port));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    await expect(readUrl.execute({ url: "https://example.com/paywall" }, ctx)).rejects.toThrow(
      ReadabilityNoContentError,
    );
  });
});
