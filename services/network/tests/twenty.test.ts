/**
 * Tests for the thin Twenty REST client (services/network/lib/twenty.ts).
 * Uses vi.stubGlobal("fetch", vi.fn()) — no live HTTP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTwentyClient, type TwentyPerson } from "../lib/twenty.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeResponse = {
  status: number;
  body?: unknown;
  retryAfter?: string;
};

function makeResponse(r: FakeResponse): Response {
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "retry-after" ? (r.retryAfter ?? null) : null,
    },
    json: async () => r.body ?? {},
    text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})),
  } as unknown as Response;
}

/** Build a mock fetch that returns the queued responses in order. */
function buildFetch(responses: FakeResponse[]) {
  let i = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return makeResponse(r);
  });
}

function makePerson(id: string, overrides: Partial<TwentyPerson> = {}): TwentyPerson {
  return {
    id,
    name: { firstName: "Test", lastName: "Person" },
    emails: { primaryEmail: `${id}@example.com`, additionalEmails: null },
    linkedinLink: null,
    companyId: null,
    strength: null,
    lastContactedAt: null,
    pulse: null,
    lastPersonalContact: null,
    ...overrides,
  };
}

const BASE = "https://crm.example.co";
const KEY = "test-api-key";

// ---------------------------------------------------------------------------
// 1. listPeople — cursor pagination joins both pages
// ---------------------------------------------------------------------------

describe("listPeople — pagination", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("paginates: fetches page 1 then page 2 and joins results", async () => {
    // Build 60 people for the first page (a full page → should trigger next fetch)
    const page1People = Array.from({ length: 60 }, (_, i) => makePerson(`id-${i}`));
    const page2People = [makePerson("id-60"), makePerson("id-61")];

    const mockFetch = buildFetch([
      {
        status: 200,
        body: {
          data: { people: page1People },
          pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
        },
      },
      {
        status: 200,
        body: {
          data: { people: page2People },
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const people = await client.listPeople();

    expect(people).toHaveLength(62);
    expect(people[0]!.id).toBe("id-0");
    expect(people[61]!.id).toBe("id-61");

    // First call — no cursor
    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    expect(firstUrl).toBe(`${BASE}/rest/people?limit=60`);

    // Second call — cursor from page 1
    const secondUrl = mockFetch.mock.calls[1]![0] as string;
    expect(secondUrl).toBe(`${BASE}/rest/people?limit=60&starting_after=cursor-abc`);
  });

  it("maps missing custom fields to null", async () => {
    const rawPerson = {
      id: "abc",
      name: { firstName: "Ola", lastName: "Nordmann" },
      emails: { primaryEmail: "ola@example.com", additionalEmails: null },
      linkedinLink: null,
      companyId: null,
      // pulse and lastPersonalContact absent (not yet provisioned)
    };
    const mockFetch = buildFetch([
      {
        status: 200,
        body: {
          data: { people: [rawPerson] },
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const [person] = await client.listPeople();
    expect(person!.pulse).toBeNull();
    expect(person!.lastPersonalContact).toBeNull();
    expect(person!.strength).toBeNull();
    expect(person!.lastContactedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. 429 → retry once → success
// ---------------------------------------------------------------------------

describe("updatePerson — 429 retry", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("retries after Retry-After: 0 and succeeds on second attempt", async () => {
    const mockFetch = buildFetch([
      { status: 429, retryAfter: "0" },
      { status: 200, body: { data: { updatePerson: { id: "p1" } } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    await expect(
      client.updatePerson("p1", { pulse: "GOOD" }),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after two 429s (max one retry)", async () => {
    const mockFetch = buildFetch([
      { status: 429, retryAfter: "0" },
      { status: 429, retryAfter: "0" },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    await expect(client.updatePerson("p1", { pulse: "GOOD" })).rejects.toThrow(/429/);
  });
});

// ---------------------------------------------------------------------------
// 3. Non-2xx throws with status code
// ---------------------------------------------------------------------------

describe("listPeople — error handling", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("throws an error including '500' on a 500 response", async () => {
    const mockFetch = buildFetch([{ status: 500, body: { error: "internal" } }]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    await expect(client.listPeople()).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// 4. updatePerson — correct URL, body, and bearer header
// ---------------------------------------------------------------------------

describe("updatePerson — request shape", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes the right URL with a JSON body and bearer header", async () => {
    const mockFetch = buildFetch([
      { status: 200, body: { data: { updatePerson: { id: "abc123" } } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    await client.updatePerson("abc123", { pulse: "STRONG", lastPersonalContact: "2026-06-01T00:00:00Z" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/rest/people/abc123`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      pulse: "STRONG",
      lastPersonalContact: "2026-06-01T00:00:00Z",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// 5. createPerson and findCompanyByName
// ---------------------------------------------------------------------------

describe("createPerson", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /rest/people and returns the new record id", async () => {
    const newId = "new-person-id-xyz";
    const mockFetch = buildFetch([
      { status: 200, body: { data: { createPerson: { id: newId } } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const id = await client.createPerson({
      firstName: "Ola",
      lastName: "Nordmann",
      email: "ola@example.com",
      linkedinUrl: "https://linkedin.com/in/olanordmann",
      brand: "orakel",
    });

    expect(id).toBe(newId);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/rest/people`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.name).toEqual({ firstName: "Ola", lastName: "Nordmann" });
    expect(body.emails).toEqual({ primaryEmail: "ola@example.com" });
    expect(body.linkedinLink).toEqual({ primaryLinkUrl: "https://linkedin.com/in/olanordmann" });
    expect(body.brand).toBe("orakel");
  });

  it("creates a person without optional fields (no email, no linkedin, no company)", async () => {
    const mockFetch = buildFetch([
      { status: 200, body: { data: { createPerson: { id: "minimal-id" } } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const id = await client.createPerson({ firstName: "Jan", lastName: "Hansen", brand: "zero7" });

    expect(id).toBe("minimal-id");
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.emails).toBeUndefined();
    expect(body.linkedinLink).toBeUndefined();
    expect(body.companyId).toBeUndefined();
  });

  it("returns id when response uses alternative wrapper key (e.g. 'person' instead of 'createPerson')", async () => {
    // Twenty's create-response wrapper key is unverified across versions;
    // the tolerant extractor should handle any key that wraps an object with a string id.
    const mockFetch = buildFetch([
      { status: 200, body: { data: { person: { id: "p-9" } } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const id = await client.createPerson({ firstName: "Alt", lastName: "Key", brand: "orakel" });

    expect(id).toBe("p-9");
  });
});

describe("findCompanyByName", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("returns null when data array is empty", async () => {
    const mockFetch = buildFetch([
      { status: 200, body: { data: { companies: [] } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const result = await client.findCompanyByName("Unknown Corp");
    expect(result).toBeNull();
  });

  it("returns the first company record when present", async () => {
    const mockFetch = buildFetch([
      {
        status: 200,
        body: {
          data: {
            companies: [{ id: "co-123", name: { text: "Acme AS" } }],
          },
        },
      },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const result = await client.findCompanyByName("Acme AS");
    expect(result).toEqual({ id: "co-123", name: "Acme AS" });

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("/rest/companies");
    expect(url).toContain("filter=name");
    expect(url).toContain("Acme%20AS");
  });
});

// ---------------------------------------------------------------------------
// 6. listOpportunities — cursor pagination
// ---------------------------------------------------------------------------

describe("listOpportunities", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("paginates and maps stage/companyId", async () => {
    const mockFetch = buildFetch([
      {
        status: 200,
        body: {
          data: { opportunities: [{ id: "o1", name: "DNB pilot", stage: "PROPOSAL", companyId: "c1" }] },
          pageInfo: { hasNextPage: true, endCursor: "cur1" },
        },
      },
      {
        status: 200,
        body: {
          data: { opportunities: [{ id: "o2", name: "Telia intro", stage: "MEETING", companyId: null }] },
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    const opps = await client.listOpportunities();

    expect(opps).toEqual([
      { id: "o1", name: "DNB pilot", stage: "PROPOSAL", companyId: "c1", pointOfContactId: null },
      { id: "o2", name: "Telia intro", stage: "MEETING", companyId: null, pointOfContactId: null },
    ]);

    // First call — no cursor
    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    expect(firstUrl).toBe(`${BASE}/rest/opportunities?limit=60`);

    // Second call — cursor from page 1
    const secondUrl = mockFetch.mock.calls[1]![0] as string;
    expect(secondUrl).toBe(`${BASE}/rest/opportunities?limit=60&starting_after=cur1`);
  });
});

// ---------------------------------------------------------------------------
// 7. getCompanyName — single fetch + null-on-404
// ---------------------------------------------------------------------------

describe("getCompanyName", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the name (string shape)", async () => {
    const mockFetch = buildFetch([
      { status: 200, body: { data: { company: { id: "c1", name: "DNB" } } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    expect(await client.getCompanyName("c1")).toBe("DNB");
  });

  it("returns the name ({text} shape)", async () => {
    const mockFetch = buildFetch([
      { status: 200, body: { data: { company: { id: "c1", name: { text: "DNB AS" } } } } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    expect(await client.getCompanyName("c1")).toBe("DNB AS");
  });

  it("returns null instead of throwing when the company is gone (404)", async () => {
    const mockFetch = buildFetch([
      { status: 404, body: { error: "not found" } },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const client = createTwentyClient(BASE, KEY);
    expect(await client.getCompanyName("missing")).toBeNull();
  });
});
