import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { surfaceCommercial, type SurfaceDeps, type SurfacedContact } from "../lib/commercial/surface.js";
import { isJunkContact } from "../lib/commercial/junk.js";
import { scoreContact } from "../lib/commercial/score.js";
import { icpFor } from "../lib/commercial/icp.js";
import { listPeopleCapped, type TwentyPerson } from "../lib/twenty-people.js";
import { TwentyUnavailableError } from "../lib/twenty-client.js";

// The one lookup the private console check makes against the database: whether this console
// conversation is bound to this member. Replaced so section 6 can say "bound" or "refused"; no
// other test in this file presents a console admission, so none of them reaches it.
const consoleBinding = vi.hoisted(() => vi.fn());
vi.mock("../../../packages/agent-kit/src/console-turn-authority.js", async (original) => ({
  ...(await original<typeof import("../../../packages/agent-kit/src/console-turn-authority.js")>()),
  requireConsoleSessionBinding: consoleBinding,
}));

// The last valid definition lives in Postgres. A fixture pool with just the statements
// `definition-cache.ts` issues, so section 6 runs the REAL fail-closed fallback over a mounted
// definition folder without a database. Nothing else in this file touches the pool.
const definitionStore = vi.hoisted(() => ({
  remembered: new Map<string, { definition: unknown; duties: string; voice: string; hash: string }>(),
  reads: 0,
}));
vi.mock("../../../packages/agent-kit/src/db.js", async (original) => ({
  ...(await original<typeof import("../../../packages/agent-kit/src/db.js")>()),
  getPool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      const name = String(params[0]);
      if (sql.includes("SELECT definition")) {
        const row = definitionStore.remembered.get(name);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("INSERT INTO agent_definitions")) {
        definitionStore.reads += 1;
        definitionStore.remembered.set(name, { definition: JSON.parse(String(params[1])), duties: String(params[2]), voice: String(params[3]), hash: String(params[4]) });
      }
      return { rows: [] };
    },
  }),
}));

// `gatewayModel` (lib/gateway-provider.ts) caches its providers at MODULE scope — so a fresh
// module per test is needed. commercial_who_to_contact
// transitively imports it via lib/llm-complete.ts, so each "live wiring" test below needs its
// own fresh import too, or a later test's GATEWAY_URL would silently keep talking to an
// earlier test's already-closed gateway server.
//
// Wrapped the tool's default export in `resolveSkillTool`, whose
// return type is `Tool | DisabledToolSentinel` — the same union `resolveExtensionTool` has
// always returned (see agent-declaration.test.ts's own `as { approval?: unknown }` casts over
// EXTENSION_TOOLS). Every test below calls `.execute()` directly, which the sentinel branch
// has no such method. The chief of staff's grants make the skill resolve live (never a sentinel) today,
// exactly as this file's live wiring tests assume.
//
// The cast alone is not the whole story, and a cast is a claim about a
// value, not a check on one. Drop the `twenty` grant from agent.json and the tool
// resolves to nothing — every test below would then fail on "tool.execute is not a function",
// a stack trace about a missing method rather than the actual cause. One check turns that into
// a sentence naming the declaration to fix.
//
// eve 1.0: the tool file is ONE function of the conversation (`defineDynamic(fn)` keeps it under
// the symbol below) and it answers with the tool or with `null`. It is called here with an
// ordinary conversation, not a private console one. A conversation is a session id of its own
// plus a memo like the framework's: a key runs once, its JSON is kept, a throw keeps nothing.
interface CommercialTool { execute: (input: { brand?: string }, ctx: unknown) => Promise<Record<string, SurfacedContact[]>> }
type ToolFunction = (ctx: unknown) => Promise<CommercialTool | null>;
let conversations = 0;
function conversation(auth: { current: unknown; initiator: unknown }) {
  const kept = new Map<string, string>();
  return {
    kept,
    session: { id: `commercial-test-${conversations += 1}`, auth },
    memo: async <T>(key: unknown, fn: () => T | Promise<T>): Promise<T> => {
      const k = JSON.stringify(key ?? null);
      if (!kept.has(k)) kept.set(k, JSON.stringify(await fn()));
      return JSON.parse(kept.get(k)!) as T;
    },
  };
}
const ordinaryConversation = () => conversation({ current: null, initiator: null });
async function commercialResolver(): Promise<ToolFunction> {
  const resolver = (await import("../agent/tools/commercial_who_to_contact.js")).default as unknown as Record<symbol, ToolFunction>;
  return resolver[Symbol.for("eve.dynamic")]!;
}
async function freshCommercialTool() {
  vi.resetModules();
  const tool = await (await commercialResolver())(ordinaryConversation());
  if (!tool || typeof tool.execute !== "function") {
    throw new Error(
      "commercial_who_to_contact resolved to nothing: agent.json no longer grants " +
        "the `commercial` skill what it requires (twenty:read). Every test in this " +
        "file exercises the LIVE tool — fix the declaration or delete these tests, don't cast past it.",
    );
  }
  return tool;
}

/**
 * `commercial_who_to_contact`: a READ-ONLY, UNGATED tool over `lib/commercial/`
 * (surface, junk, score, icp) plus the `commercial` entry in `integrations/` for wiring.
 *
 * Layers:
 *   1. `lib/commercial/surface.ts` — pure/offline (ranking, junk filtering, doNotContact,
 *      per-brand ICP, in-pipeline annotation) PLUS the per-source-degrade contract this
 *      port adds: a genuine Twenty failure (`listPeople`/`getCompanyForPerson`) propagates out
 *      of `surfaceCommercial`; an LLM failure degrades only that one contact.
 *   2. `lib/commercial/junk.ts` / `score.ts` — spot-checked directly.
 *   3. `lib/commercial/icp.ts` — real tmp-dir ATLAS_PATH round trip.
 *   4. `lib/twenty-people.ts`'s `listPeopleCapped` — against a REAL local HTTP server (paging,
 *      cap, and TwentyUnavailableError propagation on connection refused).
 *   5. `agent/tools/commercial_who_to_contact.ts` — the live wiring end to end, against real
 *      local HTTP servers for Twenty AND the gateway, proving `getCompanyForPerson`/`think`
 *      actually connect, plus the brand-filter argument and unset-gateway-URL skip.
 */

function person(overrides: Partial<TwentyPerson> = {}): TwentyPerson {
  return {
    id: "p1",
    name: "Warm Co",
    email: "a@x.no",
    companyName: null,
    strength: "VERY_STRONG",
    lastContactedAt: "2026-06-01T00:00:00Z",
    brand: "alpha",
    commState: null,
    doNotContact: false,
    companyId: "c1",
    source: null,
    hasLinkedin: false,
    hasPhone: false,
    ...overrides,
  };
}

// ─── 1. surfaceCommercial — pure/offline ───────────────────────────────────────────────────

describe("surfaceCommercial", () => {
  const NOW = new Date("2026-06-29T00:00:00Z");

  it("ranks warm in-brand contacts, drops doNotContact and floor-failers", async () => {
    const people: TwentyPerson[] = [
      person({ id: "p1", name: "Warm" }),
      person({ id: "p2", name: "DNC", doNotContact: true }),
      person({ id: "p3", name: "Cold Old", strength: "VERY_WEAK", lastContactedAt: "2024-01-01T00:00:00Z" }),
    ];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "Nordic SaaS 10-200 emp",
      think: async () => "70|fits the profile well",
      brands: ["alpha"],
      now: NOW,
    }, "subset");
    const ids = out["alpha"]!.map((c) => c.id);
    expect(ids).toContain("p1");
    expect(ids).not.toContain("p2");
    expect(ids).not.toContain("p3");
  });

  it("excludes junk contacts pre-scoring and keeps real people", async () => {
    const people: TwentyPerson[] = [
      person({ id: "junk1", name: "Reservation", email: "reservation@hotel-booking.no", source: "EMAIL" }),
      person({ id: "real1", name: "Anders Lie", email: "anders@acme.no", source: "MANUAL", hasLinkedin: true }),
    ];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "Nordic SaaS",
      think: async () => "80|strong fit",
      brands: ["alpha"],
      now: NOW,
    }, "subset");
    const ids = out["alpha"]!.map((c) => c.id);
    expect(ids).not.toContain("junk1");
    expect(ids).toContain("real1");
  });

  it("a warm contact fitting two brand ICPs surfaces under BOTH brands (no brand hard-filter)", async () => {
    const people: TwentyPerson[] = [person({ id: "p1", brand: null })];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async (brand) => `${brand} ICP text`,
      think: async () => "80|fits well",
      brands: ["alpha", "beta"],
      now: NOW,
    }, "subset");
    expect(out["alpha"]!.map((c) => c.id)).toContain("p1");
    expect(out["beta"]!.map((c) => c.id)).toContain("p1");
  });

  it("annotates in-pipeline contacts (case-insensitive brand match) and boosts their score", async () => {
    const people: TwentyPerson[] = [person({ id: "p1", strength: "GOOD", brand: null })];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "ICP",
      think: async () => "60|ok",
      opportunitiesForPerson: async () => [{ brand: "ALPHA" }],
      brands: ["alpha"],
      now: NOW,
    }, "subset");
    const c = out["alpha"]!.find((x) => x.id === "p1");
    expect(c?.inPipeline).toBe(true);
    expect(c?.reason).toMatch(/pipeline/i);
  });

  it("malformed think response — icpFit is null, contact still scores on other signals, no throw", async () => {
    const people: TwentyPerson[] = [person({ id: "p1" })];
    const result = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "Nordic SaaS",
      think: async () => "not a number",
      brands: ["alpha"],
      now: NOW,
    }, "subset");
    expect(result["alpha"]!.map((c) => c.id)).toContain("p1");
  });

  // ──: per-source degrade ────────────────────────────────────────────────────────

  it(": a listPeople failure propagates out of surfaceCommercial (not swallowed)", async () => {
    await expect(
      surfaceCommercial({
        listPeople: async () => { throw new TwentyUnavailableError("Twenty is down"); },
        icpFor: async () => "ICP",
        think: async () => "70|ok",
        brands: ["alpha"],
        now: NOW,
      }, "subset"),
    ).rejects.toThrow(TwentyUnavailableError);
  });

  it(": a getCompanyForPerson failure propagates out of surfaceCommercial (not swallowed)", async () => {
    const people: TwentyPerson[] = [person({ id: "p1", companyName: null })];
    await expect(
      surfaceCommercial({
        listPeople: async () => people,
        icpFor: async () => "ICP",
        think: async () => "70|ok",
        getCompanyForPerson: async () => { throw new TwentyUnavailableError("Twenty is down"); },
        brands: ["alpha"],
        now: NOW,
      }, "subset"),
    ).rejects.toThrow(TwentyUnavailableError);
  });

  it(": an opportunitiesForPerson failure does NOT propagate — inPipeline just stays false", async () => {
    const people: TwentyPerson[] = [person({ id: "p1" })];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "ICP",
      think: async () => "70|ok",
      opportunitiesForPerson: async () => { throw new Error("boom"); },
      brands: ["alpha"],
      now: NOW,
    }, "subset");
    const c = out["alpha"]!.find((x) => x.id === "p1");
    expect(c).toBeDefined();
    expect(c?.inPipeline).toBeFalsy();
  });
});

// ─── 2. junk.ts / score.ts — direct spot checks ────────────────────────────────────────────

describe("isJunkContact", () => {
  it("flags an auto-synced booking-style record with a junky email as junk", () => {
    expect(isJunkContact({
      name: "Reservation", email: "reservation@hotel-booking.no", source: "EMAIL", hasLinkedin: false, hasPhone: false,
    })).toBe(true);
  });

  it("never flags a curated record (has phone) even with a generic-looking name/email", () => {
    expect(isJunkContact({
      name: "Info Andersen", email: "info@acme.no", source: "EMAIL", hasLinkedin: false, hasPhone: true,
    })).toBe(false);
  });

  it("does not flag a MANUAL record with a normal email", () => {
    expect(isJunkContact({
      name: "Anders Lie", email: "anders@acme.no", source: "MANUAL", hasLinkedin: false, hasPhone: false,
    })).toBe(false);
  });
});

describe("scoreContact", () => {
  it("passes the floor on warmth alone and reports it as the reason", () => {
    const { passesFloor, reason } = scoreContact({ warmth: 90, daysSinceContact: null, icpFit: null });
    expect(passesFloor).toBe(true);
    expect(reason).toMatch(/warm/);
  });

  it("fails the floor when every signal is weak/absent", () => {
    const { passesFloor } = scoreContact({ warmth: 10, daysSinceContact: 400, icpFit: 20 });
    expect(passesFloor).toBe(false);
  });
});

// ─── 3. icp.ts — real tmp-dir ATLAS_PATH round trip ────────────────────────────────────────

describe("icpFor", () => {
  let atlasDir: string;

  beforeEach(() => {
    atlasDir = mkdtempSync(join(tmpdir(), "lares-atlas-"));
    mkdirSync(join(atlasDir, "icp"), { recursive: true });
    writeFileSync(join(atlasDir, "icp", "alpha.md"), "# Alpha ICP\nNordic SaaS, 10-200 employees.\n");
    process.env["ATLAS_PATH"] = atlasDir;
  });

  afterEach(() => {
    delete process.env["ATLAS_PATH"];
    rmSync(atlasDir, { recursive: true, force: true });
  });

  it("reads the markdown for a configured brand", async () => {
    const text = await icpFor("alpha");
    expect(text).toContain("Nordic SaaS");
  });

  it("returns null for a brand with no ICP file (not an error)", async () => {
    await expect(icpFor("gamma")).resolves.toBeNull();
  });

  it("returns null for a malformed brand name (path-shaped input)", async () => {
    await expect(icpFor("../../etc/passwd")).resolves.toBeNull();
    await expect(icpFor("alpha/../../../etc")).resolves.toBeNull();
  });

  it("returns null when ATLAS_PATH is unset, rather than throwing", async () => {
    delete process.env["ATLAS_PATH"];
    await expect(icpFor("alpha")).resolves.toBeNull();
  });
});

// ─── 4. listPeopleCapped — real local HTTP server ──────────────────────────────────────────

let server: Server | undefined;
let keyDir: string;

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), "twenty-key-"));
  writeFileSync(join(keyDir, "twenty-key"), "test-api-key\n");
  process.env["TWENTY_KEY_FILE"] = join(keyDir, "twenty-key");
});

afterEach(async () => {
  delete process.env["TWENTY_BASE_URL"];
  delete process.env["TWENTY_KEY_FILE"];
  rmSync(keyDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("listPeopleCapped", () => {
  it("pages via starting_after until hasNextPage is false", async () => {
    const pages = [
      { data: { people: [{ id: "a", name: { firstName: "A", lastName: "" }, emails: { primaryEmail: "a@x.no" } }] }, pageInfo: { hasNextPage: true, endCursor: "cursor-1" } },
      { data: { people: [{ id: "b", name: { firstName: "B", lastName: "" }, emails: { primaryEmail: "b@x.no" } }] }, pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    let call = 0;
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pages[call] ?? pages[pages.length - 1]));
      call++;
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    const out = await listPeopleCapped({ pageSize: 1 });
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
    expect(call).toBe(2);
  });

  it("stops paging once the cap is reached, even if hasNextPage is still true", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: { people: [{ id: `x-${Math.random()}`, name: { firstName: "X", lastName: "" }, emails: { primaryEmail: null } }] },
        pageInfo: { hasNextPage: true, endCursor: "always-more" },
      }));
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    const out = await listPeopleCapped({ cap: 3, pageSize: 1 });
    expect(out.length).toBe(3);
  });

  it("propagates TwentyUnavailableError when the connection is refused", async () => {
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    await expect(listPeopleCapped()).rejects.toThrow(TwentyUnavailableError);
  });
});

// ─── 5. commercial_who_to_contact — live wiring, real local HTTP servers ───────────────────

const READ_CTX = {} as never;

describe("commercial_who_to_contact (live wiring)", () => {
  let atlasDir: string;
  let gatewayKeyDir: string;
  let twentyServer: Server | undefined;
  let gatewayServer: Server | undefined;

  beforeEach(() => {
    atlasDir = mkdtempSync(join(tmpdir(), "lares-atlas-tool-"));
    mkdirSync(join(atlasDir, "icp"), { recursive: true });
    writeFileSync(join(atlasDir, "icp", "alpha.md"), "Nordic SaaS ICP for alpha.\n");
    process.env["ATLAS_PATH"] = atlasDir;

    gatewayKeyDir = mkdtempSync(join(tmpdir(), "gateway-key-"));
    writeFileSync(join(gatewayKeyDir, "gateway-key"), "test-gateway-key\n");
    process.env["GATEWAY_KEY_FILE"] = join(gatewayKeyDir, "gateway-key");

  });

  afterEach(async () => {
    delete process.env["ATLAS_PATH"];
    delete process.env["GATEWAY_KEY_FILE"];
    delete process.env["GATEWAY_URL"];
    delete process.env["TWENTY_BASE_URL"];
    delete process.env["TWENTY_KEY_FILE"];
    delete process.env["COMMERCIAL_BRANDS"];
    delete process.env["COMMERCIAL_MODEL"];
    rmSync(atlasDir, { recursive: true, force: true });
    rmSync(gatewayKeyDir, { recursive: true, force: true });
    for (const s of [twentyServer, gatewayServer]) {
      if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    twentyServer = undefined;
    gatewayServer = undefined;
  });

  /** A minimal Twenty stub: one page of people (one warm alpha contact, one company lookup
   *  hit for it) — enough to prove listPeopleCapped + getCompanyForPerson both wire through. */
  async function startTwenty(): Promise<number> {
    return new Promise((resolve) => {
      twentyServer = createServer((req, res) => {
        const url = req.url ?? "";
        if (url.startsWith("/rest/people?")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            data: {
              people: [{
                id: "p1",
                name: { firstName: "Warm", lastName: "Contact" },
                emails: { primaryEmail: "warm@acme.no" },
                companyId: "c1",
                strength: "VERY_STRONG",
                lastContactedAt: "2026-06-01T00:00:00Z",
                brand: "alpha",
                doNotContact: false,
                createdBy: { source: "MANUAL" },
              }],
            },
            pageInfo: { hasNextPage: false, endCursor: null },
          }));
          return;
        }
        if (url.startsWith("/rest/people/p1")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { person: { id: "p1", companyId: "c1", name: { firstName: "Warm", lastName: "Contact" } } } }));
          return;
        }
        if (url.startsWith("/rest/companies/c1")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { company: { id: "c1", name: "Acme AS" } } }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not stubbed" }));
      });
      twentyServer.listen(0, "127.0.0.1", () => resolve((twentyServer!.address() as AddressInfo).port));
    });
  }

  /** A minimal Anthropic-Messages-shaped gateway stub for `generateText`. */
  async function startGateway(): Promise<number> {
    return new Promise((resolve) => {
      gatewayServer = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_test", type: "message", role: "assistant", model: "claude-test",
            content: [{ type: "text", text: "85|great ICP fit" }],
            stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
          }));
        });
      });
      gatewayServer.listen(0, "127.0.0.1", () => resolve((gatewayServer!.address() as AddressInfo).port));
    });
  }

  it("returns a scored contact via the full live wiring (Twenty + ICP file + gateway)", async () => {
    const twentyPort = await startTwenty();
    const gatewayPort = await startGateway();
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${twentyPort}`;
    process.env["TWENTY_KEY_FILE"] = join(mkdtempSync(join(tmpdir(), "twenty-key-tool-")), "twenty-key");
    writeFileSync(process.env["TWENTY_KEY_FILE"]!, "test-key\n");
    process.env["GATEWAY_URL"] = `http://127.0.0.1:${gatewayPort}`;
    process.env["COMMERCIAL_MODEL"] = "claude-test-model";
    process.env["COMMERCIAL_BRANDS"] = '["alpha"]';

    const tool = await freshCommercialTool();
    const result = await tool.execute({}, READ_CTX);
    expect(result["alpha"]).toBeDefined();
    expect(result["alpha"]!.map((c) => c.id)).toContain("p1");
  });

  it("filters to a single brand when the brand argument is given", async () => {
    const twentyPort = await startTwenty();
    const gatewayPort = await startGateway();
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${twentyPort}`;
    const tKeyDir = mkdtempSync(join(tmpdir(), "twenty-key-tool2-"));
    writeFileSync(join(tKeyDir, "twenty-key"), "test-key\n");
    process.env["TWENTY_KEY_FILE"] = join(tKeyDir, "twenty-key");
    process.env["GATEWAY_URL"] = `http://127.0.0.1:${gatewayPort}`;
    process.env["COMMERCIAL_MODEL"] = "claude-test-model";
    process.env["COMMERCIAL_BRANDS"] = '["alpha","beta"]';
    mkdirSync(join(atlasDir, "icp"), { recursive: true });
    writeFileSync(join(atlasDir, "icp", "beta.md"), "Nordic B2B ICP for beta.\n");

    const tool = await freshCommercialTool();
    const result = await tool.execute({ brand: "beta" }, READ_CTX);
    expect(Object.keys(result)).toEqual(["beta"]);

    const unknown = await tool.execute({ brand: "nonexistent" }, READ_CTX);
    expect(unknown).toEqual({});
  });

  it("propagates a genuine Twenty failure out of the tool", async () => {
    // Bind to get a free port, then close it — nothing listens there, so the connection is
    // genuinely refused (matching tests/twenty-client.test.ts's own pattern).
    const probe = createServer((_req, res) => res.end());
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => resolve((probe.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;
    const tKeyDir = mkdtempSync(join(tmpdir(), "twenty-key-tool3-"));
    writeFileSync(join(tKeyDir, "twenty-key"), "test-key\n");
    process.env["TWENTY_KEY_FILE"] = join(tKeyDir, "twenty-key");
    process.env["COMMERCIAL_BRANDS"] = '["alpha"]';

    // `freshCommercialTool()` re-imports `lib/twenty-client.ts` through a reset module
    // registry, so the thrown error is a DIFFERENT `TwentyUnavailableError` class instance
    // than the one imported statically at this file's top — assert by name/message instead
    // of `instanceof` (same reasoning as the fresh-module pattern above).
    const tool = await freshCommercialTool();
    await expect(tool.execute({}, READ_CTX)).rejects.toMatchObject({ name: "TwentyUnavailableError" });
  });
});

// ─── 6. commercial_who_to_contact — where the tool exists ──────────────────────────────────
//
// eve 1.0 calls the tool file's function before every model call, and what it returns is whether
// the tool EXISTS in that conversation. `resolveSkillTool` decides it from the conversation's
// LOADED definition (the mounted definition folder, or this service's own agent.json when none
// is mounted), never from the file built into the image. A private console conversation never
// has it.

describe("commercial_who_to_contact (where it exists)", () => {
  const AGENT = "chief-of-staff";
  const consoleMember = {
    authenticator: "lares-console", principalType: "user", principalId: "member-one",
    attributes: { lares_member_id: "member-one", lares_admission_nonce: "a".repeat(43), lares_purpose: "human" },
  };
  const privateConversation = () => conversation({ current: consoleMember, initiator: consoleMember });

  type Declaration = { grants: { capability: string }[]; autonomy: Record<string, string>; skills: { name: string; requires?: unknown[] }[] } & Record<string, unknown>;
  let neutral: Declaration;
  let dir: string | undefined;
  /** Mount a definition folder holding `agentJson` (an object, or raw text for a broken file). */
  function mount(agentJson: unknown): void {
    dir ??= mkdtempSync(join(tmpdir(), "commercial-definition-"));
    writeFileSync(join(dir, "agent.json"), typeof agentJson === "string" ? agentJson : JSON.stringify(agentJson));
    writeFileSync(join(dir, "voice.md"), "Plain and brief.\n");
    writeFileSync(join(dir, "duties.md"), "");
    vi.stubEnv("LARES_DEFINITION_DIR", dir);
  }
  const withoutCommercial = () => ({ ...neutral, skills: neutral.skills.filter((k) => k.name !== "commercial") });
  const twentyNever = () => ({ ...neutral, autonomy: { ...neutral.autonomy, twenty: "never" } });
  const twentyRevoked = () => ({
    ...neutral,
    grants: neutral.grants.filter((g) => g.capability !== "twenty"),
    autonomy: Object.fromEntries(Object.entries(neutral.autonomy).filter(([k]) => k !== "twenty")),
    skills: neutral.skills.filter((k) => k.name !== "commercial"),
  });

  beforeEach(async () => {
    // A fresh module registry per case: `thisAgent` pins a definition per session in-process.
    vi.resetModules();
    neutral = structuredClone((await vi.importActual<{ default: Declaration }>("../agent.json")).default);
    vi.stubEnv("LARES_AGENT_NAME", AGENT);
    vi.stubEnv("LARES_AGENT_INCARNATION", "11111111-1111-4111-8111-111111111111");
    consoleBinding.mockResolvedValue({});
    definitionStore.remembered.clear();
    definitionStore.reads = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    consoleBinding.mockReset();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("exists in an ordinary conversation under this service's own declaration", async () => {
    const tool = await (await commercialResolver())(ordinaryConversation());
    expect(typeof tool?.execute).toBe("function");
  });

  it("exists under a mounted definition that declares the skill inside its grants", async () => {
    mount(neutral);
    const tool = await (await commercialResolver())(ordinaryConversation());
    expect(typeof tool?.execute).toBe("function");
  });

  it("does not exist in a private console conversation, and does not read the definition to say so", async () => {
    mount(neutral);
    const c = privateConversation();
    expect(await (await commercialResolver())(c)).toBeNull();
    expect(consoleBinding).toHaveBeenCalledOnce();
    expect(definitionStore.reads).toBe(0);
    expect(c.kept.size).toBe(0);
  });

  it("refuses the turn for a caller who claims a private console conversation but is not verified", async () => {
    mount(neutral);
    const resolve = await commercialResolver();
    consoleBinding.mockRejectedValue(new Error("refused"));
    await expect(resolve(privateConversation())).rejects.toThrow();
    // A different person speaking than the one who opened the conversation.
    const other = { ...consoleMember, principalId: "member-two", attributes: { ...consoleMember.attributes, lares_member_id: "member-two" } };
    await expect(resolve(conversation({ current: other, initiator: consoleMember }))).rejects.toThrow();
    expect(definitionStore.reads).toBe(0);
  });

  // The case this decision exists for. The file built into the image always declares
  // `commercial`; what counts is the definition the installation mounted.
  it("does not exist when the mounted definition does not list the commercial skill", async () => {
    mount(withoutCommercial());
    expect(await (await commercialResolver())(ordinaryConversation())).toBeNull();
  });

  it("does not exist when the mounted definition switches twenty off with never", async () => {
    mount(twentyNever());
    expect(await (await commercialResolver())(ordinaryConversation())).toBeNull();
  });

  it("does not exist when the mounted definition revokes the twenty grant", async () => {
    mount(twentyRevoked());
    expect(await (await commercialResolver())(ordinaryConversation())).toBeNull();
  });

  it("reads the definition once per conversation and keeps only the yes/no", async () => {
    mount(neutral);
    const resolve = await commercialResolver();
    const c = ordinaryConversation();
    for (let call = 0; call < 5; call += 1) expect(typeof (await resolve(c))?.execute).toBe("function");
    expect(definitionStore.reads).toBe(1);
    expect([...c.kept.values()]).toEqual(["true"]);
  });

  it("a definition that drops the skill: absent in the next conversation, unchanged in this one", async () => {
    mount(neutral);
    const resolve = await commercialResolver();
    const first = ordinaryConversation();
    expect(typeof (await resolve(first))?.execute).toBe("function");

    mount(withoutCommercial());
    expect(await resolve(ordinaryConversation())).toBeNull();
    // The conversation already under way keeps the answer it started with (ADR-0015).
    expect(typeof (await resolve(first))?.execute).toBe("function");
  });

  describe("an invalid or unreadable definition fails closed", () => {
    const broken = (): Record<string, unknown> => ({
      "is not JSON": "{ this is not json",
      "has a misspelled field": { ...neutral, skill: [] },
      "has a skill that asks for more than its grant (never widen)": { ...neutral, skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "write" }] }] },
      "declares a different agent": { ...neutral, name: "someone-else" },
    });
    const reasons = ["is not JSON", "has a misspelled field", "has a skill that asks for more than its grant (never widen)", "declares a different agent"];

    for (const why of reasons) {
      it(`with no last valid definition, when agent.json ${why}: the tool is absent and nothing throws`, async () => {
        mount(broken()[why]);
        const resolve = await commercialResolver();
        const c = ordinaryConversation();
        expect(await resolve(c)).toBeNull();
        // The failure is not kept: a repaired definition is picked up by the next model call.
        expect(c.kept.size).toBe(0);
        mount(neutral);
        expect(typeof (await resolve(c))?.execute).toBe("function");
      });

      it(`with a last valid definition that did not allow the skill, when agent.json ${why}: still absent`, async () => {
        mount(withoutCommercial());
        const resolve = await commercialResolver();
        expect(await resolve(ordinaryConversation())).toBeNull();
        expect(definitionStore.remembered.has(AGENT)).toBe(true);
        // The broken edit cannot bring the tool back; the agent keeps its last valid definition.
        mount(broken()[why]);
        expect(await resolve(ordinaryConversation())).toBeNull();
      });
    }

    it("when the framework's memo fails: the tool is absent", async () => {
      mount(neutral);
      const c = ordinaryConversation();
      c.memo = async () => { throw new Error("memo unavailable"); };
      expect(await (await commercialResolver())(c)).toBeNull();
    });

    it("when the memo hands back anything but an exact true: the tool is absent", async () => {
      mount(neutral);
      const resolve = await commercialResolver();
      for (const kept of ["true", 1, { offered: true }, null]) {
        const c = ordinaryConversation();
        c.memo = (async () => kept) as never;
        expect(await resolve(c), JSON.stringify(kept)).toBeNull();
      }
    });
  });
});
