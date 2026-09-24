// One manifest per integration (ADR-0019 decision 6): the single source that `connections.ts`,
// the capability docs' vendor/region fields, the console's Connections rows and the outbound
// proxy allow-list are all generated from. This module owns the SHAPE and a loader that refuses
// anything it cannot trust — generation is a later slice's job.
//
// Deliberately STRICT, on the same reasoning as `manifest.ts`'s `manifestSchema`: a misspelled
// key here is silent drift in a generated file (a missing egress host, an unlisted secret) with
// no error anywhere, so an unknown key is a refusal, not a default.
import { readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

import { z } from "zod";

import type { AdapterRegion } from "./persona/capability-docs.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Where the vendor actually processes the data. One honest, owner-visible label —
 *  Home Assistant's `iot_class`, narrowed to the only question a sovereignty promise asks
 *  (research report 07 §2.1). */
export const DATA_PATHS = ["self_hosted", "eu_cloud", "non_eu_cloud", "owner_chosen"] as const;
export type DataPath = (typeof DATA_PATHS)[number];

/** Who maintains it and where it lives — ADR-0019 decision 8. Deliberately NOT the quality
 *  tier: a private integration can be well made, a shipped one can be behind. */
export const PROVENANCES = ["core", "contributed", "private"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** The neutral Lares contracts a vendor integration can implement. An ARRAY, because one
 *  sign-in commonly backs two contracts (Google: mailbox + calendar; Graph would be the same). */
export const CONCEPTS = ["mailbox", "calendar", "accounting", "crm"] as const;
export type Concept = (typeof CONCEPTS)[number];

/** Every integration manifest folder lives under this path, relative to the package root. */
export const INTEGRATIONS_DIR = "integrations";

// ---------------------------------------------------------------------------
// Field-level refusals
//
// `outbound_hosts` and `secrets` get their own named checks so a bad manifest names the
// offending FIELD, the way `parseManifest` already does for `agent.json`.
// ---------------------------------------------------------------------------

/** The same suffix allowance `services/keeper/lib/egress.ts`'s `host()` makes for a vendor that
 *  fronts many API hosts behind one wildcard-shaped subdomain. COPIED, not imported:
 *  `services/keeper` depends on this package, not the other way around (W6A-s5 proves the two
 *  checks agree). */
const EXISTING_SUFFIXES = new Set([".googleapis.com", ".slack.com", ".slack-files.com"]);

/** Rejects anything `egress.ts`'s `host()` would reject later: a scheme, a wildcard that is not
 *  one of the existing suffixes, a port, an IP, or a bare suffix with no allowance. Same regex
 *  literal as `host()`, copied on purpose (see above). */
function isValidOutboundHost(value: string): boolean {
  const domain = value.startsWith(".") ? value.slice(1) : value;
  if (value.startsWith(".") && !EXISTING_SUFFIXES.has(value)) return false;
  if (domain.length > 253) return false;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return false;
  }
  if (isIP(domain)) return false;
  return true;
}

const hostField = z
  .string()
  .superRefine((value, ctx) => {
    if (!isValidOutboundHost(value)) {
      ctx.addIssue({
        code: "custom",
        message: `outbound_hosts: not a bare hostname generateEgress would accept — ${value}`,
      });
    }
  });

/** A manifest names secret FILES, never a value and never a path (ADR-0019: "named secret files
 *  only; the checker fails on any undeclared secret read"). Matches
 *  `ConnectionInstanceDef.secrets`'s existing naming (`connections.ts`, e.g. `"notion-token"`). */
const SECRET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const secretField = z
  .string()
  .superRefine((value, ctx) => {
    if (!SECRET_NAME_RE.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: `secrets: not a secret name (a value, a path or an env assignment is never allowed here) — ${value}`,
      });
    }
  });

/** The existing `AdapterRegion` shape, unchanged (ADR-0019's manifest table). */
const regionSchema: z.ZodType<AdapterRegion> = z.union([
  z.literal("global"),
  z.strictObject({ countries: z.array(z.string()), reason: z.string() }),
]);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** The manifest shape a single `integration.json` carries. `capability` names the capability
 *  doc id(s) it backs (`persona/capability-docs.ts`); `region` is the existing `AdapterRegion`
 *  shape, unchanged. `sdk` and `live_probe` are nullable: a private integration wraps no SDK of
 *  its own and, per the `superRefine` below, may skip the live probe entirely. */
export interface IntegrationManifest {
  id: string;
  name: string;
  provenance: Provenance;
  concept: Concept[];
  capability: string[];
  region: AdapterRegion;
  data_path: DataPath;
  outbound_hosts: string[];
  secrets: string[];
  credential_type: string;
  owner_supplies_client: boolean;
  sdk: { package: string; licence: string } | null;
  live_probe: string | null;
  quality: string;
  codeowner: string;
}

export const integrationManifestSchema: z.ZodType<IntegrationManifest> = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    provenance: z.enum(PROVENANCES),
    concept: z.array(z.enum(CONCEPTS)),
    capability: z.array(z.string().min(1)),
    region: regionSchema,
    data_path: z.enum(DATA_PATHS),
    outbound_hosts: z.array(hostField),
    secrets: z.array(secretField),
    credential_type: z.string().min(1),
    owner_supplies_client: z.boolean(),
    sdk: z.strictObject({ package: z.string().min(1), licence: z.string().min(1) }).nullable(),
    live_probe: z.string().min(1).nullable(),
    quality: z.string().min(1),
    codeowner: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    // A fixture is what we believe an API does — only a live call is what it does (repo rule).
    // A shipped integration (core or contributed) carries a live probe; a private one, reached
    // only through MCP and never merged into the engine, is exempt.
    if (value.live_probe === null && value.provenance !== "private") {
      ctx.addIssue({
        code: "custom",
        path: ["live_probe"],
        message: "live_probe is required unless provenance is 'private'",
      });
    }
  });

// ---------------------------------------------------------------------------
// Parsing and loading
// ---------------------------------------------------------------------------

/** Validate an already-loaded manifest. Throws an Error naming the offending field — the whole
 *  point is that a typo in `integration.json` fails the build loudly, the same contract
 *  `parseManifest` gives `agent.json`. */
export function parseIntegrationManifest(raw: unknown): IntegrationManifest {
  const result = integrationManifestSchema.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`invalid integration manifest — ${detail}`);
}

/** Every `<dir>/*\/integration.json`, parsed and sorted by nothing in particular (callers sort
 *  as they need). Skips any folder whose name starts with `_` — a fixture the runtime never
 *  loads (W6A-s2's Microsoft Graph fixture is the first of these). Refuses a folder whose name
 *  does not match the manifest's own `id`: the folder name IS the integration id, and a mismatch
 *  here is exactly the kind of drift generation is meant to make impossible. */
export function loadIntegrationManifests(dir: string): IntegrationManifest[] {
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name);

  return folders.map((folder) => {
    const path = join(dir, folder, "integration.json");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`loadIntegrationManifests: cannot read ${path}: ${(err as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      throw new Error(`loadIntegrationManifests: ${path} is not valid JSON: ${(err as Error).message}`);
    }
    let manifest: IntegrationManifest;
    try {
      manifest = parseIntegrationManifest(raw);
    } catch (err) {
      throw new Error(`loadIntegrationManifests: ${path} — ${(err as Error).message}`);
    }
    if (manifest.id !== folder) {
      throw new Error(
        `loadIntegrationManifests: ${path} declares id "${manifest.id}", but its folder is "${folder}"`,
      );
    }
    return manifest;
  });
}
