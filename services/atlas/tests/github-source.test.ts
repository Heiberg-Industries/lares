import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
afterEach(() => vi.unstubAllEnvs());
import { repoLocationFor, validateRepositoryMap, makeGithubReader, makeRepoReader } from "../lib/adapters/github-source.js";
import type { SourceRef } from "../lib/sources.js";

const ref = (locator: string, codebase?: string): SourceRef =>
  ({ prefix: "repo", locator, declared: `repo:${locator}`, ...(codebase === undefined ? {} : { codebase }) });
const LOC = { owner: "example-org" as const, repo: "project-one" };
const TOKEN = "ghp_test";

const reader = (fetchImpl: typeof fetch) =>
  makeGithubReader({ token: "ghp_test", location: LOC, fetch: fetchImpl });

const ok = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/vnd.github.raw" } });

const repositories = {
  "project-one": { owner: "example-org", repo: "project-one" },
  "project-two": { owner: "example-org", repo: "project-two" },
};
describe("repoLocationFor", () => {
  it("uses explicit mappings, including trailing slashes", () => {
    expect(repoLocationFor("/workspace/project-one/", repositories)).toEqual(repositories["project-one"]);
    expect(repoLocationFor("/workspace/project-two", repositories)).toEqual(repositories["project-two"]);
  });
  it("refuses unknown and inherited keys", () => {
    expect(() => repoLocationFor("/workspace/unknown", repositories)).toThrow(/no GitHub repo/);
    expect(() => repoLocationFor("/workspace/toString", repositories)).toThrow(/no GitHub repo/);
  });
  it("rejects invalid configuration before constructing authenticated URLs", () => {
    for (const value of [null, [], { a: { owner: "bad/owner", repo: "repo" } }, { a: { owner: "org", repo: ".." } }]) {
      expect(() => validateRepositoryMap(value)).toThrow();
    }
  });
});

describe("makeRepoReader — one prefix, configured repositories", () => {
  it("routes each note's locator to the repo its codebase names", async () => {
    const urls: string[] = [];
    const r = makeRepoReader({ repositories,
      token: TOKEN,
      fetch: async (url) => { urls.push(String(url)); return ok("x"); },
    });
    await r.read(ref("docs/CURRENT_STATUS.md", "/workspace/project-one"));
    await r.read(ref("docs/CURRENT_STATUS.md", "/workspace/project-two"));
    // Same locator, two different repos — the exact case a single bound reader gets
    // silently wrong, returning project-one's file as if it were project-two's.
    expect(urls).toEqual([
      "https://api.github.com/repos/example-org/project-one/contents/docs/CURRENT_STATUS.md",
      "https://api.github.com/repos/example-org/project-two/contents/docs/CURRENT_STATUS.md",
    ]);
  });

  it("reports itself as the github reader, so the wiring sentinel accepts it", () => {
    expect(makeRepoReader({ repositories, token: TOKEN }).id).toBe("github");
  });

  it("FAILS — never 'missing' — on a codebase it cannot map", async () => {
    // We did not learn the file is absent. We learned this job does not know where to look.
    // Reporting `missing` here would invite a proposal that deletes the note's content.
    const r = await makeRepoReader({ repositories, token: TOKEN, fetch: async () => ok("x") })
      .read(ref("README.md", "/workspace/something-new"));
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/no GitHub repo/i);
  });

  it("FAILS on a repo ref with no codebase at all", async () => {
    const r = await makeRepoReader({ repositories, token: TOKEN, fetch: async () => ok("x") })
      .read(ref("README.md"));
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/no codebase/i);
  });

  it("reuses one bound reader per repository rather than building one per read", async () => {
    let calls = 0;
    const r = makeRepoReader({ repositories, token: TOKEN, fetch: async () => { calls++; return ok("x"); } });
    await r.read(ref("a.md", "/workspace/project-one"));
    await r.read(ref("b.md", "/workspace/project-one"));
    expect(calls).toBe(2);
  });
});

describe("makeGithubReader", () => {
  it("reads a file and returns its raw content", async () => {
    const r = await reader(async () => ok("# Murmur\n")).read(ref("README.md"));
    expect(r).toMatchObject({ outcome: "found", content: "# Murmur\n" });
  });

  it("requests the raw media type from the contents API with the token", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    await reader(async (url, init) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      return ok("x");
    }).read(ref("docs/CURRENT_STATUS.md"));
    expect(seen!.url).toBe("https://api.github.com/repos/example-org/project-one/contents/docs/CURRENT_STATUS.md");
    expect(seen!.headers["Accept"]).toBe("application/vnd.github.raw+json");
    expect(seen!.headers["Authorization"]).toBe("Bearer ghp_test");
  });

  it("treats 404 as MISSING — the file really is not in the repo", async () => {
    const r = await reader(async () => new Response("Not Found", { status: 404 })).read(ref("gone.md"));
    expect(r.outcome).toBe("missing");
  });

  it("treats 401 as FAILED — a bad token is not a deleted file", async () => {
    const r = await reader(async () => new Response("Bad credentials", { status: 401 })).read(ref("README.md"));
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/401/);
  });

  it("treats 403 as FAILED — rate limit or a PAT missing this repo, not a deletion", async () => {
    const r = await reader(async () => new Response("rate limited", { status: 403 })).read(ref("README.md"));
    expect(r.outcome).toBe("failed");
  });

  it("treats 5xx as FAILED", async () => {
    const r = await reader(async () => new Response("boom", { status: 502 })).read(ref("README.md"));
    expect(r.outcome).toBe("failed");
  });

  it("treats a NETWORK error as FAILED and says so in words a human can act on", async () => {
    const r = await reader(async () => { throw new TypeError("fetch failed"); }).read(ref("README.md"));
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/could not reach api\.github\.com/i);
    expect(r.reason).toMatch(/egress/i);   // points at the firewall, the likeliest cause on the box
  });

  it("never returns empty content as `found`", async () => {
    const r = await reader(async () => ok("")).read(ref("README.md"));
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/empty/i);
  });

  it("treats a JSON-wrapped 200 as FAILED — a proxy that dropped the Accept header must not become content", async () => {
    const r = await reader(async () => new Response(
      JSON.stringify({ name: "README.md", encoding: "base64", content: "IyBNdXJtdXIK" }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    )).read(ref("README.md"));
    expect(r.outcome).toBe("failed");
    expect(r.content).toBeUndefined();
    expect(r.reason).toMatch(/accept|raw|content-type/i);
  });

  it("treats a directory listing as FAILED, not as a file it can derive from", async () => {
    const r = await reader(async () => new Response(
      JSON.stringify([{ name: "a.md", type: "file" }]),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    )).read(ref("docs"));
    expect(r.outcome).toBe("failed");
  });

  it("still accepts a raw 200 with a charset on the content-type", async () => {
    const r = await reader(async () => new Response("# Murmur\n", {
      status: 200, headers: { "content-type": "application/vnd.github.raw; charset=utf-8" },
    })).read(ref("README.md"));
    expect(r).toMatchObject({ outcome: "found", content: "# Murmur\n" });
  });

  it("accepts a raw content-type whatever its case — media types are case-insensitive", async () => {
    const r = await reader(async () => new Response("# Murmur\n", {
      status: 200, headers: { "content-type": "Application/VND.GitHub.Raw; charset=utf-8" },
    })).read(ref("README.md"));
    expect(r).toMatchObject({ outcome: "found", content: "# Murmur\n" });
  });
});


describe("installation repository file", () => {
  it("refuses missing configuration without making a network request", async () => {
    vi.stubEnv("LARES_ATLAS_REPOSITORIES_FILE", "");
    const network = vi.fn();
    const result = await makeRepoReader({ token: TOKEN, fetch: network }).read(ref("README.md", "/workspace/project-one"));
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("LARES_ATLAS_REPOSITORIES_FILE");
    expect(network).not.toHaveBeenCalled();
  });
  it("loads the operator file and rejects malformed content without fetching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-repositories-"));
    const file = join(dir, "repositories.json");
    vi.stubEnv("LARES_ATLAS_REPOSITORIES_FILE", file);
    try {
      writeFileSync(file, JSON.stringify(repositories));
      expect(repoLocationFor("/workspace/project-two")).toEqual(repositories["project-two"]);
      writeFileSync(file, '{"bad":');
      const network = vi.fn();
      const result = await makeRepoReader({ token: TOKEN, fetch: network }).read(ref("README.md", "/workspace/project-one"));
      expect(result.outcome).toBe("failed");
      expect(network).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
