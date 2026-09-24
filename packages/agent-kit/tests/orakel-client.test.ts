// Unit coverage for the ported logic in ../extension/lib/orakel-client.ts — the client's
// normalisation, error classification, and getJson/domainMatches behaviour, exercised
// through makeOrakelClient() with a plain injected config resolver (no eve extension-config
// machinery involved; see that file's header for why the seam exists). Deliberately mirrors
// services/chief-of-staff/tests/orakel-client.test.ts's fixtures and cases — same logic, same
// expected behaviour, config-injected instead of env-injected.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { makeOrakelClient, OrakelNotFoundError, OrakelUnavailableError } from "../extension/lib/orakel-client.js";

/** A realistic Orakel /api/companies/{orgNumber} flat object (subset of the real fields —
 *  same fixture as services/chief-of-staff/tests/orakel-client.test.ts). */
const ledidi = {
  orgNumber: "917137137",
  name: "Ledidi AS",
  country: "NO",
  website: "https://ledidi.com",
  primaryDomain: "ledidi.com",
  enrichedDomains: ["ledidi.com"],
  employeeCount: 34,
  foundingDate: "2016-03-21",
  naceCode1: "62.010",
  naceName: "Programmeringstjenester",
  technologies: [{ name: "Next.js" }, "AWS"],
  linkedinHandle: "ledidi",
};

let server: Server | undefined;
let keyDir: string;
let keyFile: string;
let baseUrl: string | undefined;

function listen(routes: Record<string, { status: number; body: unknown }>): Promise<number> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const hit = req.url ? routes[req.url] : undefined;
    if (!hit) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route stubbed for ${req.url}` }));
      return;
    }
    res.writeHead(hit.status, { "content-type": "application/json" });
    res.end(JSON.stringify(hit.body));
  };
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

// The client under test — bound to a resolver that reads the two module-scope `let`s above,
// so each test just sets `baseUrl` (and optionally `keyFile`) before calling in.
const client = makeOrakelClient(() => ({ keyFile, baseUrl }));
const { orakelEnrichOrg, orakelSearch, orakelEnrichDomain } = client;

beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), "orakel-key-"));
  keyFile = join(keyDir, "orakel-key");
  writeFileSync(keyFile, "test-orakel-key\n");
  baseUrl = undefined;
});

afterEach(async () => {
  rmSync(keyDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("orakelEnrichOrg", () => {
  it("looks up by org number and maps the real flat-object fields", async () => {
    const port = await listen({ "/api/companies/917137137": { status: 200, body: ledidi } });
    baseUrl = `http://127.0.0.1:${port}`;

    const c = await orakelEnrichOrg("917137137");

    expect(c).toEqual({
      orgNumber: "917137137",
      name: "Ledidi AS",
      country: "NO",
      website: "https://ledidi.com",
      primaryDomain: "ledidi.com",
      employeeCount: 34,
      foundingDate: "2016-03-21",
      naceCode: "62.010",
      naceDescription: "Programmeringstjenester",
      technologies: ["Next.js", "AWS"],
      linkedinHandle: "ledidi",
      sizeClass: null,
      municipality: null,
      isBankrupt: null,
      isInDebtNegotiation: null,
      latestFinancialYear: null,
      revenue: null,
      operatingResult: null,
      netResult: null,
      financialHealthScore: null,
      revenueCagr: null,
      ownershipConcentrationPct: null,
      isForeignOwned: null,
    });
  });

  it("maps the briefing-grade fields (latest financials + signals) from the detail object", async () => {
    const bigco = {
      orgNumber: "923609016",
      name: "BigCo AS",
      country: "NO",
      sizeClass: "large",
      isBankrupt: false,
      businessAddressMuni: "Oslo",
      financials: [
        { revenue: 50_000_000, operatingResult: 8_000_000, netResult: 6_000_000, periodTo: "2024-12-31" },
        { revenue: 42_000_000, operatingResult: 6_500_000, netResult: 5_000_000, periodTo: "2023-12-31" },
      ],
      signals: { financialHealthScore: 82, revenueCagr: 0.19, ownershipConcentrationPct: 90, isForeignOwned: false },
    };
    const port = await listen({ "/api/companies/923609016": { status: 200, body: bigco } });
    baseUrl = `http://127.0.0.1:${port}`;

    const c = await orakelEnrichOrg("923609016");

    expect(c).toMatchObject({
      orgNumber: "923609016",
      sizeClass: "large",
      municipality: "Oslo",
      isBankrupt: false,
      latestFinancialYear: 2024,
      revenue: 50_000_000,
      financialHealthScore: 82,
      revenueCagr: 0.19,
    });
  });

  it("throws OrakelNotFoundError, not OrakelUnavailableError, on a 404", async () => {
    const port = await listen({ "/api/companies/000000000": { status: 404, body: {} } });
    baseUrl = `http://127.0.0.1:${port}`;

    await expect(orakelEnrichOrg("000000000")).rejects.toThrow(OrakelNotFoundError);
  });

  it("throws OrakelUnavailableError on a non-404 hiccup", async () => {
    const port = await listen({ "/api/companies/917137137": { status: 503, body: { error: "down" } } });
    baseUrl = `http://127.0.0.1:${port}`;

    await expect(orakelEnrichOrg("917137137")).rejects.toThrow(OrakelUnavailableError);
  });

  it("throws OrakelUnavailableError when the connection is refused", async () => {
    const port = await listen({});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    baseUrl = `http://127.0.0.1:${port}`;

    await expect(orakelEnrichOrg("917137137")).rejects.toThrow(OrakelUnavailableError);
  });
});

describe("orakelSearch", () => {
  it("searches by company name and returns lightweight candidates", async () => {
    const port = await listen({
      "/api/companies?q=Ledidi&limit=5": {
        status: 200,
        body: {
          data: [
            { orgNumber: "917137137", name: "Ledidi AS", country: "NO", employeeCount: 34, naceName: "Programmeringstjenester", sizeClass: "small" },
          ],
          nextCursor: null,
          hasMore: false,
        },
      },
    });
    baseUrl = `http://127.0.0.1:${port}`;

    const r = await orakelSearch("Ledidi");

    expect(r).toEqual([
      { orgNumber: "917137137", name: "Ledidi AS", country: "NO", employeeCount: 34, naceName: "Programmeringstjenester", sizeClass: "small" },
    ]);
  });

  it("returns an empty list (not an error) for a search with zero legitimate matches", async () => {
    const port = await listen({
      "/api/companies?q=Nope&limit=5": { status: 200, body: { data: [], nextCursor: null, hasMore: false } },
    });
    baseUrl = `http://127.0.0.1:${port}`;

    expect(await orakelSearch("Nope")).toEqual([]);
  });

  it("throws OrakelUnavailableError on a genuine transport failure", async () => {
    const port = await listen({ "/api/companies?q=Nope&limit=5": { status: 503, body: { error: "down" } } });
    baseUrl = `http://127.0.0.1:${port}`;

    await expect(orakelSearch("Nope")).rejects.toThrow(OrakelUnavailableError);
  });
});

describe("orakelEnrichDomain", () => {
  it("resolves a domain by name-search then confirms the real domain matches", async () => {
    const port = await listen({
      "/api/companies?q=ledidi&limit=5": {
        status: 200,
        body: { data: [{ orgNumber: "917137137", name: "Ledidi AS" }], nextCursor: null, hasMore: false },
      },
      "/api/companies/917137137": { status: 200, body: ledidi },
    });
    baseUrl = `http://127.0.0.1:${port}`;

    const c = await orakelEnrichDomain("https://www.ledidi.com/about");

    expect(c.orgNumber).toBe("917137137");
    expect(c.name).toBe("Ledidi AS");
  });

  it("throws OrakelNotFoundError when no candidate's domain matches", async () => {
    const port = await listen({
      "/api/companies?q=ledidi&limit=5": {
        status: 200,
        body: { data: [{ orgNumber: "111111111", name: "Ledidi Sport AS" }], nextCursor: null, hasMore: false },
      },
      "/api/companies/111111111": {
        status: 200,
        body: { orgNumber: "111111111", name: "Ledidi Sport AS", country: "NO", website: "https://ledidisport.no", primaryDomain: "ledidisport.no" },
      },
    });
    baseUrl = `http://127.0.0.1:${port}`;

    await expect(orakelEnrichDomain("ledidi.com")).rejects.toThrow(OrakelNotFoundError);
  });
});

// ── config-resolution specifics (the one thing that actually changed in this port) ──────

describe("config resolution", () => {
  it("throws OrakelUnavailableError when the resolver returns no baseUrl (unconfigured capability)", async () => {
    // A valid keyFile but no baseUrl isolates the baseUrl-missing path specifically —
    // readApiKey() runs first inside getJson(), so an entirely unconfigured resolver would
    // fail on the key instead and never reach this assertion.
    const noBaseUrl = makeOrakelClient(() => ({ keyFile }));

    await expect(noBaseUrl.orakelEnrichOrg("917137137")).rejects.toThrow(OrakelUnavailableError);
    await expect(noBaseUrl.orakelEnrichOrg("917137137")).rejects.toThrow(/baseUrl is not configured/);
  });

  it("throws OrakelUnavailableError when the resolver returns undefined (capability not mounted with any config)", async () => {
    const unconfigured = makeOrakelClient(() => undefined);

    await expect(unconfigured.orakelEnrichOrg("917137137")).rejects.toThrow(OrakelUnavailableError);
  });

  it("falls back to the default key file path when the resolver omits keyFile", async () => {
    // No keyFile in the resolved config at all (not even undefined-via-let) — the default
    // constant path (/run/secrets/orakel-key) is used, which won't exist in a test sandbox,
    // so this must fail as "key not readable", never crash on a missing property.
    const noKeyFile = makeOrakelClient(() => ({ keyFile: undefined as unknown as string, baseUrl: "http://127.0.0.1:1" }));

    await expect(noKeyFile.orakelSearch("x")).rejects.toThrow(OrakelUnavailableError);
  });

  it("re-reads the resolver on every call — a config change mid-process takes effect immediately", async () => {
    const portA = await listen({
      "/api/companies?q=A&limit=5": { status: 200, body: { data: [{ orgNumber: "1", name: "A" }] } },
    });
    baseUrl = `http://127.0.0.1:${portA}`;
    expect(await orakelSearch("A")).toHaveLength(1);

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const portB = await listen({
      "/api/companies?q=A&limit=5": { status: 200, body: { data: [] } },
    });
    baseUrl = `http://127.0.0.1:${portB}`;
    expect(await orakelSearch("A")).toHaveLength(0);
  });
});
