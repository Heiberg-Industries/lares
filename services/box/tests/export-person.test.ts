// services/box/tests/export-person.test.ts — W5E-s2: everything this installation holds about one
// member, written out, and none of its secrets.
//
// WHY THIS FILE IS THE PROOF. An export has two failure modes and they pull in opposite
// directions: it can leave a person's records BEHIND (the same silence the erase's own test
// exists to catch — a table nobody listed), and it can carry a SECRET OUT (a refresh token in a
// file somebody emails to themselves). So the central tests below do not name the tables they
// check — they walk `lib/member-scope.ts` and the fixture's own seed list — and one test reads
// every byte this export wrote, anywhere under the output directory, and fails if a seeded token
// marker appears in any of them.
//
// The fixture (tests/helpers/three-spellings.ts) applies every services/box/sql file, the
// chief-of-staff standing-facts family and the dream tables' runtime DDL to a disposable
// Postgres, and seeds two fictional people whose rows use all four id conventions. The vault is a
// real `git init` in a throwaway directory, the way run-erase.test.ts builds one. Nothing here
// ever touches a real installation.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startThreeSpellingsDb,
  FIXTURE_OWNER,
  FIXTURE_SECOND,
  FIXTURE_ROWS,
  type TestDb,
} from "./helpers/three-spellings.js";
import type { Queryable } from "../lib/db.js";
import { MEMBER_SCOPE } from "../lib/member-scope.js";
import { resolvePerson } from "../lib/person-identity.js";
import { exportPerson, renderExportReport } from "../lib/export-person.js";

let db: TestDb;
let workRoot: string;
let vaultRoot: string;
let outDir: string;

/** The marker planted in every secret column of an oauth_tokens row. Deliberately a string that
 *  could not occur by accident, so "does any exported byte contain it" is a real question. */
const TOKEN_MARKER = "ZZTOKENMARKERZZ-do-not-export-this-0123456789";

function write(relPath: string, body: string): void {
  const abs = join(vaultRoot, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", vaultRoot, ...args], { encoding: "utf8" });
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(abs, base));
    else out.push(relative(base, abs).split("\\").join("/"));
  }
  return out.sort();
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(outDir, relPath), "utf8"));
}

function rows(table: string): Array<Record<string, unknown>> {
  return readJson(`data/${table}.json`) as Array<Record<string, unknown>>;
}

interface Manifest {
  person: string;
  date: string;
  files: Array<{ name: string; rows?: number; bytes?: number; sha256: string }>;
  withheld: string[];
  notIncluded: string[];
}

beforeEach(async () => {
  db = await startThreeSpellingsDb();

  workRoot = mkdtempSync(join(tmpdir(), "export-person-"));
  outDir = join(workRoot, "export");

  vaultRoot = join(workRoot, "brain");
  mkdirSync(vaultRoot, { recursive: true });
  write("people/ada.md", "---\nowner: fixture-owner\nscope: private\n---\n\nA note of theirs.\n");
  write("people/bo.md", "---\nowner: fixture-second\n---\n\nSomebody else's note.\n");
  write(
    "meetings/joint.md",
    "---\nparticipants:\n  - fixture-owner\n  - fixture-second\n---\n\nBoth of them.\n",
  );
  write("_meta/conversations/2026-09-19.md", "---\nowner: U_fixture\n---\n\nA logged turn.\n");
  git("init", "-q");
  git("config", "user.name", "Fixture Operator");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "the vault as it stands");
}, 180_000);

afterEach(async () => {
  await db.stop();
  rmSync(workRoot, { recursive: true, force: true });
});

describe("exportPerson — everything about one member", () => {
  it("writes their rows under every spelling they have, and none of the other member's", async () => {
    // A proposal reachable only through an id resolved from a row this person owns.
    const { rows: facts } = await db.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM standing_facts WHERE user_id = $1",
      [FIXTURE_OWNER],
    );
    await db.pool.query(
      `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, origin, source)
       VALUES ('supersede', $1, 'Fixture said something', 'Fixture says something else', 'owner', 'dream')`,
      [facts[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO memory_proposals
         (action, existing_id, existing_text, proposed_text, origin, source, ref, kind)
       VALUES ('add', '', '', 'An inference nobody has confirmed', 'agent', 'dream',
               'identity-fixturehash', 'preference')`,
    );

    const report = await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [] });
    expect(report.refusals).toEqual([]);

    const person = await resolvePerson(db.pool, FIXTURE_OWNER);
    const theirs = new Set(person.spellings);
    const exported = new Set(report.tables.filter((t) => t.file !== null).map((t) => t.table));

    // Every seeded row of theirs — whichever spelling it was written under — is in a file.
    const missing = [...new Set(FIXTURE_ROWS.filter((r) => theirs.has(r.value)).map((r) => r.table))]
      .filter((table) => !exported.has(table));
    expect(missing).toEqual([]);

    // The legacy spellings specifically: rows nobody would find by matching the register id alone.
    expect(rows("digest_requests")[0]!.requested_by).toBe("U_fixture");
    expect(rows("workflow_jobs")[0]!.principal).toBe("U_fixture");
    expect(rows("agent_door_claim_audit")[0]!.principal).toBe("U_fixture");

    // memory_proposals is reached through the ids of rows this person owns, never by a column.
    expect(rows("memory_proposals")).toHaveLength(1);
    expect(rows("memory_proposals")[0]!.action).toBe("supersede");
    const addLine = report.notIncluded.find((n) => n.table === "memory_proposals");
    expect(addLine?.rows).toBe(1);

    // Nothing of the second fixture person's, anywhere in the export.
    const secondSpellings = (await resolvePerson(db.pool, FIXTURE_SECOND)).spellings;
    const everything = filesUnder(outDir)
      .map((f) => readFileSync(join(outDir, f), "utf8"))
      .join("\n");
    for (const spelling of secondSpellings) {
      expect(everything).not.toContain(spelling);
    }
  }, 240_000);

  it("never writes token or key material, and says which columns it withheld", async () => {
    await db.pool.query("UPDATE oauth_tokens SET refresh_token_enc = $1 WHERE principal = $2", [
      TOKEN_MARKER,
      FIXTURE_OWNER,
    ]);

    const report = await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [] });
    expect(report.refusals).toEqual([]);

    // THE PROPERTY: not one byte of it, in any file anywhere under the output directory.
    for (const file of filesUnder(outDir)) {
      expect(readFileSync(join(outDir, file), "utf8")).not.toContain(TOKEN_MARKER);
    }

    // The row itself is still there — the metadata is the person's own record of a connection.
    const token = rows("oauth_tokens")[0]!;
    expect(token.principal).toBe(FIXTURE_OWNER);
    expect(token.provider).toBe("google");
    expect(token.email_address).toBe("owner@fixture.test");
    expect(token.refresh_token_enc).toBe("[withheld]");

    const manifest = readJson("manifest.json") as Manifest;
    expect(manifest.withheld).toContain("oauth_tokens.refresh_token_enc");
    expect(report.withheld).toContain("oauth_tokens.refresh_token_enc");
    expect(renderExportReport(report)).toMatch(/sign-ins to outside services are secrets/i);
  }, 240_000);

  it("writes a binary value as its size, never as its content", async () => {
    await db.pool.query("ALTER TABLE agent_notes ADD COLUMN attachment bytea");
    await db.pool.query(
      "UPDATE agent_notes SET attachment = decode('00ff00ff00', 'hex') WHERE owner = $1",
      [FIXTURE_OWNER],
    );

    await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [] });
    expect(rows("agent_notes")[0]!.attachment).toBe("[binary, 5 bytes]");
  }, 240_000);

  it("issues nothing but reads", async () => {
    const statements: string[] = [];
    const recorder: Queryable = {
      async query<R>(text: string, values?: unknown[]) {
        statements.push(text);
        const result = await db.pool.query(text, values);
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    };

    await exportPerson(recorder, { person: FIXTURE_OWNER, outDir, vaults: [vaultRoot] });

    expect(statements.length).toBeGreaterThan(10);
    const writes = statements.filter((s) => !/^\s*select\b/i.test(s));
    expect(writes).toEqual([]);
  }, 240_000);

  it("names every place in the inventory: exported, or said not to be included", async () => {
    const report = await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [] });
    const covered = new Set([
      ...report.tables.map((t) => t.table),
      ...report.notIncluded.map((n) => n.table),
    ]);
    const unaccounted = MEMBER_SCOPE.filter(
      (e) => (e.scope === "member" || e.scope === "resolved") && !covered.has(e.table),
    ).map((e) => e.table);
    expect(unaccounted).toEqual([]);

    // The fixture has more than one member, so the whole-corpus table is left out and named.
    expect(report.notIncluded.map((n) => n.table)).toContain("voice_exemplar");
    expect(report.tables.map((t) => t.table)).not.toContain("voice_exemplar");
  }, 240_000);

  it("copies their notes, lists the ones that also name somebody else, and leaves that person's own notes alone", async () => {
    const report = await exportPerson(db.pool, {
      person: FIXTURE_OWNER,
      outDir,
      vaults: [vaultRoot],
    });
    expect(report.refusals).toEqual([]);

    const name = basename(vaultRoot);
    expect(existsSync(join(outDir, "vault", name, "people/ada.md"))).toBe(true);
    expect(existsSync(join(outDir, "vault", name, "_meta/conversations/2026-09-19.md"))).toBe(true);
    expect(existsSync(join(outDir, "vault", name, "meetings/joint.md"))).toBe(false);
    expect(existsSync(join(outDir, "vault", name, "people/bo.md"))).toBe(false);

    expect(report.vaults[0]!.leftShared).toEqual(["meetings/joint.md"]);
    const manifest = readJson("manifest.json") as Manifest;
    expect(manifest.files.map((f) => f.name)).toContain(`vault/${name}/people/ada.md`);
    expect(renderExportReport(report)).toMatch(/also name other people/i);
  }, 240_000);

  it("records a checksum for every file it wrote, and the checksums are of the files", async () => {
    await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [vaultRoot] });
    const manifest = readJson("manifest.json") as Manifest;

    const written = filesUnder(outDir).filter((f) => f !== "manifest.json");
    expect(manifest.files.map((f) => f.name).sort()).toEqual(written);
    for (const file of manifest.files) {
      const bytes = readFileSync(join(outDir, file.name));
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(manifest.person).toBe(FIXTURE_OWNER);
    expect(manifest.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 240_000);

  it("keeps the export to its owner: the directory 0700, the files 0600", async () => {
    await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [vaultRoot] });
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(outDir, "data")).mode & 0o777).toBe(0o700);
    expect(statSync(join(outDir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(outDir, "data/users.json")).mode & 0o777).toBe(0o600);
  }, 240_000);

  it("refuses a name the register does not hold, and writes nothing at all", async () => {
    const report = await exportPerson(db.pool, {
      person: "somebody-nobody-here-answers-to",
      outDir,
      vaults: [vaultRoot],
    });
    expect(report.refusals.join(" ")).toMatch(/answers to/i);
    expect(report.tables).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
    expect(renderExportReport(report)).toMatch(/nothing was written/i);
  }, 240_000);

  it("refuses a directory that already holds something", async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "something-else.txt"), "not ours\n");

    const report = await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [] });
    expect(report.refusals.join(" ")).toMatch(/already has something in it/i);
    expect(filesUnder(outDir)).toEqual(["something-else.txt"]);
  }, 240_000);

  it("refuses to write the export inside the vault it is reading", async () => {
    const report = await exportPerson(db.pool, {
      person: FIXTURE_OWNER,
      outDir: join(vaultRoot, "export"),
      vaults: [vaultRoot],
    });
    expect(report.refusals.join(" ")).toMatch(/inside the vault/i);
    expect(existsSync(join(vaultRoot, "export"))).toBe(false);
  }, 240_000);

  it("refuses a missing table by naming the file that creates it", async () => {
    await db.pool.query("DROP TABLE memory_reads");
    const report = await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [] });
    expect(report.refusals.join(" ")).toContain("memory_reads");
    expect(report.refusals.join(" ")).toContain("075_memory_reads.sql");
    expect(existsSync(outDir)).toBe(false);
  }, 240_000);
});
