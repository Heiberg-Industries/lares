import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import {
  orakelEnrichDomain,
  orakelEnrichOrg,
  orakelSearch,
  OrakelNotFoundError,
  OrakelUnavailableError,
} from "../lib/orakel-client.js";

/** A realistic Orakel /api/companies/{orgNumber} flat object (subset of the real fields —
 *  same fixture shape as the old adapter's test, services/agent-runtime/tests/orakel-client.test.ts). */
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

beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), "orakel-key-"));
  writeFileSync(join(keyDir, "orakel-key"), "test-orakel-key\n");
  process.env["ORAKEL_KEY_FILE"] = join(keyDir, "orakel-key");
});

afterEach(async () => {
  delete process.env["ORAKEL_URL"];
  delete process.env["ORAKEL_KEY_FILE"];
  rmSync(keyDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("orakelEnrichOrg", () => {
  it("looks up by org number and maps the real flat-object fields", async () => {
    const port = await listen({ "/api/companies/917137137": { status: 200, body: ledidi } });
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

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
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

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
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

    await expect(orakelEnrichOrg("000000000")).rejects.toThrow(OrakelNotFoundError);
  });

  it("throws OrakelUnavailableError on a non-404 hiccup", async () => {
    const port = await listen({ "/api/companies/917137137": { status: 503, body: { error: "down" } } });
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

    await expect(orakelEnrichOrg("917137137")).rejects.toThrow(OrakelUnavailableError);
  });

  it("throws OrakelUnavailableError when the connection is refused", async () => {
    const port = await listen({});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

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
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

    const r = await orakelSearch("Ledidi");

    expect(r).toEqual([
      { orgNumber: "917137137", name: "Ledidi AS", country: "NO", employeeCount: 34, naceName: "Programmeringstjenester", sizeClass: "small" },
    ]);
  });

  it("returns an empty list (not an error) for a search with zero legitimate matches", async () => {
    const port = await listen({
      "/api/companies?q=Nope&limit=5": { status: 200, body: { data: [], nextCursor: null, hasMore: false } },
    });
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

    expect(await orakelSearch("Nope")).toEqual([]);
  });

  it("throws OrakelUnavailableError on a genuine transport failure", async () => {
    const port = await listen({ "/api/companies?q=Nope&limit=5": { status: 503, body: { error: "down" } } });
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

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
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

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
    process.env["ORAKEL_URL"] = `http://127.0.0.1:${port}`;

    await expect(orakelEnrichDomain("ledidi.com")).rejects.toThrow(OrakelNotFoundError);
  });
});
