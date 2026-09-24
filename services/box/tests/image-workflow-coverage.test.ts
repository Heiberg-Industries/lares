// image-workflow-coverage.test.ts (F9) — an image workflow's `paths:` trigger is checked
// against what its own Dockerfile actually COPIES, not transcribed by hand.
//
// A workflow that builds an image but does not list something its Dockerfile COPIES in its
// `on.push.paths` filter will not rebuild when only that thing changes — on a fresh install the
// container built from the stale image simply will not start. This file finds every
// `.github/workflows/*.yml` with a push `paths:` filter, resolves the Dockerfile(s) each one
// builds via its `docker/build-push-action` `file:` input (substituting any `${{ matrix.* }}`
// placeholder from that job's own `strategy.matrix`, and defaulting to `<context>/Dockerfile`
// when `file:` is absent, as `runtime-base.yml` does), reads every `COPY <src>` line in that
// Dockerfile that does not use `--from=` (a copy from an earlier build stage, not a repo file),
// and asserts each `<src>` is matched by at least one (non-negated) entry in that workflow's
// `paths:`.
//
// A `<src>` nested under a directory (contains a `/`) is required at TOP-LEVEL DIRECTORY
// granularity: `services/console/package.json` only requires that something under `services/`
// is named, not that `services/console` specifically is. A bare `<src>` with no `/` is decided
// by asking the repository what it actually is: if it names a DIRECTORY there, the filter must
// cover that directory the same way; if it names a FILE there, the filter must name that exact
// file (2026-09-21 amendment — the first version of this test treated every bare name as
// unrequireable, which silently dropped `patches`: `services/console/Dockerfile:39` is
// `COPY patches patches`, `console-image.yml`'s `paths:` never named it, and CLAUDE.md's own
// standing rule is "Root pnpm patches break every image unless the Dockerfile copies `patches/`
// before `pnpm install`" — a live instance of exactly the bug this slice exists to catch, invisible
// to a test that looked like it covered it). Only `<src> == "."` (the whole build context) stays
// unrequireable — it names no single thing to add to a filter.
//
// LIMIT OF THIS CHECK: because directory coverage is judged at TOP-LEVEL granularity only, a
// filter naming `packages/agent-kit/**` makes the whole of `packages` count as covered for any
// Dockerfile's purposes — including one that actually COPIES a different, unlisted subdirectory.
// `console-image.yml` copies `packages/vault-format` (Dockerfile line 49) but its `paths:` names
// only `packages/agent-kit`, `packages/strength` and `packages/taste`; a change to
// `packages/vault-format` alone still will not rebuild the console image, and this test will not
// say so. That is a real, separate gap (not one this slice closes) — finer-than-top-level-
// directory granularity is a follow-up, not this check.
//
// Never transcribed — a Dockerfile that starts copying from a new top-level directory, or a new
// bare root file, fails this test on its own.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

interface BuildTarget {
  readonly dockerfile: string; // repo-relative
  readonly context: string; // repo-relative
}

/** What a `COPY <src>` requires of a `paths:` filter: either that some entry names the top-level
 *  directory `<src>` is nested under (or something inside it), or — for a bare root-level
 *  `<src>` — that some entry names it exactly (a bare directory) or names the file itself. */
interface Requirement {
  readonly kind: "directory" | "file";
  readonly name: string;
}

interface UncoveredCopy {
  readonly workflow: string;
  readonly dockerfile: string;
  readonly line: number;
  readonly src: string;
  readonly requirement: Requirement;
}

/** The `on.push.paths` array of a parsed workflow doc, or null when it has none (e.g. `tests.yml`,
 *  which deliberately runs on every push with no filter — out of scope for this check). */
function pushPaths(doc: any): string[] | null {
  const paths = doc?.on?.push?.paths;
  return Array.isArray(paths) ? paths : null;
}

/** Substitutes every `${{ matrix.<key> }}` placeholder in `template` using `job.strategy.matrix`,
 *  producing one concrete path per combination (only a single `role`-style key is used anywhere
 *  in this repo today, but this does not assume that). Returns [] when a placeholder's matrix
 *  key cannot be resolved, so the caller skips a target it cannot read rather than crashing. */
function resolveMatrixFile(template: string, job: any): string[] {
  const keys = [...new Set([...template.matchAll(/\$\{\{\s*matrix\.([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))];
  if (keys.length === 0) return [template];
  let results = [template];
  for (const key of keys) {
    const values = job?.strategy?.matrix?.[key];
    if (!Array.isArray(values)) return [];
    const next: string[] = [];
    for (const r of results) {
      for (const v of values) next.push(r.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, "g"), String(v)));
    }
    results = next;
  }
  return results;
}

/** Every Dockerfile a workflow builds via `docker/build-push-action`, across every job and step,
 *  deduplicated by (dockerfile, context). */
function buildTargets(doc: any): BuildTarget[] {
  const targets: BuildTarget[] = [];
  for (const job of Object.values<any>(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses !== "string" || !step.uses.startsWith("docker/build-push-action")) continue;
      const context: string = step.with?.context ?? ".";
      const fileTemplate: string = step.with?.file ?? posix.join(context, "Dockerfile");
      for (const dockerfile of resolveMatrixFile(fileTemplate, job)) targets.push({ dockerfile, context });
    }
  }
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.dockerfile}::${t.context}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every `COPY <src> <dest>` source in a Dockerfile that is a repo path, not a `--from=` stage
 *  reference, resolved to a repo-root-relative path via the build's own `context:`. */
function copySources(dockerfilePath: string, context: string): Array<{ src: string; line: number }> {
  const lines = readFileSync(dockerfilePath, "utf8").split("\n");
  const out: Array<{ src: string; line: number }> = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*COPY\s+(.*)$/);
    if (!m) return;
    const rest = m[1]!.trim();
    if (rest.includes("--from=")) return; // a stage, not a repo file
    const tokens = rest.split(/\s+/).filter((t) => !t.startsWith("--"));
    if (tokens.length < 2) return; // need at least one src and a dest
    for (const raw of tokens.slice(0, -1)) {
      const src = context === "." ? raw : posix.normalize(posix.join(context, raw));
      out.push({ src, line: i + 1 });
    }
  });
  return out;
}

/** What `src` (a repo-root-relative `COPY` source) requires of a `paths:` filter, or null when
 *  `src` names the whole build context (`.`) — nothing a filter entry could name. A nested
 *  source requires its top-level directory; a bare root-level source is looked up on disk and
 *  requires either that directory (if it is one) or that exact file (if it is one). */
function requirementFor(src: string): Requirement | null {
  const s = src.replace(/\/+$/, "");
  if (s === "" || s === ".") return null;
  if (s.includes("/")) return { kind: "directory", name: s.split("/")[0]! };
  return { kind: statSync(join(REPO_ROOT, s)).isDirectory() ? "directory" : "file", name: s };
}

/** Whether some non-negated entry in `paths` satisfies `req`: for a directory, an entry naming
 *  it exactly or something inside it; for a file, an entry naming it exactly. A `!`-prefixed
 *  entry (e.g. `sync-jobs-image.yml`'s deliberate `"!services/box/compose.yaml"`) never counts
 *  as coverage — it narrows an already-covered directory, it does not widen one. */
function isCovered(req: Requirement, paths: string[]): boolean {
  const positive = paths.filter((p) => !p.startsWith("!"));
  if (req.kind === "file") return positive.some((p) => p === req.name);
  return positive.some((p) => p === req.name || p.startsWith(`${req.name}/`));
}

function findUncoveredCopies(): { uncovered: UncoveredCopy[]; examined: number } {
  const uncovered: UncoveredCopy[] = [];
  let examined = 0;
  const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  for (const wf of workflowFiles) {
    const doc = parse(readFileSync(join(WORKFLOWS_DIR, wf), "utf8"));
    const paths = pushPaths(doc);
    if (!paths) continue; // no push.paths filter: out of scope (e.g. tests.yml runs unconditionally)
    const targets = buildTargets(doc);
    if (targets.length === 0) continue; // builds no image
    examined++;
    for (const { dockerfile, context } of targets) {
      const dockerfilePath = join(REPO_ROOT, dockerfile);
      const seenDirs = new Set<string>();
      for (const { src, line } of copySources(dockerfilePath, context)) {
        const requirement = requirementFor(src);
        if (requirement === null || isCovered(requirement, paths)) continue;
        const key = `${dockerfile}::${requirement.kind}::${requirement.name}`;
        if (seenDirs.has(key)) continue; // report each requirement once per Dockerfile, first line
        seenDirs.add(key);
        uncovered.push({ workflow: wf, dockerfile, line, src, requirement });
      }
    }
  }
  return { uncovered, examined };
}

describe("an image workflow's paths: filter covers what its Dockerfile COPIES", () => {
  it("examined at least four workflows, so a parsing change cannot pass vacuously", () => {
    const { examined } = findUncoveredCopies();
    expect(examined).toBeGreaterThanOrEqual(4);
  });

  it("rebuilds when a file its Dockerfile COPIES changes", () => {
    const { uncovered } = findUncoveredCopies();
    const messages = uncovered.map(({ workflow, dockerfile, line, src, requirement }) =>
      requirement.kind === "directory"
        ? `${workflow}: ${dockerfile}:${line} COPIES "${src}" (directory "${requirement.name}") but "${workflow}"'s paths: filter names nothing under "${requirement.name}/" — add it`
        : `${workflow}: ${dockerfile}:${line} COPIES "${src}" (a bare file) but "${workflow}"'s paths: filter does not name "${requirement.name}" — add it`,
    );
    expect(messages).toEqual([]);
  });
});
