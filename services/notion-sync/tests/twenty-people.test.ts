import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeTwentyPeopleSource, toSourcePerson, TWENTY_SOURCE } from "../lib/adapters/twenty-people.js";

const BASE = "https://crm.example.com";

function page(people: unknown[], next?: string): Response {
  return new Response(
    JSON.stringify({
      data: { people },
      pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("toSourcePerson", () => {
  it("maps the fields the source holds, and derives nothing", () => {
    expect(toSourcePerson({
      id: "rec-1",
      name: { firstName: "Alex", lastName: "Partner" },
      emails: { primaryEmail: "alex@partner.example", additionalEmails: ["s.v@partner.example"] },
    })).toEqual({
      sourceId: "rec-1", source: TWENTY_SOURCE, name: "Alex Partner",
      email: "alex@partner.example", otherEmails: ["s.v@partner.example"],
    });
  });

  it("never falls back to an additional address when there is no primary", () => {
    // Which address is a person's identity is the source's call, not this file's.
    const person = toSourcePerson({
      id: "rec-2", name: { firstName: "No", lastName: "Primary" },
      emails: { primaryEmail: null, additionalEmails: ["only@x.io"] },
    });
    expect(person.email).toBe("");
    expect(person.otherEmails).toEqual(["only@x.io"]);
  });

  it("survives a record with nothing on it", () => {
    expect(toSourcePerson({})).toEqual({
      sourceId: "", source: TWENTY_SOURCE, name: "", email: "", otherEmails: [],
    });
  });

  it("drops an additional address that merely repeats the primary", () => {
    expect(toSourcePerson({
      id: "rec-3", name: { firstName: "A", lastName: "B" },
      emails: { primaryEmail: "a@b.io", additionalEmails: ["A@B.io", "c@d.io"] },
    }).otherEmails).toEqual(["c@d.io"]);
  });
});

describe("makeTwentyPeopleSource", () => {
  it("follows the cursor until the source says there is no more", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? page([{ id: "1", name: { firstName: "A", lastName: "One" }, emails: { primaryEmail: "a@x.io" } }], "cur-1")
        : page([{ id: "2", name: { firstName: "B", lastName: "Two" }, emails: { primaryEmail: "b@x.io" } }]);
    });
    const source = makeTwentyPeopleSource({
      baseUrl: `${BASE}/`, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect((await source.listPeople()).map((p) => p.sourceId)).toEqual(["1", "2"]);
    expect(urls).toEqual([
      `${BASE}/rest/people?limit=60`,
      `${BASE}/rest/people?limit=60&starting_after=cur-1`,
    ]);
  });

  it("sends the bearer token and asks for JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => page([]));
    await makeTwentyPeopleSource({
      baseUrl: BASE, apiKey: "secret-key", fetchImpl: fetchImpl as unknown as typeof fetch,
    }).listPeople();

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-key" });
  });

  it("retries once on 429, honouring Retry-After", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response("", { status: 429, headers: { "retry-after": "0" } })
        : page([{ id: "1", name: { firstName: "A", lastName: "One" }, emails: { primaryEmail: "a@x.io" } }]);
    });
    const people = await makeTwentyPeopleSource({
      baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch,
    }).listPeople();

    expect(calls).toBe(2);
    expect(people).toHaveLength(1);
  });

  it("throws with the status and body on any other failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(makeTwentyPeopleSource({
      baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch,
    }).listPeople()).rejects.toThrow(/failed: 401 nope/);
  });

  // The structural half of "the projection never writes back to the source"
  // (spec §8.3). A rule stated in a comment can be forgotten by the next caller;
  // a factory with no write method cannot be misused by one.
  it("exposes NO way to write to the source", () => {
    const source = makeTwentyPeopleSource({ baseUrl: BASE, apiKey: "k" });
    expect(Object.keys(source)).toEqual(["listPeople"]);
  });

  it("issues no non-GET request, whatever it is asked for", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => page([]));
    await makeTwentyPeopleSource({
      baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch,
    }).listPeople();
    for (const call of fetchImpl.mock.calls) {
      expect((call[1] as RequestInit).method).toBe("GET");
    }
  });

  it("carries no deployment's own hostname — the base URL is always supplied", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "lib", "adapters", "twenty-people.ts"), "utf8");
    expect(src).not.toMatch(/https?:\/\/(?!crm\.example)/);
  });
});
