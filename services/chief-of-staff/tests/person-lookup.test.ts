import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { randomBytes, createCipheriv } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import personLookup from "../catalogue/person_lookup.js";
import { makePersonSources, eveSagaPersonWiring } from "../lib/person-sources.js";
import type { PersonWiring } from "../lib/person-sources.js";
import { gatherPerson } from "../lib/person/gather.js";
import { renderDossier } from "../lib/person/render.js";
import { NotApplicableError } from "../lib/person/types.js";
import { __setTestGmailApiFactory, __setTestCalendarApiFactory } from "../lib/google.js";
import { getPool, closePool } from "@lares/agent-kit/db";
import { quiet } from "./helpers/quiet-pool.js";

/**
 * Two halves:
 *
 *   1. "the full chain, minus vendors" — `gatherPerson` → `resolvePerson` → `renderDossier`,
 *      wired through `makePersonSources` against a stub `PersonWiring` (same style as
 *      tests/person-sources.test.ts). Proves the honesty states the brief calls out by name
 *      survive all the way to the RENDERED TEXT, not just the adapter's return value: found,
 *      failed (no conflation across sources), not-applicable (distinct from failed), ambiguous,
 *      and matched-loosely.
 *
 *   2. "the real wiring" — `eveSagaPersonWiring()`'s individual functions against chief-of-staff's
 *      own real clients' own test doubles (a real Postgres for identity/oauth_tokens, a real
 *      HTTP stub for Twenty, `__setTestGmailApiFactory`/`__setTestCalendarApiFactory`
 *      for Gmail/Calendar, a real temp-dir vault) — proving the
 *      adapter actually calls the RIGHT client with the RIGHT request shape — plus the
 *      `person_lookup` TOOL itself, end to end, over the same real infrastructure.
 */

const READ_CTX = {} as never;

// -----------------------------------------------------------------------------------------
// The full chain minus vendors: stub PersonWiring, real gatherPerson/resolvePerson/
// renderDossier. No network/DB/filesystem I/O in this half.
// -----------------------------------------------------------------------------------------

const baseWiring: PersonWiring = {
  myAddresses: async () => ["owner@owner.example"],
  twentyLookup: async () => ({
    people: [{ id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: null }],
    companies: [],
  }),
  twentyCompanyForPerson: async () => null,
  mailSearch: async () => [],
  mailRead: async () => null,
  listEvents: async () => [],
  vaultSearch: async () => [],
  vaultRead: async () => "",
  atlasSearch: async () => [],
  crmCompanyByDomain: async () => null,
};

const per = { source: "twenty", sourceId: "p1", displayName: "Per Hansen", emails: ["per@partner.example"] };

async function render(w: PersonWiring, query: Parameters<typeof gatherPerson>[0]): Promise<string> {
  return renderDossier(await gatherPerson(query, makePersonSources(w)));
}

describe("the full chain (stub wiring): found / failed / not-applicable / ambiguous / matched-loosely reach the rendered text", () => {
  it("all sources ok → a resolved dossier with every source reading OK", async () => {
    const text = await render(
      {
        ...baseWiring,
        mailSearch: async () => ["m1"],
        mailRead: async () => ({
          id: "m1", threadId: "t1", from: "Per <per@partner.example>", to: ["owner@owner.example"],
          subject: "Pilot", bodyText: "", sentAt: "2026-07-15T10:00:00Z", messageId: "<a>", references: "",
          isCalendarNotice: false,
        }),
        listEvents: async () => [
          { id: "e1", summary: "Pilot sync", start: "2026-07-20T09:00:00Z", end: "2026-07-20T09:30:00Z", attendees: [{ email: "per@partner.example" }] },
        ],
        vaultSearch: async () => ["people/transcripts/2026-07-10-per.md"],
        vaultRead: async () => "Per Hansen talked about the pilot going well.",
        twentyCompanyForPerson: async (id) => (id === "p1" ? "Northwind Audio" : null),
      },
      { name: "Per Hansen" },
    );
    expect(text).toContain("PERSON LOOKUP: Per Hansen");
    expect(text).toContain("COMPANY — Northwind Audio");
    expect(text).toContain("- crm: read OK");
    expect(text).toContain("- mail: read OK");
    expect(text).toContain("- meetings: read OK");
    expect(text).toContain("- transcripts: read OK");
    expect(text).toContain("- company: read OK");
    // render.ts's trailing footer always mentions the phrase "COULD NOT READ" as boilerplate
    // explanation — so the real assertion is that no SOURCE LINE ("- name: COULD NOT READ")
    // uses it, not that the string never appears anywhere in the text.
    expect(text).not.toMatch(/- \w+: COULD NOT READ/);
  });

  it("crm fails → the lookup says it could not complete, and never claims there is no record", async () => {
    const text = await render(
      {
        ...baseWiring,
        twentyLookup: async () => { throw new Error("Twenty GET /people → 503"); },
      },
      { name: "Per Hansen" },
    );
    expect(text).toContain("COULD NOT COMPLETE THE LOOKUP");
    expect(text).toContain("- crm: COULD NOT READ (Twenty GET /people → 503)");
    expect(text).not.toContain("No record in the CRM.");
  });

  it("an address nobody holds → UNKNOWN, with the CRM reported as asked and empty (distinct from COULD NOT READ)", async () => {
    const text = await render(
      {
        ...baseWiring,
        twentyLookup: async () => ({ people: [], companies: [] }),
      },
      { email: "stranger@example.com" },
    );
    expect(text).toContain("PERSON LOOKUP — UNKNOWN");
    expect(text).toContain("No record in the CRM.");
    expect(text).toContain("- crm: nothing found");
    expect(text).not.toContain("- crm: COULD NOT READ");
  });

  it("two same-name candidates with different addresses → AMBIGUOUS, never a guess", async () => {
    const text = await render(
      {
        ...baseWiring,
        twentyLookup: async () => ({
          people: [
            { id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: null },
            { id: "p2", name: "Per Hansen", email: "per@othercompany.co", companyId: null },
          ],
          companies: [],
        }),
      },
      { name: "Per Hansen" },
    );
    expect(text).toContain("PERSON LOOKUP — AMBIGUOUS: Per Hansen");
    expect(text).toContain("Do NOT pick one and do NOT merge them");
  });

  it("a partial name uniquely matching one record → MATCHED LOOSELY, disclosed", async () => {
    const text = await render(baseWiring, { name: "Per" });
    expect(text).toContain("PERSON LOOKUP: Per Hansen");
    expect(text).toContain('MATCHED LOOSELY: you asked for "Per"');
  });
});

// -----------------------------------------------------------------------------------------
// The real wiring: eveSagaPersonWiring() against real client test doubles, plus the
// person_lookup TOOL end to end over the same infrastructure.
// -----------------------------------------------------------------------------------------

const OWNER_PRINCIPAL = "U_owner";

function encryptForTest(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

interface TwentyRoute { status: number; body: unknown }

/** Routes by URL rather than call order — person_lookup issues several concurrent Twenty
 *  requests (several stages run in parallel),
 *  so a sequential response queue (as tests/tools-twenty.test.ts uses) would answer the wrong
 *  request to the wrong caller. */
function twentyRouter(routes: Record<string, TwentyRoute>, requests: string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    requests.push(url);
    const hit = Object.entries(routes).find(([pattern]) => url.includes(pattern))?.[1];
    const out = hit ?? { status: 200, body: { data: {} } };
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  };
}

function listenOn(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/**
 * — the ORGANISATION stage through the whole chain, stub wiring only.
 *
 * The shape that filed the ticket: an intro call with someone at a company the owner already
 * self-hosts. The PERSON is genuinely unknown — that answer was right — but the dossier had no
 * way to say the COMPANY is not, so the brief told the owner to go read up on the owner's own vendor.
 */
describe("the organisation stage: a stranger at a company we know", () => {
  it("an UNKNOWN person at a known company still yields an Organisation section, naming the note", async () => {
    const text = await render(
      {
        ...baseWiring,
        // Nobody by this address, anywhere.
        twentyLookup: async () => ({ people: [], companies: [] }),
              vaultSearch: async (q) => (q.toLowerCase().includes("atbridgeco") ? ["tools/bridgeco-tracker-bridge.md"] : []),
      },
      { email: "dana@atbridgeco.example" },
    );
    expect(text).toContain("PERSON LOOKUP — UNKNOWN: dana@atbridgeco.example");
    expect(text).toContain("You do know their ORGANISATION, though");
    expect(text).toContain("ORGANISATION — atbridgeco.example:");
    expect(text).toContain("- brain: tools/bridgeco-tracker-bridge.md");
    expect(text).toContain("- organisation: read OK");
  });

  /**
   * The ticket's own scenario, which the first cut still missed. The
   * Brain note calls the company "Bridgeco" and never writes "atbridgeco", so the domain-derived terms
   * alone reach nothing. The CRM knows the name; it is asked first, and its answer becomes a term.
   */
  it("finds a note that only ever says 'Bridgeco' — the CRM's name becomes a search term", async () => {
    const text = await render(
      {
        ...baseWiring,
        twentyLookup: async () => ({ people: [], companies: [] }),
              vaultSearch: async (q) => (q === "Bridgeco" ? ["tools/bridgeco-tracker-bridge.md"] : []),
        crmCompanyByDomain: async () => ({ name: "Bridgeco", domain: "https://atbridgeco.example", orgNumber: null }),
      },
      { email: "dana@atbridgeco.example" },
    );
    expect(text).toContain("PERSON LOOKUP — UNKNOWN: dana@atbridgeco.example");
    expect(text).toContain("ORGANISATION — Bridgeco — atbridgeco.example:");
    expect(text).toContain("- brain: tools/bridgeco-tracker-bridge.md");
    expect(text).toContain("- CRM: Bridgeco (https://atbridgeco.example)");
  });

  /**
   * A CRM person with a linked company, on a personal mailbox. Before,
   * this rendered "no company on file" while the CRM had one on file, one call away.
   */
  it("a CRM person on a gmail address still gets an organisation — via their CRM record", async () => {
    const text = await render(
      {
        ...baseWiring,
        twentyLookup: async () => ({
          people: [{ id: "p1", name: "Per Hansen", email: "per@gmail.com", companyId: "c1" }],
          companies: [],
        }),
        twentyCompanyForPerson: async (id) => (id === "p1" ? "Northwind Audio" : null),
        vaultSearch: async (q) => (q === "Northwind Audio" ? ["companies/northwind-audio.md"] : []),
      },
      { email: "per@gmail.com" },
    );
    expect(text).toContain("ORGANISATION — Northwind Audio:");
    expect(text).toContain("- brain: companies/northwind-audio.md");
    expect(text).not.toContain("- organisation: not searchable this way");
  });

  it("a RESOLVED person's organisation reaches the dossier too, from both stores", async () => {
    const text = await render(
      {
        ...baseWiring,
        twentyLookup: async () => ({
          people: [{ id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: "c1" }],
          companies: [],
        }),
        twentyCompanyForPerson: async (id) => (id === "p1" ? "Northwind Audio" : null),
        vaultSearch: async (q) => (q === "Northwind Audio" ? ["companies/northwind-audio.md"] : []),
        atlasSearch: async (q) => (q === "Northwind Audio" ? ["ventures/acme/northwind-audio.md"] : []),
      },
      { name: "Per Hansen" },
    );
    expect(text).toContain("ORGANISATION — Northwind Audio — partner.example:");
    expect(text).toContain("- brain: companies/northwind-audio.md");
    expect(text).toContain("- atlas: ventures/acme/northwind-audio.md");
  });

  it("a free-mail address NEVER reaches the organisation source — not asked, not asked-and-empty", async () => {
    const calls: unknown[] = [];
    const sources = makePersonSources({
      ...baseWiring,
      twentyLookup: async () => ({ people: [], companies: [] }),
      vaultSearch: async () => { calls.push("brain"); return []; },
      atlasSearch: async () => { calls.push("atlas"); return []; },
      crmCompanyByDomain: async () => { calls.push("crm-domain"); return null; },
    });
    const spied = {
      ...sources,
      organisation: async (q: Parameters<typeof sources.organisation>[0]) => {
        calls.push(q);
        return sources.organisation(q);
      },
    };
    const text = renderDossier(await gatherPerson({ email: "someone@gmail.com" }, spied));

    expect(calls).toEqual([]);
    expect(text).toContain("- organisation: not searchable this way");
    expect(text).not.toMatch(/company unknown/i);
    expect(text).not.toContain("ORGANISATION — ");
  });

  /**
   * The organisation stage used to start on EVERY non-ambiguous
   * lookup — including the email drafter's, which renders `bounded` and therefore throws the
   * whole section away. Up to six synchronous full-note-store walks plus a Twenty call, per
   * inbound message, per tick, blocking the event loop for output nobody sees.
   *
   * Both halves matter: the stage must not run when it was not asked for, AND the dossier must
   * say "not consulted" rather than "nothing found" — the difference this whole file exists for.
   */
  describe("{ organisation: false } — the caller that renders no organisation section", () => {
    const withOrgSpy = () => {
      const calls: unknown[] = [];
      const sources = makePersonSources({
        ...baseWiring,
        vaultSearch: async () => { calls.push("brain"); return ["companies/northwind-audio.md"]; },
        atlasSearch: async () => { calls.push("atlas"); return []; },
        crmCompanyByDomain: async () => { calls.push("crm-domain"); return null; },
      });
      return {
        calls,
        spied: {
          ...sources,
          organisation: async (q: Parameters<typeof sources.organisation>[0]) => {
            calls.push("organisation");
            return sources.organisation(q);
          },
        },
      };
    };

    it("never calls the organisation source, nor the CRM-by-domain lookup behind it", async () => {
      const { calls, spied } = withOrgSpy();
      const d = await gatherPerson({ email: "per@partner.example" }, spied, { organisation: false });

      // `vaultSearch`/`atlasSearch` are shared with the transcripts stage, so they are not
      // org-exclusive; `organisation` and `crmCompanyByDomain` are, and neither is touched.
      expect(calls).not.toContain("organisation");
      expect(calls).not.toContain("crm-domain");
      expect(d.sources.organisation.status).toBe("not-applicable");
      expect(renderDossier(d)).toContain("- organisation: not searchable this way (not consulted");
    });

    it("says NOT CONSULTED, never 'nothing found' — we did not ask is not we asked and there is nothing", async () => {
      const { spied } = withOrgSpy();
      const text = renderDossier(await gatherPerson({ email: "per@partner.example" }, spied, { organisation: false }));

      expect(text).not.toContain("- organisation: nothing found");
      expect(text).not.toContain("ORGANISATION — ");
    });

    it("the DEFAULT still asks — the skip is opt-in, and person_lookup/the briefs keep the section", async () => {
      const { calls, spied } = withOrgSpy();
      const text = renderDossier(await gatherPerson({ email: "per@partner.example" }, spied));

      expect(calls).toContain("organisation");
      expect(text).toContain("ORGANISATION — ");
      expect(text).toContain("- brain: companies/northwind-audio.md");
    });
  });

  it("a store that could not be read renders COULD NOT READ, never 'nothing found'", async () => {
    const text = await render(
      {
        ...baseWiring,
        atlasSearch: async () => { throw new Error("store unhealthy: no markdown files found anywhere under /srv/atlas"); },
      },
      { name: "Per Hansen" },
    );
    expect(text).toContain("- organisation: COULD NOT READ (store unhealthy");
    expect(text).not.toContain("- organisation: nothing found");
    // No conflation: the rest of the fan-out keeps its own state.
  });

  it("an AMBIGUOUS query spends no organisation I/O at all", async () => {
    const calls: string[] = [];
    const text = await render(
      {
        ...baseWiring,
        twentyLookup: async () => ({
          people: [
            { id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: null },
            { id: "p2", name: "Per Hansen", email: "per@other.co", companyId: null },
          ],
          companies: [],
        }),
        vaultSearch: async () => { calls.push("brain"); return []; },
        atlasSearch: async () => { calls.push("atlas"); return []; },
      },
      { name: "Per Hansen" },
    );
    expect(text).toContain("PERSON LOOKUP — AMBIGUOUS");
    expect(calls).toEqual([]);
  });
});

describe("eveSagaPersonWiring() against real client test doubles, and person_lookup end to end", () => {
  let container: StartedPostgreSqlContainer;
  let workDir: string;
  let twentyServer: Server | undefined;
  let twentyRequests: string[];
  let testKeyHex: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
    await quiet(getPool()).query(`
      CREATE TABLE oauth_tokens (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        principal          text        NOT NULL,
        provider           text        NOT NULL,
        org_id             text        NOT NULL,
        email_address      text        NOT NULL,
        refresh_token_enc  text        NOT NULL,
        scopes             text[]      NOT NULL DEFAULT '{}',
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT oauth_tokens_principal_provider_email_uk UNIQUE (principal, provider, email_address)
      );
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
      INSERT INTO users (id, display_name, primary_email) VALUES ('owner-1', 'Test Owner', 'owner@owner.example');
      INSERT INTO user_aliases (system, alias, user_id) VALUES ('email', 'owner@owner.example', 'owner-1');
    `);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  // Starts two HTTP servers, seeds a real sqlite db, and queries the real Postgres
  // testcontainer — once per test. Under concurrent testcontainer load (many Postgres
  // containers starting across the suite at once) this can genuinely exceed vitest's 10s
  // default hook timeout — a real timeout, not flake — so this hook gets the same explicit
  // headroom as the suite's own `beforeAll` above (120_000).
  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "person-lookup-"));

    // Twenty
    twentyRequests = [];
    const { server: ts, port: tp } = await listenOn(twentyRouter(
      {
        "emails.primaryEmail[eq]:per%40partner.example":
          { status: 200, body: { data: { people: [{ id: "p1", name: { firstName: "Per", lastName: "Hansen" }, emails: { primaryEmail: "per@partner.example" }, companyId: "c1" } ] } } },
        "/people/p1":
          { status: 200, body: { data: { person: { id: "p1", name: { firstName: "Per", lastName: "Hansen" }, emails: { primaryEmail: "per@partner.example" }, companyId: "c1" } } } },
        "/companies/c1":
          { status: 200, body: { data: { company: { id: "c1", name: "Northwind Audio", domainName: { primaryLinkUrl: "partner.example" }, orgNumber: "999" } } } },
        // — the organisation stage's CRM lookup BY DOMAIN (a LINKS composite subfield,
        // addressed exactly the way `emails.primaryEmail` is).
        "domainName.primaryLinkUrl[ilike]":
          { status: 200, body: { data: { companies: [{ id: "c1", name: "Northwind Audio", domainName: { primaryLinkUrl: "https://partner.example" }, orgNumber: "999" }] } } },
      },
      twentyRequests,
    ));
    twentyServer = ts;
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${tp}`;

    // Secret files (Twenty key, Google token-enc-key + client id/secret)
    testKeyHex = randomBytes(32).toString("hex");
    writeFileSync(join(workDir, "twenty-key"), "test-twenty-key\n");
    process.env["TWENTY_KEY_FILE"] = join(workDir, "twenty-key");
    writeFileSync(join(workDir, "token-enc-key"), testKeyHex);
    process.env["TOKEN_ENC_KEY_FILE"] = join(workDir, "token-enc-key");
    writeFileSync(join(workDir, "client-id"), "test-client-id");
    process.env["GOOGLE_CLIENT_ID_ACME_FILE"] = join(workDir, "client-id");
    writeFileSync(join(workDir, "client-secret"), "test-client-secret");
    process.env["GOOGLE_CLIENT_SECRET_ACME_FILE"] = join(workDir, "client-secret");
    process.env["GOOGLE_PRINCIPAL_ID"] = OWNER_PRINCIPAL;

    // A real oauth_tokens row so googleClients().gmail()/.calendar() resolve.
    const enc = encryptForTest("refresh-token-real", testKeyHex);
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [OWNER_PRINCIPAL, "google", "acme", "owner@owner.example", enc, ["gmail.readonly"]],
    );

    // Vault (Brain)
    const vaultDir = join(workDir, "brain");
    mkdirSync(join(vaultDir, "people", "transcripts"), { recursive: true });
    writeFileSync(
      join(vaultDir, "people", "transcripts", "2026-07-10-per.md"),
      "# Pilot sync\n\nPer Hansen said the pilot is going well.\n",
    );
    process.env["VAULT_PATH"] = vaultDir;

    // Atlas (the business store) —. A REAL directory with real markdown, because
    // notes-store treats an empty or unmounted store as a FAILURE rather than an empty answer,
    // and the organisation stage depends on exactly that distinction.
    const atlasDir = join(workDir, "atlas");
    mkdirSync(join(atlasDir, "ventures"), { recursive: true });
    writeFileSync(
      join(atlasDir, "ventures", "northwind-audio.md"),
      "# Northwind Audio\n\npartner.example — audio hardware; pilot counterpart.\n",
    );
    process.env["ATLAS_PATH"] = atlasDir;
  }, 60_000);

  // Same reasoning as the suite's `beforeAll` above (120_000): this hook starts two HTTP
  // servers, seeds a real sqlite db, and queries the real Postgres testcontainer — under
  // concurrent testcontainer load (many Postgres containers starting across the suite at
  // once) that can genuinely exceed vitest's 10s default hook timeout, not just flake. A real
  // timeout here is a hook failure, not a test failure — 60s gives it headroom without
  // masking an actual hang.
  afterEach(async () => {
    await new Promise<void>((resolve) => twentyServer ? twentyServer.close(() => resolve()) : resolve());
    __setTestGmailApiFactory(undefined);
    __setTestCalendarApiFactory(undefined);
    await getPool().query(`DELETE FROM oauth_tokens`);
    rmSync(workDir, { recursive: true, force: true });
    for (const key of [
      "TWENTY_BASE_URL", "TWENTY_KEY_FILE",
      "TOKEN_ENC_KEY_FILE", "GOOGLE_CLIENT_ID_ACME_FILE", "GOOGLE_CLIENT_SECRET_ACME_FILE",
      "GOOGLE_PRINCIPAL_ID", "VAULT_PATH", "ATLAS_PATH",
    ]) delete process.env[key];
  }, 60_000);

  // ---------------------------------------------------------------------------------------
  // Wiring-correctness: each eveSagaPersonWiring() function against its real client
  // ---------------------------------------------------------------------------------------

  it("myAddresses() reads the real identity registry via Postgres", async () => {
    const w = eveSagaPersonWiring();
    expect(await w.myAddresses()).toEqual(["owner@owner.example"]);
  });

  it("twentyLookup() issues the real Twenty REST call for an email-shaped term", async () => {
    const w = eveSagaPersonWiring();
    const result = await w.twentyLookup({ query: "per@partner.example" });
    expect(result.people).toEqual([{ id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: "c1" }]);
    expect(twentyRequests.some((u) => u.includes("emails.primaryEmail"))).toBe(true);
  });

  it("twentyCompanyForPerson() resolves the company NAME via the real two-step Twenty fetch", async () => {
    const w = eveSagaPersonWiring();
    expect(await w.twentyCompanyForPerson("p1")).toBe("Northwind Audio");
    expect(twentyRequests).toEqual(expect.arrayContaining([expect.stringContaining("/people/p1"), expect.stringContaining("/companies/c1")]));
  });

  it("mailSearch()/mailRead() go through the real (stubbed) Gmail client", async () => {
    const calls: unknown[] = [];
    __setTestGmailApiFactory(() => ({
      users: {
        messages: {
          list: async (params: unknown) => { calls.push(params); return { data: { messages: [{ id: "m1", threadId: "t1" }] } }; },
          get: async (params: unknown) => {
            calls.push(params);
            return {
              data: {
                id: "m1", threadId: "t1",
                payload: { headers: [
                  { name: "From", value: "Per <per@partner.example>" },
                  { name: "To", value: "owner@owner.example" },
                  { name: "Subject", value: "Pilot" },
                  { name: "Date", value: "2026-07-15T10:00:00Z" },
                ] },
              },
            };
          },
        },
      },
    } as never));
    const w = eveSagaPersonWiring();
    const ids = await w.mailSearch("from:per@partner.example", 25);
    expect(ids).toEqual(["m1"]);
    const msg = await w.mailRead("m1");
    expect(msg?.subject).toBe("Pilot");
    expect(calls).toHaveLength(2);
  });

  it("listEvents() goes through the real (stubbed) Calendar client", async () => {
    __setTestCalendarApiFactory(() => ({
      events: {
        list: async () => ({
          data: { items: [{ id: "e1", summary: "Pilot sync", start: { dateTime: "2026-07-20T09:00:00Z" }, end: { dateTime: "2026-07-20T09:30:00Z" }, attendees: [{ email: "per@partner.example" }] }] },
        }),
      },
    } as never));
    const w = eveSagaPersonWiring();
    const events = await w.listEvents({ timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-12-31T00:00:00Z", max: 250 });
    expect(events).toEqual([{ id: "e1", summary: "Pilot sync", start: "2026-07-20T09:00:00Z", end: "2026-07-20T09:30:00Z", attendees: [{ email: "per@partner.example" }] }]);
  });

  it("vaultSearch()/vaultRead() go through the real Brain store on disk", async () => {
    const w = eveSagaPersonWiring();
    const hits = await w.vaultSearch("Per Hansen");
    expect(hits).toContain("people/transcripts/2026-07-10-per.md");
    const content = await w.vaultRead(hits[0]!);
    expect(content).toContain("pilot is going well");
  });

  it("atlasSearch() goes through the real Atlas store on disk — the same engine as the Brain", async () => {
    const w = eveSagaPersonWiring();
    expect(await w.atlasSearch("partner.example")).toContain("ventures/northwind-audio.md");
    // Two separate roots: an Atlas query must not reach into the Brain.
    expect(await w.atlasSearch("Per Hansen")).not.toContain("people/transcripts/2026-07-10-per.md");
  });

  it("atlasSearch() THROWS when the store is not configured — never an empty answer", async () => {
    delete process.env["ATLAS_PATH"];
    const w = eveSagaPersonWiring();
    await expect(w.atlasSearch("northwind")).rejects.toThrow(/ATLAS_PATH/);
  });

  it("crmCompanyByDomain() issues the real Twenty REST call against the domain subfield", async () => {
    const w = eveSagaPersonWiring();
    expect(await w.crmCompanyByDomain("partner.example")).toMatchObject({ name: "Northwind Audio", domain: "https://partner.example", orgNumber: "999" });
    expect(twentyRequests.some((u) => u.includes("domainName.primaryLinkUrl"))).toBe(true);
  });

  it("crmCompanyByDomain() REJECTS a substring match on a different host", async () => {
    // The filter is an `ilike %domain%`, so "bridgeco.example" matches a stored "https://atbridgeco.example".
    // Post-verification is the only thing standing between that and the wrong company under the
    // right name. The stub answers every /companies query with the Northwind Audio record.
    const w = eveSagaPersonWiring();
    expect(await w.crmCompanyByDomain("omono.co")).toBeNull();
    // A subdomain of the queried domain is a real match, not a coincidence.
    expect(await w.crmCompanyByDomain("partner.example")).toMatchObject({ name: "Northwind Audio" });
  });

  // ---------------------------------------------------------------------------------------
  // person_lookup end to end — the module-scope-constructed tool, over the same real infra.
  // ---------------------------------------------------------------------------------------

  it("end to end: every source found, over real infrastructure", async () => {
    __setTestGmailApiFactory(() => ({
      users: {
        messages: {
          list: async () => ({ data: { messages: [{ id: "m1", threadId: "t1" }] } }),
          get: async () => ({
            data: {
              id: "m1", threadId: "t1",
              payload: { headers: [
                { name: "From", value: "Per <per@partner.example>" },
                { name: "To", value: "owner@owner.example" },
                { name: "Subject", value: "Pilot" },
                { name: "Date", value: "2026-07-15T10:00:00Z" },
              ] },
            },
          }),
        },
      },
    } as never));
    __setTestCalendarApiFactory(() => ({
      events: {
        list: async () => ({
          data: { items: [{ id: "e1", summary: "Pilot sync", start: { dateTime: "2026-07-20T09:00:00Z" }, end: { dateTime: "2026-07-20T09:30:00Z" }, attendees: [{ email: "per@partner.example" }] }] },
        }),
      },
    } as never));

    const result = await personLookup.execute({ email: "per@partner.example" }, READ_CTX);

    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("PERSON LOOKUP: Per Hansen");
    expect(text).toContain("COMPANY — Northwind Audio");
    expect(text).toContain("- crm: read OK");
    expect(text).toContain("- mail: read OK");
    expect(text).toContain("- meetings: read OK");
    expect(text).toContain("- transcripts: read OK");
    expect(text).toContain("- company: read OK");
    expect(text).toContain("- organisation: read OK");
    // — the organisation stage, over the real Atlas store and the real Twenty stub.
    expect(text).toContain("ORGANISATION — Northwind Audio — partner.example:");
    expect(text).toContain("- atlas: ventures/northwind-audio.md");
    expect(text).toContain("- CRM: Northwind Audio (https://partner.example), org no 999");
    // render.ts's trailing footer always mentions the phrase "COULD NOT READ" as boilerplate
    // explanation — so the real assertion is that no SOURCE LINE ("- name: COULD NOT READ")
    // uses it, not that the string never appears anywhere in the text.
    expect(text).not.toMatch(/- \w+: COULD NOT READ/);
  });

  it("person_lookup refuses an empty query without fanning out on a question nobody asked", async () => {
    await expect(personLookup.execute({}, READ_CTX)).rejects.toThrow(/needs a name or email/);
    expect(twentyRequests).toHaveLength(0);
  });
});
