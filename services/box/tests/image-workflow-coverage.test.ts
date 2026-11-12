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
// before `pnpm install`" — a live instance of exactly the bug this test exists to catch, invisible
// to a test that looked like it covered it). Only `<src> == "."` (the whole build context) stays
// unrequireable — it names no single thing to add to a filter.
//
// LIMIT OF THIS CHECK: because directory coverage is judged at TOP-LEVEL granularity only, a
// filter naming `packages/agent-kit/**` makes the whole of `packages` count as covered for any
// Dockerfile's purposes — including one that actually COPIES a different, unlisted subdirectory.
// `console-image.yml` copies `packages/vault-format` (Dockerfile line 49) but its `paths:` names
// only `packages/agent-kit` and `packages/taste`; a change to
// `packages/vault-format` alone still will not rebuild the console image, and this test will not
// say so. That is a real, separate gap (not one this test closes) — finer-than-top-level-
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

const PUBLIC_DOCS_GENERATED_SOURCES = new Set([
  ".public-docs-bake/snapshot",
  ".public-docs-bake/identity.json",
]);
const PUBLIC_DOCS_TRACKED_INPUTS: Requirement[] = [
  { kind: "directory", name: "docs" },
  { kind: "file", name: "scripts/public-docs.ts" },
  { kind: "directory", name: "packages" },
  { kind: "file", name: "package.json" },
  { kind: "file", name: "pnpm-lock.yaml" },
  { kind: "file", name: "pnpm-workspace.yaml" },
];
const PUBLIC_DOCS_BAKE_STEP = "Export and stage the verified public docs corpus";

/** Generated Docker inputs cannot be covered by a Git path filter. Require each Docker build
 * that copies them to have verified them earlier in the same job, and require the workflow to
 * rerun for every tracked source/configuration input used by that export. */
function publicDocsBakeErrors(job: any, buildStepIndex: number): string[] {
  const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
  const bakeIndex = steps.findIndex((step, index) => index < buildStepIndex && step.name === PUBLIC_DOCS_BAKE_STEP);
  if (bakeIndex < 0) return ["missing bake step before Docker build"];
  const bake = String(steps[bakeIndex]?.run ?? "");
  const errors: string[] = [];
  const hasEarlier = (predicate: (step: any) => boolean) => steps.some((step, index) => index < bakeIndex && predicate(step));
  if (!hasEarlier((step) => step.uses === "actions/setup-node@v4" && step.with?.["node-version"] === "24"))
    errors.push("Node 24 setup must precede the public docs exporter");
  if (!hasEarlier((step) => typeof step.run === "string" && /pnpm install --frozen-lockfile --filter lares(?:\s|$)/.test(step.run)))
    errors.push("the lares exporter dependency install must precede the bake");
  for (const token of [
    'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    'scripts/public-docs.ts export --root "$GITHUB_WORKSPACE" --release "$PUBLIC_DOCS_RELEASE"',
    'mkdir -p .public-docs-bake',
    'cp -R "$export_dir" .public-docs-bake/snapshot',
    'cp "$RUNNER_TEMP/public-docs-identity.json" .public-docs-bake/identity.json',
    'i.sourceCommit!==process.argv[2]||i.release!==process.argv[3]',
    '"$GITHUB_SHA" "$PUBLIC_DOCS_RELEASE"',
    'scripts/public-docs.ts verify --snapshot "$GITHUB_WORKSPACE/.public-docs-bake/snapshot" --expected-corpus "$expected_hash"',
  ]) {
    if (!bake.includes(token)) errors.push(`bake step is missing required verified export operation: ${token}`);
  }
  return errors;
}

function publicDocsTrackedInputGaps(paths: string[] | null): string[] {
  if (!paths) return [];
  return PUBLIC_DOCS_TRACKED_INPUTS.filter((input) => !isCovered(input, paths))
    .map((input) => `${input.kind}:${input.name}`);
}

const NATIVE_FIRST_USE_CONFIG_CHECK = "python3 -B services/keeper/tests/native-first-use-command.test.py";

/** This source-level check imports Keeper's production config parser, so its dependency closure
 * must be installed in both workflows before the check runs. The image workflow should run it
 * before building either image, where the missing host dependency would otherwise waste a build. */
function nativeFirstUseWorkflowErrors(testsWorkflow: any, imageWorkflow: any): string[] {
  const errors: string[] = [];
  const testSteps: any[] = testsWorkflow?.jobs?.test?.steps ?? [];
  const installIndex = testSteps.findIndex((step) => step.name === "Install dependencies");
  const testCheckIndex = testSteps.findIndex((step) => step.run === NATIVE_FIRST_USE_CONFIG_CHECK);
  const keeperTestsIndex = testSteps.findIndex((step) => step.name === "Run tests");
  const testCheck = testSteps[testCheckIndex];
  if (installIndex < 0 || testSteps[installIndex]?.run !== "pnpm install --frozen-lockfile")
    errors.push("ordinary CI must install the frozen full workspace dependency graph");
  if (testCheckIndex < 0 || testCheck?.if !== "matrix.name == 'keeper'")
    errors.push("ordinary CI must run the first-use config check in the Keeper matrix job");
  if (installIndex < 0 || testCheckIndex <= installIndex || keeperTestsIndex < 0 || testCheckIndex >= keeperTestsIndex)
    errors.push("ordinary CI must run the first-use config check after install and before Keeper tests");

  const imageSteps: any[] = imageWorkflow?.jobs?.runtime?.steps ?? [];
  const imageInstallIndex = imageSteps.findIndex((step) => step.name === "Install the exporter and role dependency closures");
  const imageCheckIndex = imageSteps.findIndex((step) => step.run === NATIVE_FIRST_USE_CONFIG_CHECK);
  const imageInstall = imageSteps[imageInstallIndex];
  const imageCheck = imageSteps[imageCheckIndex];
  const firstImageBuildIndex = imageSteps.findIndex((step) => typeof step.uses === "string" && step.uses.startsWith("docker/build-push-action"));
  if (imageInstallIndex < 0 || typeof imageInstall?.run !== "string" ||
      !/pnpm install --frozen-lockfile/.test(imageInstall.run) ||
      !/--filter\s+"?@lares\/keeper\.\.\."?/.test(imageInstall.run))
    errors.push("image CI must install the frozen @lares/keeper dependency closure");
  if (imageCheckIndex < 0 || imageCheck?.if !== "matrix.role == 'chief-of-staff'")
    errors.push("image CI must run the first-use config check in the chief-of-staff job");
  if (imageInstallIndex < 0 || imageCheckIndex <= imageInstallIndex || firstImageBuildIndex < 0 || imageCheckIndex >= firstImageBuildIndex)
    errors.push("image CI must run the first-use config check after install and before image builds");
  return errors;
}

function publicDocsReleaseIdentityErrors(doc: any, job?: any): string[] {
  const input = doc?.on?.workflow_dispatch?.inputs?.docs_release;
  const errors: string[] = [];
  if (input?.type !== "string" || input?.default !== "candidate")
    errors.push("workflow_dispatch must expose docs_release with candidate as its default");
  const identity = job?.env?.PUBLIC_DOCS_RELEASE ?? doc?.env?.PUBLIC_DOCS_RELEASE;
  if (identity !== "${{ github.event_name == 'workflow_dispatch' && inputs.docs_release || 'candidate' }}")
    errors.push("PUBLIC_DOCS_RELEASE must use the validated dispatch identity or candidate");
  return errors;
}

/** Return every generated-docs Docker build (including duplicate build/scan and publish builds)
 *  whose same job does not prepare and verify the generated inputs first. */
function findUncoveredPublicDocsBuilds(): { violations: string[]; examined: number; jobs: Map<string, any> } {
  const violations: string[] = [];
  const jobs = new Map<string, any>();
  let examined = 0;
  for (const wf of readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
    const doc = parse(readFileSync(join(WORKFLOWS_DIR, wf), "utf8"));
    const paths = pushPaths(doc);
    let docsWorkflowExamined = false;
    for (const [jobId, job] of Object.entries<any>(doc.jobs ?? {})) {
      const steps: any[] = Array.isArray(job.steps) ? job.steps : [];
      steps.forEach((step, index) => {
        if (typeof step.uses !== "string" || !step.uses.startsWith("docker/build-push-action")) return;
        const context: string = step.with?.context ?? ".";
        const template: string = step.with?.file ?? posix.join(context, "Dockerfile");
        const files = resolveMatrixFile(template, job);
        const hasGeneratedDocs = files.some((file) => copySources(join(REPO_ROOT, file), context)
          .some(({ src }) => PUBLIC_DOCS_GENERATED_SOURCES.has(src)));
        if (!hasGeneratedDocs) return;
        examined++;
        const key = `${wf}:${jobId}`;
        jobs.set(key, job);
        if (!docsWorkflowExamined) {
          for (const error of publicDocsReleaseIdentityErrors(doc, job)) violations.push(`${wf}: ${error}`);
          docsWorkflowExamined = true;
        }
        for (const error of publicDocsBakeErrors(job, index)) violations.push(`${key}: ${error}`);
        const gaps = publicDocsTrackedInputGaps(paths);
        if (gaps.length) violations.push(`${key}: push.paths does not cover public-docs inputs ${gaps.join(", ")}`);
      });
    }
  }
  return { violations, examined, jobs };
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
        if (PUBLIC_DOCS_GENERATED_SOURCES.has(src)) continue; // separately checked as generated workflow input above
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

  it("bakes and verifies generated public-docs inputs before every role Docker build", () => {
    const { violations, examined } = findUncoveredPublicDocsBuilds();
    expect(examined).toBeGreaterThanOrEqual(6);
    expect(violations).toEqual([]);
  });

  it("rejects a missing or misordered bake and a missing tracked source trigger", () => {
    const { jobs } = findUncoveredPublicDocsBuilds();
    const job = jobs.get("creative-builder.yml:build");
    expect(job).toBeDefined();
    const buildIndex = job.steps.findIndex((step: any) => step.uses?.startsWith("docker/build-push-action"));
    const bake = job.steps.find((step: any) => step.name === PUBLIC_DOCS_BAKE_STEP);
    expect(bake).toBeDefined();
    const withoutBake = { ...job, steps: job.steps.filter((step: any) => step.name !== PUBLIC_DOCS_BAKE_STEP) };
    expect(publicDocsBakeErrors(withoutBake, buildIndex)).toContain("missing bake step before Docker build");
    const afterBuild = { ...job, steps: [...job.steps.filter((step: any) => step.name !== PUBLIC_DOCS_BAKE_STEP), bake] };
    expect(publicDocsBakeErrors(afterBuild, buildIndex)).toContain("missing bake step before Docker build");
    const creative = parse(readFileSync(join(WORKFLOWS_DIR, "creative-builder.yml"), "utf8"));
    expect(publicDocsReleaseIdentityErrors({ ...creative, env: {} })).toContain("PUBLIC_DOCS_RELEASE must use the validated dispatch identity or candidate");
    const paths = pushPaths(parse(readFileSync(join(WORKFLOWS_DIR, "creative-builder.yml"), "utf8")))!;
    expect(publicDocsTrackedInputGaps(paths.filter((path) => path !== "docs/**"))).toContain("directory:docs");
    expect(publicDocsTrackedInputGaps(paths.filter((path) => path !== "scripts/public-docs.ts"))).toContain("file:scripts/public-docs.ts");
  });

  it("installs Keeper dependencies before the first-use config regression in both CI workflows", () => {
    const testsWorkflow = parse(readFileSync(join(WORKFLOWS_DIR, "tests.yml"), "utf8"));
    const imageWorkflow = parse(readFileSync(join(WORKFLOWS_DIR, "keeper-runtime-images.yml"), "utf8"));
    expect(nativeFirstUseWorkflowErrors(testsWorkflow, imageWorkflow)).toEqual([]);

    const imageJob = imageWorkflow.jobs.runtime;
    const install = imageJob.steps.find((step: any) => step.name === "Install the exporter and role dependency closures");
    const withoutKeeper = { ...imageJob, steps: imageJob.steps.map((step: any) => step === install
      ? { ...step, run: step.run.replace(/\s+--filter\s+"@lares\/keeper\.\.\."/, "") }
      : step) };
    expect(nativeFirstUseWorkflowErrors(testsWorkflow, { ...imageWorkflow, jobs: { ...imageWorkflow.jobs, runtime: withoutKeeper } }))
      .toContain("image CI must install the frozen @lares/keeper dependency closure");

    const check = imageJob.steps.find((step: any) => step.run === NATIVE_FIRST_USE_CONFIG_CHECK);
    const afterBuild = { ...imageJob, steps: imageJob.steps.filter((step: any) => step !== check) };
    const buildIndex = afterBuild.steps.findIndex((step: any) => step.uses?.startsWith("docker/build-push-action"));
    afterBuild.steps.splice(buildIndex + 1, 0, check);
    expect(nativeFirstUseWorkflowErrors(testsWorkflow, { ...imageWorkflow, jobs: { ...imageWorkflow.jobs, runtime: afterBuild } }))
      .toContain("image CI must run the first-use config check after install and before image builds");
  });
});

// ── the layer cache of keeper-runtime-images.yml ───────────────────────────────────────────────
// A cached layer is a build step that is not run again. That is only safe for a step whose inputs
// are all pinned (the lockfile, `patches/`, this commit's sources). A final image stage fetches
// operating-system updates with no pin, so it must be built again in every job: the workflow may
// write only BUILD stages to the cache, and every reader must name a cache its one writer writes.

interface CacheStep {
  readonly job: string;
  readonly label: string;
  readonly step: any;
  /** One entry per value the job's matrix gives the step (one entry, the step as written, when
   *  it uses no matrix value). */
  readonly reads: string[];
  readonly writes: string[];
}

const IMAGE_WORKFLOW = "keeper-runtime-images.yml";

/** The `scope=` of a `type=gha` cache argument, with `${{ matrix.role }}` and a
 *  `format('…{0}…', matrix.role)` replaced by each role of the job's matrix, so a matrix job's
 *  cache name can be compared with the name another job spells out. The scope is written last:
 *  its expression holds commas of its own, so nothing after it could be told apart from it. */
function cacheScopes(argument: unknown, job: any): string[] {
  if (typeof argument !== "string") return [];
  expect(argument.startsWith("type=gha,")).toBe(true);
  const scope = argument.match(/,scope=(.+)$/)?.[1];
  expect(scope, `a layer cache must name its scope, last: ${argument}`).toBeTruthy();
  const roles: string[] = /matrix\.role/.test(scope!) ? job?.strategy?.matrix?.role ?? [] : [""];
  return roles.map((role) => scope!
    .replace(/format\('([^']*)\{0\}([^']*)',\s*matrix\.role\)/g, (_m, before, after) => `'${before}${role}${after}'`)
    .replace(/\$\{\{\s*matrix\.role\s*\}\}/g, role));
}

function cacheSteps(): CacheStep[] {
  const doc = parse(readFileSync(join(WORKFLOWS_DIR, IMAGE_WORKFLOW), "utf8"));
  const out: CacheStep[] = [];
  for (const [job, definition] of Object.entries<any>(doc.jobs ?? {})) {
    for (const step of definition.steps ?? []) {
      if (typeof step.uses !== "string" || !step.uses.startsWith("docker/build-push-action")) continue;
      const reads = cacheScopes(step.with?.["cache-from"], definition);
      const writes = cacheScopes(step.with?.["cache-to"], definition);
      if (reads.length || writes.length) out.push({ job, label: step.name ?? step.uses, step, reads, writes });
    }
  }
  return out;
}

/** The instructions of `stage` in a Dockerfile and of every stage it is built `FROM`, comments
 *  left out. Null when the Dockerfile names no such stage. */
function stageInstructions(dockerfile: string, stage: string): string[] | null {
  const stages = new Map<string, { from: string; lines: string[] }>();
  let current: { from: string; lines: string[] } | null = null;
  for (const line of readFileSync(join(REPO_ROOT, dockerfile), "utf8").split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const from = line.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      current = { from: from[1]!, lines: [] };
      if (from[2]) stages.set(from[2], current);
      continue;
    }
    current?.lines.push(line);
  }
  const out: string[] = [];
  for (let name: string | undefined = stage, first = true; name !== undefined; first = false) {
    const found = stages.get(name);
    if (!found) return first ? null : out; // a base image, not a stage of this file
    out.push(...found.lines);
    name = found.from;
  }
  return out;
}

describe("the image workflow's layer cache holds build stages only", () => {
  it("has cache writers and readers to examine", () => {
    const steps = cacheSteps();
    expect(steps.filter((s) => s.writes.length).length).toBeGreaterThanOrEqual(4);
    expect(steps.filter((s) => !s.writes.length).length).toBeGreaterThanOrEqual(4);
  });

  it("writes the cache only from a step that builds a stage with no operating-system package fetch and produces no image", () => {
    const problems: string[] = [];
    for (const { job, label, step, reads, writes } of cacheSteps().filter((s) => s.writes.length)) {
      const where = `${job}: ${label}`;
      const target = step.with?.target;
      const instructions = typeof target === "string" ? stageInstructions(step.with.file, target) : null;
      if (!instructions) { problems.push(`${where}: must name a build stage of its Dockerfile as target`); continue; }
      if (instructions.some((line) => /\b(apt-get|apt|apk|dnf|yum)\b/.test(line)))
        problems.push(`${where}: stage "${target}" fetches operating-system packages and must not be cached`);
      for (const key of ["load", "push", "tags", "outputs"])
        if (step.with?.[key] !== undefined) problems.push(`${where}: a cache-writing step must not set ${key}`);
      if (step.with?.pull !== true) problems.push(`${where}: must resolve base image tags again (pull: true)`);
      if (!/(^|,)mode=max(,|$)/.test(step.with["cache-to"])) problems.push(`${where}: must write every build stage (mode=max)`);
      if (!/(^|,)ignore-error=true(,|$)/.test(step.with["cache-to"])) problems.push(`${where}: a failed cache write must not fail the build (ignore-error=true)`);
      if (JSON.stringify(reads) !== JSON.stringify(writes)) problems.push(`${where}: must read the cache it writes`);
    }
    expect(problems).toEqual([]);
  });

  it("names each cache for the lockfile, patches/ and the Dockerfile it builds", () => {
    const problems: string[] = [];
    for (const { job, label, step, reads, writes } of cacheSteps()) {
      const files = resolveMatrixFile(step.with.file, parse(readFileSync(join(WORKFLOWS_DIR, IMAGE_WORKFLOW), "utf8")).jobs[job]);
      [...reads, ...writes].forEach((scope, index) => {
        const dockerfile = files[index % files.length];
        if (!scope.includes(`hashFiles('pnpm-lock.yaml', 'patches/**', '${dockerfile}')`))
          problems.push(`${job}: ${label}: cache "${scope}" is not named for pnpm-lock.yaml, patches/** and ${dockerfile}`);
      });
    }
    expect(problems).toEqual([]);
  });

  it("reads only a cache that one step of the workflow writes, spelled identically", () => {
    const steps = cacheSteps();
    const written = steps.flatMap((s) => s.writes);
    expect(new Set(written).size).toBe(written.length); // one writer per cache
    const unknown = steps.flatMap((s) => s.reads.filter((scope) => !written.includes(scope)).map((scope) => `${s.job}: ${s.label}: ${scope}`));
    expect(unknown).toEqual([]);
  });

  it("refuses a final stage, a stage that installs system packages and a misspelled reader", () => {
    expect(stageInstructions("services/keeper/Dockerfile", "runtime")!.some((line) => /\bapt-get\b/.test(line))).toBe(true);
    expect(stageInstructions("services/keeper/Dockerfile", "build")!.some((line) => /\bapt-get\b/.test(line))).toBe(false);
    expect(stageInstructions("services/creative/Dockerfile", "compiled-runtime")!.some((line) => line.includes("pnpm install"))).toBe(true);
    expect(stageInstructions("services/keeper/Dockerfile", "no-such-stage")).toBeNull();
    const job = { strategy: { matrix: { role: ["chief-of-staff", "creative"] } } };
    expect(cacheScopes("type=gha,scope=${{ matrix.role }}-build-${{ hashFiles('a', format('services/{0}/Dockerfile', matrix.role)) }}", job))
      .toEqual(["chief-of-staff-build-${{ hashFiles('a', 'services/chief-of-staff/Dockerfile') }}", "creative-build-${{ hashFiles('a', 'services/creative/Dockerfile') }}"]);
  });
});
