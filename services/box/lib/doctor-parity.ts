// services/box/lib/doctor-parity.ts — the "parity" check of `lares doctor`: does this server run
// exactly the published release, and nothing extra?
//
// PURE. Everything it needs is handed in as plain data (the release record, a list of running
// containers, the parsed keeper.json and the installer's record of what it rendered). The host
// side of `lares doctor` gathers the container list, because the engine container that runs the
// doctor has no container runtime and must not get one. Nothing here reads a file or a socket.
//
// NEVER A VALUE. keeper.json can name secret files and hold secrets' paths. The installer's record
// keeps only a hash per setting, and this check prints key paths and container names, never a value.
import { createHash } from "node:crypto";
import type { CheckResult } from "./doctor.js";
import type { ReleaseManifest } from "./release-manifest.js";

/** One running container, as the host side of `lares doctor` listed it. */
export interface ContainerRow {
  readonly name: string;
  readonly project: string; // compose project label, "" when the container is not compose-made
  readonly service: string; // compose service label
  readonly image: string; // the image reference the container was started from
  /** Files bind-mounted into the container (paths inside it) that were replaced on the host after
   *  it started, so it still reads the old ones. null when the host could not look; absent when
   *  not reported. */
  readonly replacedFiles?: readonly string[] | null;
}

/** What the installer records next to keeper.json each time it renders it. */
export interface ProvenanceRecord {
  readonly version: 1;
  readonly leaves: Readonly<Record<string, string>>; // setting path -> sha256 of its JSON value
}

export interface ParityInput {
  readonly release: ReleaseManifest | null;
  readonly containers: readonly ContainerRow[] | null;
  readonly projects: readonly string[];
  readonly keeperConfig: unknown;
  readonly keeperConfigPresent: boolean;
  readonly rendered: ProvenanceRecord | null;
}

/** keeper.json parts that a shipped Lares command (not the installer's render) writes later, on
 *  purpose. Each key is listed ONLY because a command we ship writes it; a key that only a
 *  documented hand step writes is not listed, so parity flags it.
 *    budgetFinancial, budgetNative, gatewayBudget  ops/budget-commands.py (`lares budget setup`)
 *    lifecycle.runtime.google                      ops/configure-google-keeper.py
 *  No shipped command writes `outsideCustody`, `lifecycle.egress.legacyConsumers` or
 *  `lifecycle.runtime.microsoft` (they are set by an operator by hand), so they are not listed. */
export const TOOL_MANAGED_PREFIXES: readonly string[] = [
  "budgetFinancial",
  "budgetNative",
  "gatewayBudget",
  "lifecycle.runtime.google",
];

/** The services the installer stack and the keeper's own compose file define, and the release
 *  image each must run. Agent containers (`lares-<name>`) are checked against the role images. */
const FIXED_SERVICES: Readonly<Record<string, string>> = {
  db: "db",
  console: "console",
  caddy: "caddy",
  "lares-gateway": "lares-gateway",
  "lares-keeper": "lares-keeper",
  "lares-egress-proxy": "lares-egress-proxy",
};
const ROLE_IMAGES = ["chief-of-staff", "creative"] as const;

const MAX_LISTED = 20;

function digestOf(reference: string): string | null {
  const match = /@(sha256:[a-f0-9]{64})$/.exec(reference);
  return match ? match[1]! : null;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every setting in an object as `path -> value`. An object or array is walked; an empty one, and
 *  everything else, is a single setting. Paths look like `a.b[0].c`. */
export function flattenSettings(value: unknown, path = "", into: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flattenSettings(child, path === "" ? key : `${path}.${key}`, into);
  } else if (Array.isArray(value) && value.length > 0) {
    value.forEach((child, index) => flattenSettings(child, `${path}[${index}]`, into));
  } else {
    into.set(path, value);
  }
  return into;
}

/** What the installer writes next to keeper.json: a hash per setting it rendered. */
export function provenanceRecord(rendered: unknown): ProvenanceRecord {
  const leaves: Record<string, string> = {};
  for (const [path, value] of flattenSettings(rendered)) leaves[path] = hashValue(value);
  return { version: 1, leaves };
}

export function parseProvenanceRecord(text: string): ProvenanceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.leaves)) return null;
  const leaves: Record<string, string> = {};
  for (const [path, hash] of Object.entries(parsed.leaves)) {
    if (typeof hash !== "string") return null;
    leaves[path] = hash;
  }
  return { version: 1, leaves };
}

function isToolManaged(path: string): boolean {
  return TOOL_MANAGED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`));
}

function prefixesOf(path: string): string[] {
  const out: string[] = [];
  const re = /[.[]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) out.push(path.slice(0, match.index));
  out.push(path);
  return out;
}

/** Key paths in keeper.json that the installer did not render (and no Lares command owns). */
export function keeperConfigDifferences(config: unknown, record: ProvenanceRecord): string[] {
  const known = new Set<string>();
  for (const path of Object.keys(record.leaves)) for (const prefix of prefixesOf(path)) known.add(prefix);
  const found = new Set<string>();
  for (const [path, value] of flattenSettings(config)) {
    if (isToolManaged(path)) continue;
    const recorded = record.leaves[path];
    if (recorded === hashValue(value)) continue;
    if (recorded !== undefined) {
      found.add(path);
      continue;
    }
    // A setting the installer never rendered: report the top-most new key, not every leaf under it.
    const novel = prefixesOf(path).find((prefix) => !known.has(prefix)) ?? path;
    found.add(novel);
  }
  return [...found].sort();
}

function containerDifferences(release: ReleaseManifest, containers: readonly ContainerRow[], projects: readonly string[]): string[] {
  const lines: string[] = [];
  const roleDigests = new Set(ROLE_IMAGES.map((role) => digestOf(release.images[role] ?? "")).filter((d): d is string => d !== null));
  for (const c of containers) {
    if (!projects.includes(c.project)) continue;
    const label = `${c.service || c.name}`;
    const actual = digestOf(c.image);
    const fixed = FIXED_SERVICES[c.service];
    if (fixed !== undefined) {
      const wanted = digestOf(release.images[fixed] ?? "");
      if (wanted === null) {
        lines.push(`${label}: this release names no image for it, but it is running`);
      } else if (actual !== wanted) {
        lines.push(`${label}: runs ${actual === null ? "an image that is not pinned by digest" : "a different image"} than release ${release.release} names`);
      }
    } else if (c.service.startsWith("lares-")) {
      if (actual === null || !roleDigests.has(actual)) lines.push(`${label}: an agent container whose image is none of the release's agent images`);
    } else {
      lines.push(`${label}: a container the release does not define`);
    }
    // Same image, old files: an installer re-run replaces a file such a container reads, and the
    // container keeps the old one until it is recreated (the gateway's code, 6 Nov).
    const replaced = c.replacedFiles ?? [];
    if (replaced.length > 0) {
      lines.push(`${label}: still reads ${replaced.length === 1 ? "a file" : `${replaced.length} files`} replaced since it started (${replaced.join(", ")}); it runs the old ${replaced.length === 1 ? "one" : "ones"} until it is recreated`);
    }
  }
  return lines;
}

function uncheckedFiles(containers: readonly ContainerRow[], projects: readonly string[]): string[] {
  const names = containers.filter((c) => projects.includes(c.project) && c.replacedFiles === null).map((c) => c.service || c.name);
  return names.length === 0 ? [] : [`whether ${names.join(", ")} still ${names.length === 1 ? "reads" : "read"} replaced files (run lares doctor with sudo)`];
}

function capped(items: readonly string[]): string[] {
  return items.length <= MAX_LISTED ? [...items] : [...items.slice(0, MAX_LISTED), `...and ${items.length - MAX_LISTED} more`];
}

export function checkParity(input: ParityInput): CheckResult {
  const differences: string[] = [];
  const unknowns: string[] = [];

  if (input.release === null) unknowns.push("the installed release record could not be read");
  if (input.containers === null) unknowns.push("the running containers could not be listed");
  if (input.release !== null && input.containers !== null) {
    differences.push(...containerDifferences(input.release, input.containers, input.projects));
  }
  if (input.containers !== null) unknowns.push(...uncheckedFiles(input.containers, input.projects));

  if (!input.keeperConfigPresent) {
    unknowns.push("keeper.json could not be read");
  } else if (input.rendered === null) {
    unknowns.push("the installer's record of keeper.json is missing, so hand-made changes cannot be told apart (run the installer again to record it)");
  } else {
    for (const path of keeperConfigDifferences(input.keeperConfig, input.rendered)) {
      differences.push(`keeper.json: ${path} was not written by the installer`);
    }
  }

  const releaseName = input.release?.release ?? "the installed release";
  if (differences.length > 0) {
    const lines = capped(differences).map((d) => `- ${d}`);
    return {
      id: "parity",
      state: "fail",
      say: `This server differs from release ${releaseName} in ${differences.length} place${differences.length === 1 ? "" : "s"}.`,
      fix: [
        ...lines,
        ...unknowns.map((u) => `- not checked: ${u}`),
        "Remove each difference (stop the extra container, run the installer again, restart an agent with sudo lares agent refresh, or undo the hand edit), then run: lares doctor",
      ].join("\n"),
    };
  }
  if (unknowns.length > 0) {
    return {
      id: "parity",
      state: "warn",
      say: `No difference from release ${releaseName} was found, but not everything could be checked.`,
      fix: unknowns.map((u) => `- ${u}`).join("\n"),
    };
  }
  return { id: "parity", state: "ok", say: `This server runs exactly release ${releaseName}, with nothing extra.`, fix: null };
}
