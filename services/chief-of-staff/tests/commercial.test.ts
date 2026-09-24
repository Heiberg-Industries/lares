import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { isDisabledToolSentinel, type DisabledToolSentinel } from "eve/tools";

import { surfaceCommercial, type SurfaceDeps } from "../lib/commercial/surface.js";
import { isJunkContact } from "../lib/commercial/junk.js";
import { scoreContact } from "../lib/commercial/score.js";
import { icpFor } from "../lib/commercial/icp.js";
import { listPeopleCapped, type TwentyPerson } from "../lib/twenty-people.js";
import { TwentyUnavailableError } from "../lib/twenty-client.js";
import type commercialWhoToContactType from "../agent/tools/commercial_who_to_contact.js";

// `gatewayModel` (lib/gateway-provider.ts) caches its providers at MODULE scope — the same
// reason tests/gateway-provider.test.ts needs a fresh module per test. commercial_who_to_contact
// transitively imports it via lib/llm-complete.ts, so each "live wiring" test below needs its
// own fresh import too, or a later test's GATEWAY_URL would silently keep talking to an
// earlier test's already-closed gateway server.
//
// Task 3 (ORB-145 Phase 1) wrapped the tool's default export in `resolveSkillTool`, whose
// return type is `Tool | DisabledToolSentinel` — the same union `resolveExtensionTool` has
// always returned (see agent-declaration.test.ts's own `as { approval?: unknown }` casts over
// EXTENSION_TOOLS). Every test below calls `.execute()` directly, which the sentinel branch
// has no such method. Saga's grants make the skill resolve live (never a sentinel) today,
// exactly as this file's live wiring tests assume.
//
// ORB-210 item 5: the cast alone used to be the whole story, and a cast is a claim about a
// value, not a check on one. Drop the `twenty` or `orakel` grant from agent.json and the tool
// resolves to a sentinel — every test below would then fail on "tool.execute is not a function",
// a stack trace about a missing method rather than the actual cause. `isDisabledToolSentinel` is
// eve's own runtime discriminator, and one line of it turns that into a sentence naming the
// declaration to fix.
async function freshCommercialTool(): Promise<Exclude<typeof commercialWhoToContactType, DisabledToolSentinel>> {
  vi.resetModules();
  const tool = (await import("../agent/tools/commercial_who_to_contact.js")).default;
  if (isDisabledToolSentinel(tool)) {
    throw new Error(
      "commercial_who_to_contact resolved to a disabled-tool sentinel: agent.json no longer grants " +
        "the `commercial` skill what it requires (twenty:read + orakel:read). Every test in this " +
        "file exercises the LIVE tool — fix the declaration or delete these tests, don't cast past it.",
    );
  }
  return tool;
}

/**
 * Task 13, Part 1 — `commercial_who_to_contact`: a faithful, READ-ONLY, UNGATED port of
 * `services/agent-runtime/lib/commercial/{surface,junk,score,icp}.ts` +
 * `lib/adapters/hands/commercial.ts` + the `commercial` entry in `integrations/` for wiring.
 *
 * Layers:
 *   1. `lib/commercial/surface.ts` — pure/offline (ranking, junk filtering, doNotContact,
 *      per-brand ICP, in-pipeline annotation) PLUS the ORB-51 per-source-degrade contract this
 *      port adds: a genuine Twenty failure (`listPeople`/`getCompanyForPerson`) propagates out
 *      of `surfaceCommercial`; an Orakel/LLM failure degrades only that one contact.
 *   2. `lib/commercial/junk.ts` / `score.ts` — spot-checked directly.
 *   3. `lib/commercial/icp.ts` — real tmp-dir ATLAS_PATH round trip.
 *   4. `lib/twenty-people.ts`'s `listPeopleCapped` — against a REAL local HTTP server (paging,
 *      cap, and TwentyUnavailableError propagation on connection refused).
 *   5. `agent/tools/commercial_who_to_contact.ts` — the live wiring end to end, against real
 *      local HTTP servers for Twenty AND the gateway, proving `getCompanyForPerson`/`think`
 *      actually connect, plus the brand-filter argument and ORAKEL_URL-unset skip.
 */

function person(overrides: Partial<TwentyPerson> = {}): TwentyPerson {
  return {
    id: "p1",
    name: "Warm Co",
    email: "a@x.no",
    companyName: null,
    strength: "VERY_STRONG",
    lastContactedAt: "2026-06-01T00:00:00Z",
    brand: "zero7",
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
      brands: ["zero7"],
      now: NOW,
    }, "subset");
    const ids = out["zero7"]!.map((c) => c.id);
    expect(ids).toContain("p1");
    expect(ids).not.toContain("p2");
    expect(ids).not.toContain("p3");
  });

  it("excludes junk contacts pre-scoring and keeps real people", async () => {
    const people: TwentyPerson[] = [
      person({ id: "junk1", name: "Reservation", email: "reservation@hotel-booking.no", source: "EMAIL" }),
      person({ id: "real1", name: "Anders Hofstad", email: "anders@acme.no", source: "MANUAL", hasLinkedin: true }),
    ];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "Nordic SaaS",
      think: async () => "80|strong fit",
      brands: ["zero7"],
      now: NOW,
    }, "subset");
    const ids = out["zero7"]!.map((c) => c.id);
    expect(ids).not.toContain("junk1");
    expect(ids).toContain("real1");
  });

  it("a warm contact fitting two brand ICPs surfaces under BOTH brands (no brand hard-filter)", async () => {
    const people: TwentyPerson[] = [person({ id: "p1", brand: null })];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async (brand) => `${brand} ICP text`,
      think: async () => "80|fits well",
      brands: ["zero7", "orakel"],
      now: NOW,
    }, "subset");
    expect(out["zero7"]!.map((c) => c.id)).toContain("p1");
    expect(out["orakel"]!.map((c) => c.id)).toContain("p1");
  });

  it("annotates in-pipeline contacts (case-insensitive brand match) and boosts their score", async () => {
    const people: TwentyPerson[] = [person({ id: "p1", strength: "GOOD", brand: null })];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "ICP",
      think: async () => "60|ok",
      opportunitiesForPerson: async () => [{ brand: "ZERO7" }],
      brands: ["zero7"],
      now: NOW,
    }, "subset");
    const c = out["zero7"]!.find((x) => x.id === "p1");
    expect(c?.inPipeline).toBe(true);
    expect(c?.reason).toMatch(/pipeline/i);
  });

  it("malformed think response — icpFit is null, contact still scores on other signals, no throw", async () => {
    const people: TwentyPerson[] = [person({ id: "p1" })];
    const result = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "Nordic SaaS",
      think: async () => "not a number",
      brands: ["zero7"],
      now: NOW,
    }, "subset");
    expect(result["zero7"]!.map((c) => c.id)).toContain("p1");
  });

  // ── ORB-51: per-source degrade ────────────────────────────────────────────────────────

  it("ORB-51: a listPeople failure propagates out of surfaceCommercial (not swallowed)", async () => {
    await expect(
      surfaceCommercial({
        listPeople: async () => { throw new TwentyUnavailableError("Twenty is down"); },
        icpFor: async () => "ICP",
        think: async () => "70|ok",
        brands: ["zero7"],
        now: NOW,
      }, "subset"),
    ).rejects.toThrow(TwentyUnavailableError);
  });

  it("ORB-51: a getCompanyForPerson failure propagates out of surfaceCommercial (not swallowed)", async () => {
    const people: TwentyPerson[] = [person({ id: "p1", companyName: null })];
    await expect(
      surfaceCommercial({
        listPeople: async () => people,
        icpFor: async () => "ICP",
        think: async () => "70|ok",
        getCompanyForPerson: async () => { throw new TwentyUnavailableError("Twenty is down"); },
        brands: ["zero7"],
        now: NOW,
      }, "subset"),
    ).rejects.toThrow(TwentyUnavailableError);
  });

  it("ORB-51: an orakelEnrich failure does NOT propagate — degrades to no enrichment, contact still scores", async () => {
    const people: TwentyPerson[] = [person({ id: "p1", companyName: "Acme" })];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "Nordic SaaS",
      think: async () => "80|strong fit",
      orakelEnrich: async () => { throw new Error("Orakel is unreachable"); },
      brands: ["zero7"],
      now: NOW,
    }, "subset");
    expect(out["zero7"]!.map((c) => c.id)).toContain("p1");
  });

  it("ORB-51: an opportunitiesForPerson failure does NOT propagate — inPipeline just stays false", async () => {
    const people: TwentyPerson[] = [person({ id: "p1" })];
    const out = await surfaceCommercial({
      listPeople: async () => people,
      icpFor: async () => "ICP",
      think: async () => "70|ok",
      opportunitiesForPerson: async () => { throw new Error("boom"); },
      brands: ["zero7"],
      now: NOW,
    }, "subset");
    const c = out["zero7"]!.find((x) => x.id === "p1");
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
      name: "Anders Hofstad", email: "anders@acme.no", source: "MANUAL", hasLinkedin: false, hasPhone: false,
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
    atlasDir = mkdtempSync(join(tmpdir(), "eve-saga-atlas-"));
    mkdirSync(join(atlasDir, "icp"), { recursive: true });
    writeFileSync(join(atlasDir, "icp", "zero7.md"), "# Zero7 ICP\nNordic SaaS, 10-200 employees.\n");
    process.env["ATLAS_PATH"] = atlasDir;
  });

  afterEach(() => {
    delete process.env["ATLAS_PATH"];
    rmSync(atlasDir, { recursive: true, force: true });
  });

  it("reads the markdown for a configured brand", async () => {
    const text = await icpFor("zero7");
    expect(text).toContain("Nordic SaaS");
  });

  it("returns null for a brand with no ICP file (not an error)", async () => {
    await expect(icpFor("murmur")).resolves.toBeNull();
  });

  it("returns null for a malformed brand name (path-shaped input)", async () => {
    await expect(icpFor("../../etc/passwd")).resolves.toBeNull();
    await expect(icpFor("zero7/../../../etc")).resolves.toBeNull();
  });

  it("returns null when ATLAS_PATH is unset, rather than throwing", async () => {
    delete process.env["ATLAS_PATH"];
    await expect(icpFor("zero7")).resolves.toBeNull();
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

  it("propagates TwentyUnavailableError when the connection is refused (ORB-51)", async () => {
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
    atlasDir = mkdtempSync(join(tmpdir(), "eve-saga-atlas-tool-"));
    mkdirSync(join(atlasDir, "icp"), { recursive: true });
    writeFileSync(join(atlasDir, "icp", "zero7.md"), "Nordic SaaS ICP for zero7.\n");
    process.env["ATLAS_PATH"] = atlasDir;

    gatewayKeyDir = mkdtempSync(join(tmpdir(), "gateway-key-"));
    writeFileSync(join(gatewayKeyDir, "gateway-key"), "test-gateway-key\n");
    process.env["GATEWAY_KEY_FILE"] = join(gatewayKeyDir, "gateway-key");

    delete process.env["ORAKEL_URL"];
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

  /** A minimal Twenty stub: one page of people (one warm zero7 contact, one company lookup
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
                brand: "zero7",
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
    process.env["COMMERCIAL_BRANDS"] = '["zero7"]';

    const tool = await freshCommercialTool();
    const result = await tool.execute({}, READ_CTX);
    expect(result["zero7"]).toBeDefined();
    expect(result["zero7"]!.map((c) => c.id)).toContain("p1");
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
    process.env["COMMERCIAL_BRANDS"] = '["zero7","orakel"]';
    mkdirSync(join(atlasDir, "icp"), { recursive: true });
    writeFileSync(join(atlasDir, "icp", "orakel.md"), "Nordic B2B ICP for orakel.\n");

    const tool = await freshCommercialTool();
    const result = await tool.execute({ brand: "orakel" }, READ_CTX);
    expect(Object.keys(result)).toEqual(["orakel"]);

    const unknown = await tool.execute({ brand: "nonexistent" }, READ_CTX);
    expect(unknown).toEqual({});
  });

  it("propagates a genuine Twenty failure out of the tool (ORB-51)", async () => {
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
    process.env["COMMERCIAL_BRANDS"] = '["zero7"]';

    // `freshCommercialTool()` re-imports `lib/twenty-client.ts` through a reset module
    // registry, so the thrown error is a DIFFERENT `TwentyUnavailableError` class instance
    // than the one imported statically at this file's top — assert by name/message instead
    // of `instanceof` (same reasoning as `tests/gateway-provider.test.ts`'s own
    // fresh-module pattern).
    const tool = await freshCommercialTool();
    await expect(tool.execute({}, READ_CTX)).rejects.toMatchObject({ name: "TwentyUnavailableError" });
  });
});
