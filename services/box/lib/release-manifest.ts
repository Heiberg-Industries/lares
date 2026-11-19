/**
 * A release is a list of full image digests, or it is refused. Nothing here pulls an image,
 * talks to a registry, or touches a server — parsing and validation only.
 */

export interface ReleaseManifest {
  readonly release: string; // "2026-10-01" — the dated release (ADR-0021 rule 1)
  readonly images: Readonly<Record<string, string>>; // service -> full digest reference
  readonly migrations: { readonly box: string; readonly chiefOfStaff?: string }; // last file each
  readonly breaking: readonly string[]; // one sentence per breaking change
  /**
   * Optional provenance, written by the publish workflow: for each image built by this
   * repository, the full commit it was built from. An image carried over unchanged from an
   * earlier release keeps the commit that release recorded for it, so a digest is never
   * labelled with a commit it was not built from. Releases written by hand have none.
   */
  readonly sources?: Readonly<Record<string, string>>;
}

export class ReleaseManifestInvalid extends Error {}

/**
 * The same rule `compose-agents.ts`'s `DIGEST` enforces, restated here so the installer can
 * refuse early, before any image is pulled. `services/keeper/lib/compose-agents.ts`'s `DIGEST`
 * is the source of truth; this must agree with it in shape.
 */
export const DIGEST_REFERENCE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new ReleaseManifestInvalid(message);
}

/** Throws ReleaseManifestInvalid with a readable sentence. Never returns a partial manifest. */
export function parseReleaseManifest(text: string): ReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("A release file must be JSON. This one is not.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("A release file must be a single JSON object.");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.release !== "string" || obj.release.trim().length === 0) {
    fail("A release file must name its release.");
  }

  if (typeof obj.images !== "object" || obj.images === null || Array.isArray(obj.images)) {
    fail("A release file must list its images.");
  }
  const images = obj.images as Record<string, unknown>;
  const imageNames = Object.keys(images);
  if (imageNames.length === 0) {
    fail("A release file must name at least one image.");
  }
  const checkedImages: Record<string, string> = {};
  for (const service of imageNames) {
    const value = images[service];
    if (typeof value !== "string") {
      fail(`The image for "${service}" must be a digest reference.`);
    }
    if (!DIGEST_REFERENCE.test(value)) {
      fail(
        `The image for "${service}" must be named by digest (name@sha256:<64 hex>), not "${value}".`,
      );
    }
    checkedImages[service] = value;
  }

  if (typeof obj.migrations !== "object" || obj.migrations === null || Array.isArray(obj.migrations)) {
    fail("A release file must name its migrations.");
  }
  const migrations = obj.migrations as Record<string, unknown>;
  if (typeof migrations.box !== "string" || migrations.box.trim().length === 0) {
    fail("A release file must name the box migration it ends on.");
  }
  const chiefOfStaff = migrations["chiefOfStaff"];
  if (chiefOfStaff !== undefined && typeof chiefOfStaff !== "string") {
    fail("The chief-of-staff migration, if named, must be a string.");
  }

  if (!Array.isArray(obj.breaking) || obj.breaking.some((s) => typeof s !== "string")) {
    fail("A release file must list its breaking changes as sentences, or as an empty list.");
  }

  let sources: Record<string, string> | undefined;
  if (obj.sources !== undefined) {
    if (typeof obj.sources !== "object" || obj.sources === null || Array.isArray(obj.sources)) {
      fail("The sources of a release file must map an image to the commit it was built from.");
    }
    sources = {};
    for (const [service, commit] of Object.entries(obj.sources as Record<string, unknown>)) {
      if (!(service in checkedImages)) fail(`The release file gives a source for "${service}", which is not one of its images.`);
      if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) {
        fail(`The source of "${service}" must be a full 40-character commit id.`);
      }
      sources[service] = commit;
    }
  }

  return {
    release: obj.release,
    images: checkedImages,
    migrations:
      chiefOfStaff === undefined
        ? { box: migrations.box }
        : { box: migrations.box, chiefOfStaff },
    breaking: obj.breaking as readonly string[],
    ...(sources === undefined ? {} : { sources }),
  };
}

export function imageFor(manifest: ReleaseManifest, service: string): string {
  const image = manifest.images[service];
  if (image === undefined) {
    fail(`This release names no image for "${service}".`);
  }
  return image;
}
