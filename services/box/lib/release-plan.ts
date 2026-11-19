/**
 * Which images does a new test release have to build, and which does it carry over?
 *
 * The question is asked per image, against the commit THAT image was last built from (the
 * `sources` of the previous release record), not against one shared base: an image kept for three
 * releases in a row is compared with the commit it really came from. Anything this file cannot
 * establish builds the image: no recorded source, a selector that fails or answers something odd,
 * an image missing from its answer. "Keep" needs a whole, readable answer for exactly that image.
 *
 * Pure: the selector is passed in as a function, so the tests need no git and no process.
 */
import type { ReleaseManifest } from "./release-manifest.js";

/** One image this repository builds, by its key in a release record and by the selector's id. */
export interface PublishedImage {
  /** The key in a release record's `images`. */
  readonly key: string;
  /** The id the selector (lib/affected-images.ts) reports. */
  readonly id: string;
  /** The flag the keeper-and-runtime workflow reads, or null for an image another workflow builds. */
  readonly flag: "chiefRuntime" | "creativeRuntime" | "keeper" | "firewallHelper" | "egressProxy" | null;
  /** The workflow group that builds it. */
  readonly group: "keeper-runtime" | "console" | "sync-jobs";
}

export const PUBLISHED_IMAGES: readonly PublishedImage[] = [
  { key: "console", id: "console", flag: null, group: "console" },
  { key: "lares-keeper", id: "keeper", flag: "keeper", group: "keeper-runtime" },
  { key: "lares-egress-proxy", id: "egress-proxy", flag: "egressProxy", group: "keeper-runtime" },
  { key: "lares-firewall-helper", id: "firewall-helper", flag: "firewallHelper", group: "keeper-runtime" },
  { key: "chief-of-staff", id: "chief-of-staff-runtime", flag: "chiefRuntime", group: "keeper-runtime" },
  { key: "creative", id: "creative-runtime", flag: "creativeRuntime", group: "keeper-runtime" },
  { key: "sync-jobs", id: "sync-jobs", flag: null, group: "sync-jobs" },
];

/** Images other people build. They are carried over from the previous record, never rebuilt here. */
export const THIRD_PARTY_KEYS: readonly string[] = ["db", "lares-gateway", "caddy"];

/** What the selector says about one image for one pair of commits. */
export interface Verdict {
  readonly rebuild: boolean;
  readonly reason: string;
}

/**
 * Asks the selector about `base` .. head. Returns a verdict for every image id it was asked
 * about, or throws. The caller turns a throw into "build".
 */
export type Ask = (base: string) => ReadonlyMap<string, Verdict>;

export interface PlanRow {
  readonly key: string;
  readonly id: string;
  readonly action: "build" | "carry";
  /** The commit compared with, or null when nothing was compared. */
  readonly base: string | null;
  readonly reason: string;
}

const COMMIT = /^[a-f0-9]{40}$/;

export interface PlanInput {
  readonly previous: ReleaseManifest;
  /** The commit this release is built from. */
  readonly head: string;
  /** Used for an image the previous record gives no source for. Empty: such an image is built. */
  readonly fallbackBase: string;
  readonly ask: Ask;
}

/** One row per image this repository builds, in PUBLISHED_IMAGES order. */
export function planRelease(input: PlanInput): PlanRow[] {
  const answers = new Map<string, ReadonlyMap<string, Verdict> | Error>();
  const answerFor = (base: string): ReadonlyMap<string, Verdict> | Error => {
    if (!answers.has(base)) {
      try {
        answers.set(base, input.ask(base));
      } catch (error) {
        answers.set(base, error instanceof Error ? error : new Error(String(error)));
      }
    }
    return answers.get(base)!;
  };

  return PUBLISHED_IMAGES.map(({ key, id }): PlanRow => {
    const build = (reason: string, base: string | null = null): PlanRow => ({ key, id, action: "build", base, reason });
    if (!COMMIT.test(input.head)) return build("no full head commit was given, so nothing can be compared");
    if (input.previous.images[key] === undefined) return build("the previous release has no image for it");
    const recorded = input.previous.sources?.[key];
    const base = recorded ?? (input.fallbackBase === "" ? undefined : input.fallbackBase);
    if (base === undefined) return build("the previous release records no source commit for this image, so nothing can be compared");
    if (!COMMIT.test(base)) return build(`the base "${base}" is not a full commit id`);
    if (base === input.head) return build("the previous release was built from this very commit, so there is nothing to compare; it is built again", base);
    const answer = answerFor(base);
    if (answer instanceof Error) return build(`the selector could not answer for ${base}: ${answer.message}`, base);
    const verdict = answer.get(id);
    if (verdict === undefined) return build(`the selector's answer for ${base} does not name this image`, base);
    if (verdict.rebuild) return build(verdict.reason, base);
    return { key, id, action: "carry", base, reason: verdict.reason };
  });
}

/** The flags the keeper-and-runtime workflow reads, as the `selection` it is given. */
export function selectionFor(rows: readonly PlanRow[]): Record<string, boolean> {
  // `all` is false because every image has its own answer; a plan that builds all of them says so in the flags.
  const flags: Record<string, boolean> = { all: false };
  for (const image of PUBLISHED_IMAGES) {
    if (image.flag === null) continue;
    flags[image.flag] = rows.find((row) => row.key === image.key)!.action === "build";
  }
  flags.anyKeeperFamily = flags.keeper === true || flags.firewallHelper === true || flags.egressProxy === true;
  return flags;
}

/** True when the plan builds at least one image of this workflow group. */
export function groupBuilds(rows: readonly PlanRow[], group: PublishedImage["group"]): boolean {
  return PUBLISHED_IMAGES.some((image) => image.group === group && rows.find((row) => row.key === image.key)!.action === "build");
}

/** One image a publishing run pushed, as the workflows write it down. */
export interface PublishedDigest {
  readonly key: string;
  /** The full reference by digest, e.g. `ghcr.io/example/image@sha256:...`. */
  readonly reference: string;
  /** The full commit the run built it from. */
  readonly sourceCommit: string;
}

export class RecordNotReady extends Error {}

/**
 * The images and sources of the new record: a digest from this run for every image the plan
 * builds, the previous digest for every image it carries over, each with the commit it was REALLY
 * built from. Throws RecordNotReady when a built image has no digest, has two, or has one that was
 * built from another commit: a record is never written from part of a release.
 */
export function assembleImages(
  previous: ReleaseManifest,
  rows: readonly PlanRow[],
  digests: readonly PublishedDigest[],
  head: string,
): { images: Record<string, string>; sources: Record<string, string> } {
  const images: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [key, reference] of Object.entries(previous.images)) {
    if (THIRD_PARTY_KEYS.includes(key)) images[key] = reference;
  }
  for (const row of rows) {
    if (row.action === "carry") {
      const reference = previous.images[row.key];
      const source = previous.sources?.[row.key] ?? row.base;
      if (reference === undefined || source === null || !COMMIT.test(source)) {
        throw new RecordNotReady(`${row.key}: cannot carry it over, the previous release names no image or no source commit for it`);
      }
      images[row.key] = reference;
      sources[row.key] = source;
      continue;
    }
    const found = digests.filter((digest) => digest.key === row.key);
    if (found.length !== 1) throw new RecordNotReady(`${row.key}: this run was to build it, and ${found.length === 0 ? "no digest was written down for it" : `${found.length} digests were written down for it`}`);
    const digest = found[0]!;
    if (digest.sourceCommit !== head) throw new RecordNotReady(`${row.key}: its digest says it was built from ${digest.sourceCommit}, not from ${head}`);
    images[row.key] = digest.reference;
    sources[row.key] = digest.sourceCommit;
  }
  for (const digest of digests) {
    if (!rows.some((row) => row.key === digest.key && row.action === "build")) {
      throw new RecordNotReady(`${digest.key}: a digest was written down for an image this run was not to build`);
    }
  }
  return { images, sources };
}
