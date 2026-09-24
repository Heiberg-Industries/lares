import { readFileSync } from "node:fs";
// services/atlas/lib/adapters/github-source.ts
// The `repo:` reader. Repo docs are read from GITHUB, not from a checkout, because the box
// has no checkouts and Postgres (where proposals live) is not published off the box — so
// the job has to run there. That makes "canonical" mean THE PUSHED STATE, which is the
// honest reading anyway for a store every business agent grounds on.
//
// The 404-vs-everything-else split is the whole point of this file. On this box an
// outbound call can be DROPPED BY THE FIREWALL, and a dropped call that reads as "the file
// isn't there" would propose deleting a note's content. So: 404 → missing (real
// information); every other non-2xx, and every thrown network error → failed (information
// about us, not about the repo).
import type { SourceRef } from "../sources.js";
import type { ResolvedSource, SourceReader } from "../resolve.js";

export interface RepoLocation { owner: string; repo: string }
export type RepositoryMap = Record<string, RepoLocation>;

/** Installation data; never infer a GitHub owner from a local directory name. */
export function readRepositoryMap(): RepositoryMap {
  const file = process.env.LARES_ATLAS_REPOSITORIES_FILE?.trim();
  if (!file) throw new Error("atlas: LARES_ATLAS_REPOSITORIES_FILE is required for repo references");
  return validateRepositoryMap(JSON.parse(readFileSync(file, "utf8")));
}

export function validateRepositoryMap(value: unknown): RepositoryMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("atlas: repository map must be an object");
  }
  const result: RepositoryMap = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    const loc = raw as Partial<RepoLocation> | null;
    if (!key || key.includes("/") || ["__proto__", "constructor", "prototype"].includes(key) ||
        !loc || typeof loc !== "object" || Array.isArray(loc) ||
        typeof loc.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(loc.owner) ||
        typeof loc.repo !== "string" || !/^[A-Za-z0-9_.-]+$/.test(loc.repo) ||
        [".", ".."].includes(loc.repo)) {
      throw new Error(`atlas: invalid repository mapping for "${key}"`);
    }
    result[key] = { owner: loc.owner, repo: loc.repo };
  }
  return result;
}

export function repoLocationFor(codebase: string, repositories: RepositoryMap = readRepositoryMap()): RepoLocation {
  const dir = codebase.replace(/\/+$/, "").split("/").pop() ?? "";
  const map = validateRepositoryMap(repositories);
  if (!Object.hasOwn(map, dir)) {
    throw new Error(`atlas: no GitHub repo is mapped for codebase "${codebase}". Configure LARES_ATLAS_REPOSITORIES_FILE and the token's repository access.`);
  }
  return map[dir]!;
}

export interface RepoReaderOptions {
  /** Read-only token authorized for the configured repositories. */
  token: string;
  repositories?: RepositoryMap;
  /** Injected in tests. In the container this is the proxy-aware fetch from the root. */
  fetch?: typeof fetch;
}

/**
 * THE `repo:` reader the composition root wires — one reader for a prefix that spans configured
 * repositories.
 *
 * `makeGithubReader` below is bound to a single repo, which is right for what it does but
 * cannot be the whole story: `ReaderMap` holds one reader per prefix, and a bare locator
 * like `docs/CURRENT_STATUS.md` means a different file in each repo. So this dispatches on
 * the ref's `codebase` — the note's own declaration of which repo it is about — and keeps
 * one bound reader per repository.
 *
 * An unmappable codebase resolves to `failed`, never `missing`. We did not learn that the
 * file is absent; we learned that this job does not know where to look, which is a fact
 * about us. Same reasoning as the 404-vs-everything-else split below, and the reason
 * `the repository map` throws rather than guessing an owner.
 */
export function makeRepoReader(opts: RepoReaderOptions): SourceReader {
  const byRepo = new Map<string, SourceReader>();

  return {
    id: "github",
    async read(ref: SourceRef): Promise<ResolvedSource> {
      if (ref.codebase === undefined || ref.codebase.trim() === "") {
        return {
          ref, outcome: "failed",
          reason:
            `${ref.declared} is a repo reference on a note with no codebase, so there is no ` +
            "repository to read it from",
        };
      }
      let location: RepoLocation;
      try {
        location = repoLocationFor(ref.codebase, opts.repositories);
      } catch (e) {
        return { ref, outcome: "failed", reason: e instanceof Error ? e.message : String(e) };
      }
      const key = `${location.owner}/${location.repo}`;
      let reader = byRepo.get(key);
      if (reader === undefined) {
        reader = makeGithubReader({ token: opts.token, location, fetch: opts.fetch });
        byRepo.set(key, reader);
      }
      return reader.read(ref);
    },
  };
}

export interface GithubReaderOptions {
  token: string;
  location: RepoLocation;
  /** Injected in tests. In the container this is the proxy-aware fetch from the root. */
  fetch?: typeof fetch;
}

export function makeGithubReader(opts: GithubReaderOptions): SourceReader {
  const doFetch = opts.fetch ?? fetch;
  const base = `https://api.github.com/repos/${opts.location.owner}/${opts.location.repo}/contents`;

  return {
    id: "github",
    async read(ref: SourceRef): Promise<ResolvedSource> {
      const url = `${base}/${ref.locator}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: {
            // `.raw+json` gives the file bytes rather than base64-in-JSON, so nothing here
            // has to decode — and a decode step is one more place to turn a partial read
            // into a plausible-looking string.
            "Accept": "application/vnd.github.raw+json",
            "Authorization": `Bearer ${opts.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lares-atlas-sync",
          },
        });
      } catch (e) {
        return {
          ref, outcome: "failed",
          reason:
            `could not reach api.github.com for ${ref.declared} ` +
            `(${e instanceof Error ? e.message : String(e)}). On the agent box the likeliest ` +
            "cause is egress: check the squid allow-list and the saga_egress nft rules — a " +
            "dropped call is NOT a missing file.",
        };
      }

      if (res.status === 404) {
        return { ref, outcome: "missing", reason: `404 from GitHub for ${ref.declared}` };
      }
      if (!res.ok) {
        return {
          ref, outcome: "failed",
          reason:
            `GitHub returned ${res.status} for ${ref.declared}` +
            (res.status === 401 || res.status === 403
              ? " — the PAT is invalid, expired, or does not include this repository"
              : ""),
        };
      }

      // A 200 does not by itself mean "the file's bytes". GitHub ignores
      // `Accept: application/vnd.github.raw+json` and returns the JSON-wrapped
      // representation whenever the locator resolves to a DIRECTORY, and the squid proxy
      // this box routes GitHub through can strip or rewrite the Accept header on the way
      // out. Either way `res.text()` still returns a non-empty string — a JSON blob or a
      // directory listing — that must not be read as the file's prose. So: require the raw
      // content-type before trusting the body at all. An absent content-type is treated the
      // same as a wrong one — the only thing on this box that would strip the header is the
      // proxy, and guessing "it's probably fine" is exactly the failure mode this reader
      // exists to not have.
      const contentType = res.headers.get("content-type") ?? "";
      // Lowercased on purpose, unlike the realpath containment check in fs-source.ts: THAT
      // guard compares filesystem paths, where ext4 makes `/srv/atlas` and `/srv/ATLAS`
      // genuinely different directories, so folding case would let a symlink escape.  HTTP
      // media types are a different kind of string — RFC 9110 §8.3.1 makes them
      // case-insensitive by specification — and this guard's whole threat model is a proxy
      // that rewrites headers in flight, which is exactly the kind of intermediary that
      // might also change their casing. Comparing case-sensitively here would reject a
      // perfectly good response, not protect against a bad one.
      if (!contentType.toLowerCase().startsWith("application/vnd.github.raw")) {
        return {
          ref, outcome: "failed",
          reason:
            `GitHub returned content-type "${contentType || "(none)"}" instead of raw file content for ` +
            `${ref.declared} — either the locator is a directory, or a proxy rewrote the Accept header`,
        };
      }

      const content = await res.text();
      if (content === "") {
        // A 200 with no bytes is not a file we can derive from, and treating it as `found`
        // would let a truncated or proxy-mangled response become the basis of a proposal.
        return { ref, outcome: "failed", reason: `GitHub returned an empty body for ${ref.declared}` };
      }
      return { ref, outcome: "found", content };
    },
  };
}
