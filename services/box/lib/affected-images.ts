/**
 * Which container images can a change affect?
 *
 * Given the repository paths that changed between two commits, this answers, for every image the
 * workflows build, "rebuild" or "keep", each with the reason. It is deliberately one-sided: an
 * image is kept only when every changed path is placed and none of them is an input of that
 * image. Anything this file cannot place, parse or prove rebuilds EVERY image.
 *
 * Nothing uses this yet. No workflow reads its answer.
 *
 * What an image's inputs are, and where each comes from:
 *   - its Dockerfile, and every path that Dockerfile COPYs in the stages its build target reaches
 *     (read from the Dockerfile each time, never restated here);
 *   - the workspace packages its Dockerfile installs or builds (`pnpm ... --filter <name>`), and
 *     everything those depend on through `workspace:` links, transitively (read from the
 *     package.json files each time);
 *   - what `pnpm install` reads: the lockfile, the workspace file, the root package.json and the
 *     patch files it names;
 *   - files a workflow generates into the build context before the build (the public docs
 *     corpus), traced back to the repository paths they are generated from;
 *   - another image of this repository named in a FROM line: it is rebuilt when that one is;
 *   - the workflow file that builds it, and the few paths outside the build context that the
 *     workflows' own `paths:` filters name (the image scanner, the release records).
 *
 * This file imports only Node's own modules and reads the repository only through the
 * RepoReader it is given, so it runs under plain `node` before any install, and tests can hand
 * it a tree that exists only in memory.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Read access to one repository tree. Paths are relative to the repository root, `/`-separated. */
export interface RepoReader {
  /** The file's text, or null when there is no such file. */
  readFile(path: string): string | null;
  /** Names of the directories directly inside a directory; empty when it does not exist. */
  listDirs(path: string): string[];
  /** True when a file or a directory exists at this path. */
  exists(path: string): boolean;
}

/** The working tree at `root`, read from disk. */
export function fsRepoReader(root: string): RepoReader {
  const at = (path: string): string => join(root, ...path.split("/"));
  return {
    readFile(path) {
      try {
        return statSync(at(path)).isFile() ? readFileSync(at(path), "utf8") : null;
      } catch {
        return null;
      }
    },
    listDirs(path) {
      try {
        return readdirSync(at(path), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    exists(path) {
      return existsSync(at(path));
    },
  };
}

/** Thrown when the selector cannot be sure. The caller's only safe answer is "every image". */
export class SelectorUnsure extends Error {}

function unsure(message: string): never {
  throw new SelectorUnsure(message);
}

export interface ImageSpec {
  /** The name this selector reports. */
  readonly id: string;
  /** The name the image is published under, without tag or digest. */
  readonly registry: string;
  readonly dockerfile: string;
  /** The build context: "." is the repository root. */
  readonly context: string;
  /** The stage that is built; null builds the Dockerfile's last stage. */
  readonly target: string | null;
  /** The workflow that builds and publishes it. */
  readonly workflow: string;
}

const REGISTRY = "ghcr.io/heiberg-industries";

/**
 * Every image a workflow of this repository publishes. The tests hold this against the workflow
 * files themselves: an image a workflow publishes that is not listed here fails them, and so does
 * a row here that no workflow publishes.
 */
export const IMAGES: readonly ImageSpec[] = [
  { id: "runtime-base", registry: `${REGISTRY}/lares-runtime-base`, dockerfile: "images/runtime-base/Dockerfile", context: "images/runtime-base", target: null, workflow: ".github/workflows/runtime-base.yml" },
  { id: "chief-of-staff-builder", registry: `${REGISTRY}/lares-chief-of-staff`, dockerfile: "services/chief-of-staff/Dockerfile", context: ".", target: null, workflow: ".github/workflows/chief-of-staff-builder.yml" },
  { id: "creative-builder", registry: `${REGISTRY}/lares-creative`, dockerfile: "services/creative/Dockerfile", context: ".", target: null, workflow: ".github/workflows/creative-builder.yml" },
  { id: "chief-of-staff-runtime", registry: `${REGISTRY}/lares-engine-chief-of-staff-runtime`, dockerfile: "services/chief-of-staff/Dockerfile", context: ".", target: "runtime", workflow: ".github/workflows/keeper-runtime-images.yml" },
  { id: "creative-runtime", registry: `${REGISTRY}/lares-engine-creative-runtime`, dockerfile: "services/creative/Dockerfile", context: ".", target: "runtime", workflow: ".github/workflows/keeper-runtime-images.yml" },
  { id: "console", registry: `${REGISTRY}/lares-engine-console`, dockerfile: "services/console/Dockerfile", context: ".", target: null, workflow: ".github/workflows/console-image.yml" },
  { id: "keeper", registry: `${REGISTRY}/lares-engine-keeper`, dockerfile: "services/keeper/Dockerfile", context: ".", target: null, workflow: ".github/workflows/keeper-runtime-images.yml" },
  { id: "firewall-helper", registry: `${REGISTRY}/lares-engine-firewall-helper`, dockerfile: "images/firewall-helper/Dockerfile", context: ".", target: null, workflow: ".github/workflows/keeper-runtime-images.yml" },
  { id: "egress-proxy", registry: `${REGISTRY}/lares-engine-egress-proxy`, dockerfile: "images/egress-proxy/Dockerfile", context: ".", target: null, workflow: ".github/workflows/keeper-runtime-images.yml" },
  { id: "sync-jobs", registry: `${REGISTRY}/lares-sync-jobs`, dockerfile: "services/sync-jobs/Dockerfile", context: ".", target: null, workflow: ".github/workflows/sync-jobs-image.yml" },
];

/**
 * Dockerfiles in the repository that no workflow builds. They are listed so that a NEW Dockerfile
 * cannot slip in unnoticed: the tests fail on any Dockerfile that is neither an image above nor
 * named here. Their own files are still inputs of whichever image copies them.
 */
export const DOCKERFILES_NO_WORKFLOW_BUILDS: readonly { readonly dockerfile: string; readonly why: string }[] = [
  { dockerfile: "services/readability/Dockerfile", why: "no workflow builds or publishes it, and no release record names it" },
  { dockerfile: "services/slack-relay/Dockerfile", why: "no workflow builds or publishes it, and no release record names it" },
];

/** Workflows that build no image. A workflow file that is neither here nor an image's workflow is an unknown path. */
export const WORKFLOWS_THAT_BUILD_NO_IMAGE: readonly { readonly workflow: string; readonly why: string }[] = [
  { workflow: ".github/workflows/tests.yml", why: "it runs the tests and the typecheck on pull requests; it has no image build step" },
];

/**
 * Paths a Dockerfile COPYs that are not in the repository: a workflow step writes them into the
 * build context first. Each names the repository paths it is generated from, and those become
 * inputs of every image whose Dockerfile copies the generated path.
 *
 * The docs exporter also imports packages/agent-kit; every image that copies the corpus already
 * has that package among its inputs, and the tests check that this stays true.
 */
export const GENERATED_CONTEXT_PATHS: readonly { readonly path: string; readonly what: string; readonly from: readonly string[] }[] = [
  { path: ".public-docs-bake", what: "the public docs corpus", from: ["docs", "scripts/public-docs.ts"] },
];

/**
 * Paths outside every build context that the image workflows' own `paths:` filters name. They do
 * not change an image's files; they change how the image is checked, and a workflow that names
 * one has declared it an input. The tests hold `workflows` against the filters themselves.
 */
export const WORKFLOW_DECLARED_INPUTS: readonly { readonly path: string; readonly workflows: readonly string[]; readonly why: string }[] = [
  {
    path: "scripts/scan-image.sh",
    workflows: [
      ".github/workflows/chief-of-staff-builder.yml",
      ".github/workflows/console-image.yml",
      ".github/workflows/creative-builder.yml",
      ".github/workflows/keeper-runtime-images.yml",
      ".github/workflows/runtime-base.yml",
      ".github/workflows/sync-jobs-image.yml",
    ],
    why: "every image workflow scans its finished image with it",
  },
  {
    path: "releases",
    workflows: [".github/workflows/keeper-runtime-images.yml"],
    why: "that workflow's image proofs read release records",
  },
];

/**
 * Paths proven to be in no image: no Dockerfile names them in a COPY, no workspace package
 * contains them, and no image workflow's `paths:` filter matches them. The tests re-check that
 * proof against the repository, so a rule here stops passing the day it stops being true.
 *
 * They are still inside the build context of the repository root, so an image whose Dockerfile
 * copies that whole context (`COPY . .`) is selected for them all the same; only that is left.
 */
export const IN_NO_IMAGE: readonly { readonly path: string; readonly why: string }[] = [
  { path: "README.md", why: "repository prose" },
  { path: "CHANGELOG.md", why: "repository prose" },
  { path: "CONTRIBUTING.md", why: "repository prose" },
  { path: "CODE_OF_CONDUCT.md", why: "repository prose" },
  { path: "SECURITY.md", why: "repository prose" },
  { path: "THIRD_PARTY_NOTICES.md", why: "repository prose" },
  { path: "LICENSE", why: "repository prose" },
  { path: "AGENTS.md", why: "instructions for coding agents" },
  { path: "CLAUDE.md", why: "instructions for coding agents" },
  { path: ".gitignore", why: "read by git only" },
  { path: ".github/ISSUE_TEMPLATE", why: "issue forms shown by the code host" },
  { path: ".github/pull_request_template.md", why: "the pull request form shown by the code host" },
  { path: "integrations", why: "integration manifests; the code generated from them is committed inside packages/agent-kit, and that is what images carry" },
  { path: "tools", why: "development tools outside the pnpm workspace" },
  { path: "scripts/check-namespace.mjs", why: "a pull request check" },
  { path: "scripts/check-namespace.test.mjs", why: "a pull request check" },
  { path: "scripts/check-prisma-config.mjs", why: "a pull request check" },
  { path: "scripts/rehearsal", why: "scripts run by hand against a server" },
];

/** What `pnpm install` reads from the build context besides the package.json files themselves. */
const INSTALL_FILES: readonly string[] = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", ".npmrc", ".pnpmfile.cjs"];

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** True when `path` is `root` or lies under it. `root` is a file or a directory; "." is everything. */
function isUnder(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(root + "/");
}

function normalisePath(raw: string): string {
  let path = raw.trim();
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) {
    unsure(`"${raw}" is not a path inside the repository`);
  }
  return path;
}

function joinContext(context: string, source: string): string {
  if (source === ".") return context;
  return context === "." ? source : `${context}/${source}`;
}

const GLOB = /[*?[]/;

/** A COPY source with wildcards, matched the way Docker does: `*` and `?` never cross a `/`. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) unsure(`COPY source "${glob}" has an unclosed [`);
      out += glob.slice(i, end + 1);
      i = end;
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}(/|$)`);
}

function sourceCovers(source: string, path: string): boolean {
  return GLOB.test(source) ? globToRegExp(source).test(path) : isUnder(path, source);
}

// ---------------------------------------------------------------------------------------------
// Dockerfiles
// ---------------------------------------------------------------------------------------------

interface DockerCopy {
  readonly from: string | null;
  readonly sources: readonly string[];
  readonly text: string;
}

interface DockerStage {
  readonly name: string | null;
  readonly base: string;
  readonly copies: DockerCopy[];
  readonly runs: string[];
}

/** One instruction per entry: comments dropped, `\` continuations joined. */
function dockerInstructions(text: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // The `# escape=` directive changes what continues a line; nothing here reads that dialect.
    if (/^#\s*escape\s*=/i.test(line)) unsure("a Dockerfile sets its own escape character, which this selector does not read");
    // A comment or an empty line, also between the lines of a continued instruction: Docker skips both.
    if (line.startsWith("#") || line === "") continue;
    const continued = line.endsWith("\\");
    const piece = continued ? line.slice(0, -1).trim() : line;
    current = current === null ? piece : `${current} ${piece}`;
    if (!continued) {
      if (current.trim() !== "") out.push(current.trim());
      current = null;
    }
  }
  if (current !== null && current.trim() !== "") out.push(current.trim());
  return out;
}

function parseCopy(instruction: string, rest: string, dockerfile: string): DockerCopy {
  if (rest.includes("<<")) unsure(`${dockerfile}: "${instruction}" uses a here-document, which this selector does not read`);
  if (rest.includes("$")) unsure(`${dockerfile}: "${instruction}" uses a variable, so its sources are not known here`);
  let from: string | null = null;
  let words: string[];
  const flags: string[] = [];
  let body = rest;
  for (;;) {
    const flag = /^(--\S+)\s+/.exec(body);
    if (!flag) break;
    flags.push(flag[1]!);
    body = body.slice(flag[0].length);
  }
  for (const flag of flags) {
    if (flag.startsWith("--from=")) from = flag.slice("--from=".length);
    else if (!/^--(chmod|chown|link|keep-git-dir|checksum)(=|$)/.test(flag)) {
      unsure(`${dockerfile}: "${instruction}" uses ${flag.split("=")[0]}, which this selector does not understand`);
    }
  }
  if (body.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { unsure(`${dockerfile}: "${instruction}" is not readable`); }
    if (!Array.isArray(parsed) || parsed.some((word) => typeof word !== "string")) unsure(`${dockerfile}: "${instruction}" is not readable`);
    words = parsed as string[];
  } else {
    if (/["']/.test(body)) unsure(`${dockerfile}: "${instruction}" quotes a path, which this selector does not read`);
    words = body.split(/\s+/).filter((word) => word !== "");
  }
  if (words.length < 2) unsure(`${dockerfile}: "${instruction}" names no source`);
  // Sources of a --from copy are paths inside another stage or image, not in the build context.
  if (from !== null) return { from, sources: [], text: instruction };
  const sources = words.slice(0, -1).filter((word) => !/^(https?|git|ssh):\/\/|^git@/.test(word)).map((word) => {
    // Docker reads every source relative to the context root, with or without a leading "/" or "./".
    let source = word.replace(/^(\.?\/)+/, "");
    while (source.endsWith("/")) source = source.slice(0, -1);
    if (source === "" || source === ".") return ".";
    if (source.split("/").some((part) => part === ".." || part === "." || part === "")) unsure(`${dockerfile}: "${instruction}" names a path this selector does not read`);
    return source;
  });
  return { from, sources, text: instruction };
}

function parseDockerfile(text: string, dockerfile: string): DockerStage[] {
  const stages: DockerStage[] = [];
  for (const instruction of dockerInstructions(text)) {
    const match = /^(\S+)\s*(.*)$/s.exec(instruction)!;
    const word = match[1]!.toUpperCase();
    const rest = match[2]!.trim();
    if (word === "FROM") {
      const parts = rest.split(/\s+/).filter((part) => !part.startsWith("--"));
      const base = parts[0];
      if (!base || base.includes("$")) unsure(`${dockerfile}: "${instruction}" does not name a fixed base image`);
      if (parts.length !== 1 && !(parts.length === 3 && parts[1]!.toUpperCase() === "AS")) unsure(`${dockerfile}: "${instruction}" is not readable`);
      stages.push({ name: parts.length === 3 ? parts[2]!.toLowerCase() : null, base, copies: [], runs: [] });
      continue;
    }
    const stage = stages[stages.length - 1];
    if (word === "ARG" && !stage) continue; // a global ARG only matters to a FROM that uses it, which is refused above
    if (!stage) unsure(`${dockerfile}: "${instruction}" comes before any FROM`);
    if (word === "COPY" || word === "ADD") stage.copies.push(parseCopy(instruction, rest, dockerfile));
    else if (word === "RUN") {
      // A bind mount (the default kind) reads files this selector would not see; a cache does not.
      for (const mount of rest.matchAll(/--mount=(\S+)/g)) {
        if (!/(^|,)type=(cache|tmpfs|secret|ssh)(,|$)/.test(mount[1]!)) {
          unsure(`${dockerfile}: a RUN mounts files into the build, which this selector does not follow`);
        }
      }
      stage.runs.push(rest);
    } else if (word === "ONBUILD") unsure(`${dockerfile}: ONBUILD is not something this selector follows`);
  }
  if (stages.length === 0) unsure(`${dockerfile} has no FROM`);
  return stages;
}

/** The stages a build of `target` uses: the target itself and every stage it is FROM or copies from. */
function reachableStages(stages: DockerStage[], target: string | null, dockerfile: string): { stages: DockerStage[]; externalImages: string[] } {
  const indexOf = (reference: string, before: number): number => {
    const lowered = reference.toLowerCase();
    for (let i = before - 1; i >= 0; i -= 1) if (stages[i]!.name === lowered) return i;
    if (/^\d+$/.test(reference) && Number(reference) < before) return Number(reference);
    return -1;
  };
  let start = stages.length - 1;
  if (target !== null) {
    start = stages.findIndex((stage) => stage.name === target.toLowerCase());
    if (start < 0) unsure(`${dockerfile} has no stage named "${target}"`);
  }
  const seen = new Set<number>();
  const externalImages: string[] = [];
  const visit = (index: number): void => {
    if (seen.has(index)) return;
    seen.add(index);
    const stage = stages[index]!;
    const base = indexOf(stage.base, index);
    if (base >= 0) visit(base);
    else externalImages.push(stage.base);
    for (const copy of stage.copies) {
      if (copy.from === null) continue;
      // A --from may name any earlier stage, by name or by number; anything else is an image.
      const from = indexOf(copy.from, stages.length);
      if (from >= 0) visit(from);
      else externalImages.push(copy.from);
    }
  };
  visit(start);
  return { stages: [...seen].sort((a, b) => a - b).map((index) => stages[index]!), externalImages };
}

// ---------------------------------------------------------------------------------------------
// The pnpm workspace
// ---------------------------------------------------------------------------------------------

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  /** Names of the workspace packages it links to, from every dependency section. */
  readonly links: readonly string[];
}

interface Workspace {
  readonly rootName: string;
  readonly packages: readonly WorkspacePackage[];
  /** Patch files the root package.json names, and the directories they are in. */
  readonly patchPaths: readonly string[];
}

function readJson(repo: RepoReader, path: string): Record<string, unknown> {
  const text = repo.readFile(path);
  if (text === null) unsure(`${path} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { unsure(`${path} is not valid JSON`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) unsure(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The `packages:` list of pnpm-workspace.yaml. Only the plain `<dir>/*` form is understood. */
function workspaceGlobs(repo: RepoReader): string[] {
  const text = repo.readFile("pnpm-workspace.yaml");
  if (text === null) unsure("pnpm-workspace.yaml is missing");
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      if (!inPackages && /^packages:/.test(line)) unsure("pnpm-workspace.yaml lists its packages in a form this selector does not read");
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (!item) unsure("pnpm-workspace.yaml lists its packages in a form this selector does not read");
    const glob = item[1]!.trim().replace(/^["']|["']$/g, "");
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/\*$/.test(glob)) unsure(`pnpm-workspace.yaml names "${glob}", a pattern this selector does not read`);
    globs.push(glob);
  }
  if (globs.length === 0) unsure("pnpm-workspace.yaml names no packages");
  return globs;
}

function readWorkspace(repo: RepoReader): Workspace {
  const root = readJson(repo, "package.json");
  const found: { name: string; dir: string; manifest: Record<string, unknown> }[] = [];
  for (const glob of workspaceGlobs(repo)) {
    const parent = glob.slice(0, -2);
    for (const child of [...repo.listDirs(parent)].sort()) {
      const dir = `${parent}/${child}`;
      if (!repo.exists(`${dir}/package.json`)) continue; // a directory with no manifest is not a package
      const manifest = readJson(repo, `${dir}/package.json`);
      if (typeof manifest.name !== "string" || manifest.name === "") unsure(`${dir}/package.json has no name`);
      found.push({ name: manifest.name, dir, manifest });
    }
  }
  const names = new Set<string>();
  for (const pkg of found) {
    if (names.has(pkg.name)) unsure(`two workspace packages are named ${pkg.name}`);
    names.add(pkg.name);
  }
  const packages = found.map((pkg) => {
    const links = new Set<string>();
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(record(pkg.manifest[section]))) {
        if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
        if (!names.has(name)) unsure(`${pkg.dir}/package.json links to ${name}, which is not a workspace package`);
        links.add(name);
      }
    }
    return { name: pkg.name, dir: pkg.dir, links: [...links].sort() };
  });
  const patchPaths = new Set<string>(["patches"]);
  for (const file of Object.values(record(record(root.pnpm).patchedDependencies))) {
    if (typeof file !== "string") unsure("package.json names a patch that is not a file path");
    const path = normalisePath(file);
    patchPaths.add(path);
    if (path.includes("/")) patchPaths.add(path.slice(0, path.lastIndexOf("/")));
  }
  return { rootName: typeof root.name === "string" ? root.name : "", packages, patchPaths: [...patchPaths].sort() };
}

/** For each package in the closure of `roots`: the chain of names that leads to it from a root. */
function closure(workspace: Workspace, roots: readonly string[]): Map<string, string[]> {
  const byName = new Map(workspace.packages.map((pkg) => [pkg.name, pkg]));
  const chains = new Map<string, string[]>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!chains.has(root)) { chains.set(root, [root]); queue.push(root); }
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    for (const link of byName.get(name)!.links) {
      if (chains.has(link)) continue;
      chains.set(link, [...chains.get(name)!, link]);
      queue.push(link);
    }
  }
  return chains;
}

/** The workspace packages a RUN line installs or builds, from the `--filter` arguments of its pnpm commands. */
function filteredPackages(run: string, workspace: Workspace, dockerfile: string): { roots: string[]; installs: boolean } {
  const roots: string[] = [];
  let installs = false;
  for (const command of run.split(/&&|\|\||[;|]/)) {
    if (!/\bpnpm\s/.test(command)) continue; // `pnpm@9.15.0`, as corepack is given it, is not a pnpm command
    const installing = /\bpnpm\s(.*\s)?(install|i)(\s|$)/.test(command);
    installs = installs || installing;
    const filters = [...command.matchAll(/(?:--filter|-F)(?:=|\s+)(\S+)/g)].map((match) => match[1]!.replace(/^["']|["']$/g, ""));
    for (const filter of filters) {
      // Only `<name>` and `<name>...` (the package and what it depends on) are understood.
      const name = filter.replace(/\.\.\.$/, "");
      if (name === workspace.rootName) continue; // the root package: no workspace package comes with it
      if (!workspace.packages.some((pkg) => pkg.name === name)) {
        unsure(`${dockerfile}: --filter ${filter} does not name a workspace package this selector knows`);
      }
      roots.push(name);
    }
    // An install with no filter, or a recursive run, touches every package.
    if ((installing && filters.length === 0) || /\s(-r|--recursive)(\s|$)/.test(command)) {
      roots.push(...workspace.packages.map((pkg) => pkg.name));
    }
  }
  return { roots, installs };
}

// ---------------------------------------------------------------------------------------------
// The model: every image with its inputs
// ---------------------------------------------------------------------------------------------

/** How a path comes to be an input of an image. */
export type InputKind =
  | "dockerfile"
  | "dockerignore"
  | "copy"
  | "whole-context"
  | "generated"
  | "workspace"
  | "install"
  | "workflow"
  | "workflow-declared";

export interface ImageInput {
  /** A file or a directory (everything under it); may hold Docker wildcards when `kind` is "copy". */
  readonly path: string;
  readonly kind: InputKind;
  /** The second half of a sentence that starts with the changed file's name. */
  readonly because: string;
}

export interface ImageModel extends ImageSpec {
  readonly inputs: readonly ImageInput[];
  /** Ids of images of this repository that this one is built FROM (or copies from). */
  readonly builtFrom: readonly string[];
  /** Names of the workspace packages installed or built into it, with everything they link to. */
  readonly workspacePackages: readonly string[];
}

export interface Model {
  readonly images: readonly ImageModel[];
  readonly workspace: readonly WorkspacePackage[];
}

function imageName(reference: string): string {
  const withoutDigest = reference.split("@")[0]!;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.indexOf(":", lastSlash + 1);
  return (colon < 0 ? withoutDigest : withoutDigest.slice(0, colon)).toLowerCase();
}

/**
 * Reads the Dockerfiles and the package manifests and works out every image's inputs.
 * Throws SelectorUnsure when anything in them is not understood.
 */
export function describeImages(repo: RepoReader, images: readonly ImageSpec[] = IMAGES): Model {
  const workspace = readWorkspace(repo);
  const byName = new Map(workspace.packages.map((pkg) => [pkg.name, pkg]));
  const ids = new Set<string>();
  for (const image of images) {
    if (ids.has(image.id)) unsure(`two images are called ${image.id}`);
    ids.add(image.id);
  }

  const models = images.map((image): ImageModel => {
    const text = repo.readFile(image.dockerfile);
    if (text === null) unsure(`${image.dockerfile} is missing`);
    const { stages, externalImages } = reachableStages(parseDockerfile(text, image.dockerfile), image.target, image.dockerfile);
    const inputs: ImageInput[] = [];
    const add = (path: string, kind: InputKind, because: string): void => {
      if (!inputs.some((input) => input.path === path && input.kind === kind)) inputs.push({ path, kind, because });
    };

    add(image.dockerfile, "dockerfile", `is the Dockerfile ${image.id} is built from`);
    add(joinContext(image.context, ".dockerignore"), "dockerignore", `decides what enters the build context of ${image.dockerfile}`);
    add(`${image.dockerfile}.dockerignore`, "dockerignore", `decides what enters the build context of ${image.dockerfile}`);
    add(image.workflow, "workflow", `is the workflow that builds ${image.id}`);

    for (const stage of stages) {
      for (const copy of stage.copies) {
        if (copy.from !== null) continue; // from another stage or image, not from the build context
        for (const source of copy.sources) {
          const path = joinContext(image.context, source);
          if (source === ".") {
            add(path, "whole-context", `is inside the build context that ${image.dockerfile} copies whole ("${copy.text}")`);
            continue;
          }
          const generated = GENERATED_CONTEXT_PATHS.find((entry) => isUnder(path, entry.path) || isUnder(entry.path, path));
          if (generated) {
            for (const from of generated.from) {
              add(from, "generated", `belongs to the sources of ${generated.what} (${generated.path}), which a workflow step writes before the build and ${image.dockerfile} copies`);
            }
            continue;
          }
          if (!GLOB.test(path) && !repo.exists(path)) {
            unsure(`${image.dockerfile} copies ${path}, which is neither in the repository nor a known generated path`);
          }
          add(path, "copy", `is copied into the image by ${image.dockerfile} ("${copy.text}")`);
        }
      }
    }

    const roots: string[] = [];
    let installs = false;
    for (const stage of stages) {
      for (const run of stage.runs) {
        const found = filteredPackages(run, workspace, image.dockerfile);
        roots.push(...found.roots);
        installs = installs || found.installs;
      }
    }
    if (installs && image.context !== ".") unsure(`${image.dockerfile} runs pnpm install outside the repository root context`);
    const chains = closure(workspace, [...new Set(roots)]);
    for (const [name, chain] of chains) {
      const how = chain.length === 1
        ? `is in ${name}, which ${image.dockerfile} installs or builds`
        : `is in ${name}, which ${chain[0]} depends on (${chain.join(" -> ")}); ${image.dockerfile} installs or builds ${chain[0]}`;
      add(byName.get(name)!.dir, "workspace", how);
    }
    if (installs) {
      for (const file of INSTALL_FILES) add(file, "install", `is read by the pnpm install in ${image.dockerfile}`);
      for (const patch of workspace.patchPaths) add(patch, "install", `is a patch the pnpm install in ${image.dockerfile} applies`);
    }

    for (const declared of WORKFLOW_DECLARED_INPUTS) {
      if (declared.workflows.includes(image.workflow)) add(declared.path, "workflow-declared", `is named as an input by ${image.workflow}, which builds ${image.id} (${declared.why})`);
    }

    const builtFrom = [...new Set(externalImages.map(imageName))]
      .map((name) => images.find((other) => other.registry.toLowerCase() === name))
      .filter((other): other is ImageSpec => other !== undefined && other.id !== image.id)
      .map((other) => other.id);

    return { ...image, inputs, builtFrom, workspacePackages: [...chains.keys()].sort() };
  });

  return { images: models, workspace: workspace.packages };
}

// ---------------------------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------------------------

export interface ImageDecision {
  readonly image: string;
  readonly rebuild: boolean;
  /** One sentence: the first reason, and how many more there are. */
  readonly reason: string;
  /** Every reason, one per changed file that is an input of this image. */
  readonly reasons: readonly string[];
  readonly registry: string;
  readonly dockerfile: string;
  readonly target: string | null;
  readonly workflow: string;
}

export interface Selection {
  /** True when every image must be rebuilt because the selector could not be sure. */
  readonly all: boolean;
  /** Why `all` is true: the unknown paths, or what could not be read. Null otherwise. */
  readonly allBecause: string | null;
  readonly changed: readonly string[];
  /** Changed paths no rule could place. Any one of them rebuilds every image. */
  readonly unknownPaths: readonly string[];
  readonly images: readonly ImageDecision[];
}

/** Inputs that say something specific about a path. A whole-context copy says nothing about any one path. */
function isSpecific(input: ImageInput): boolean {
  return input.kind !== "whole-context";
}

function inputCovers(input: ImageInput, path: string): boolean {
  return input.kind === "copy" ? sourceCovers(input.path, path) : isUnder(path, input.path);
}

function summary(reasons: readonly string[]): string {
  if (reasons.length === 0) return "no changed file is an input of this image";
  return reasons.length === 1 ? reasons[0]! : `${reasons[0]} (and ${reasons.length - 1} more)`;
}

function decision(image: ImageSpec, reasons: readonly string[]): ImageDecision {
  return {
    image: image.id,
    rebuild: reasons.length > 0,
    reason: summary(reasons),
    reasons,
    registry: image.registry,
    dockerfile: image.dockerfile,
    target: image.target,
    workflow: image.workflow,
  };
}

/**
 * The answer for one list of changed paths. Throws SelectorUnsure when it cannot be sure;
 * `selectAffectedImagesOrAll` turns that into "every image".
 */
export function selectAffectedImages(changedPaths: readonly string[], repo: RepoReader, images: readonly ImageSpec[] = IMAGES): Selection {
  const changed = [...new Set(changedPaths.filter((path) => path.trim() !== "").map(normalisePath))].sort();
  // Nothing changed, so nothing is rebuilt; there is nothing to read the repository for.
  if (changed.length === 0) return { all: false, allBecause: null, changed, unknownPaths: [], images: images.map((image) => decision(image, [])) };
  const model = describeImages(repo, images);
  const reasons = new Map<string, string[]>(model.images.map((image) => [image.id, []]));
  const unknownPaths: string[] = [];

  for (const path of changed) {
    let placed = IN_NO_IMAGE.some((rule) => isUnder(path, rule.path))
      || WORKFLOWS_THAT_BUILD_NO_IMAGE.some((rule) => path === rule.workflow);
    for (const image of model.images) {
      const covering = image.inputs.filter((input) => inputCovers(input, path));
      const specific = covering.find(isSpecific);
      if (specific) placed = true;
      const first = specific ?? covering[0];
      if (first) reasons.get(image.id)!.push(`${path} ${first.because}`);
    }
    if (!placed) unknownPaths.push(path);
  }

  if (unknownPaths.length > 0) {
    const allBecause = `unknown path: ${unknownPaths.join(", ")} (no rule places ${unknownPaths.length === 1 ? "it" : "them"}, so every image is rebuilt)`;
    return {
      all: true,
      allBecause,
      changed,
      unknownPaths,
      images: model.images.map((image) => decision(image, [allBecause, ...reasons.get(image.id)!])),
    };
  }

  // An image built FROM another image of this repository is rebuilt whenever that one is.
  for (let again = true; again; ) {
    again = false;
    for (const image of model.images) {
      if (reasons.get(image.id)!.length > 0) continue;
      const base = image.builtFrom.find((id) => reasons.get(id)!.length > 0);
      if (base === undefined) continue;
      reasons.get(image.id)!.push(`${image.dockerfile} is built FROM ${base}, which is rebuilt (${reasons.get(base)![0]})`);
      again = true;
    }
  }

  return { all: false, allBecause: null, changed, unknownPaths: [], images: model.images.map((image) => decision(image, reasons.get(image.id)!)) };
}

/** Every image, rebuilt, for one stated reason. Needs nothing from the repository. */
export function everyImage(because: string, changedPaths: readonly string[] = [], images: readonly ImageSpec[] = IMAGES): Selection {
  return {
    all: true,
    allBecause: because,
    changed: [...changedPaths],
    unknownPaths: [],
    images: images.map((image) => decision(image, [because])),
  };
}

/** `selectAffectedImages`, except that anything it cannot be sure about answers "every image". */
export function selectAffectedImagesOrAll(changedPaths: readonly string[], repo: RepoReader, images: readonly ImageSpec[] = IMAGES): Selection {
  try {
    return selectAffectedImages(changedPaths, repo, images);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return everyImage(`the selector could not be sure, so every image is rebuilt: ${message}`, changedPaths, images);
  }
}
