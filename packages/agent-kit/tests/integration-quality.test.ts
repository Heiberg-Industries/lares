import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  parseQualityFile,
  checkQuality,
  tierOf,
  BRONZE_RULES,
  SILVER_RULES,
  TIERS,
  INTEGRATIONS_WITHOUT_SCALE,
} from "../src/integration-quality.js";
import { CAPABILITY_DOCS } from "../src/persona/capability-docs.js";
import { connections } from "../src/connections.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (id: string) =>
  parseQualityFile(readFileSync(join(ROOT, "integrations", id, "quality.yaml"), "utf8"), id);

/** Builds a scratch `integrations/` directory (the same shape `loadIntegrationManifests` reads
 *  from the real repo) and returns its path — so a manifest's `quality` field can stay
 *  repo-root-relative (`"integrations/<id>/quality.yaml"`) exactly like the real files. */
function fixtureDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "quality-fixture-"));
  const integrationsDir = join(root, "integrations");
  for (const [rel, body] of Object.entries(files)) {
    const full = join(integrationsDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return integrationsDir;
}

const ACME = JSON.stringify({
  id: "acme",
  name: "Acme",
  provenance: "private",
  concept: [],
  capability: [],
  region: "global",
  data_path: "owner_chosen",
  outbound_hosts: [],
  secrets: [],
  credential_type: "api_key",
  owner_supplies_client: false,
  sdk: null,
  live_probe: null,
  quality: "integrations/acme/quality.yaml",
  codeowner: "lares-core",
});

const TWENTY = JSON.stringify({
  id: "twenty",
  name: "Twenty",
  provenance: "private",
  concept: [],
  capability: [],
  region: "global",
  data_path: "owner_chosen",
  outbound_hosts: [],
  secrets: [],
  credential_type: "api_key",
  owner_supplies_client: false,
  sdk: null,
  live_probe: null,
  quality: "integrations/twenty/quality.yaml",
  codeowner: "lares-core",
});

describe("a quality file", () => {
  it("names the entry tier's rules, in a fixed order, and no others", () => {
    expect([...BRONZE_RULES]).toEqual([
      "live-probe", "region-declared", "outbound-declared", "secrets-declared",
      "no-telemetry", "contract-tests", "shared-request-path", "credential-tested",
    ]);
    // Owner decision C1 (2026-09-19): a fourth, lowest tier `none` — ship honestly instead of
    // claiming `bronze` before every bronze rule is `done`.
    expect([...TIERS]).toEqual(["none", "bronze", "silver", "gold"]);
  });

  it("gives every bronze rule a status, for every integration", () => {
    for (const id of ["notion", "slack", "google"]) {
      const q = read(id);
      for (const rule of BRONZE_RULES) expect(q.rules[rule], `${id}/${rule}`).toBeDefined();
    }
  });

  it("none of the three integrations claims a tier its rules do not back yet", () => {
    // As of this slice, credential-tested is todo for all three (credential.ts's test-call
    // machinery is unused) so none can honestly claim bronze yet.
    for (const id of ["notion", "slack", "google"]) {
      expect(read(id).tier, id).toBe("none");
    }
  });

  it("refuses an exempt with no comment — the comment IS the rule", () => {
    expect(() => parseQualityFile("tier: bronze\nrules:\n  live-probe: exempt\n", "x"))
      .toThrow(/comment/);
    expect(parseQualityFile("tier: bronze\nrules:\n  live-probe: exempt # no write half\n", "x")
      .rules["live-probe"]).toEqual({ exempt: "no write half" });
  });

  it("refuses a rule name nobody defined — a typo is a silent pass otherwise", () => {
    expect(() => parseQualityFile("tier: bronze\nrules:\n  live_probe: done\n", "x"))
      .toThrow(/live_probe/);
  });

  it("refuses a silver rule on a file claiming bronze, so the ladder stays a ladder", () => {
    expect(SILVER_RULES).not.toContain("live-probe");
    expect(() => parseQualityFile("tier: bronze\nrules:\n  reauth: done\n", "x")).toThrow(/reauth/);
  });

  it("refuses an unknown tier", () => {
    expect(() => parseQualityFile("tier: platinum\nrules:\n  live-probe: done\n", "x"))
      .toThrow(/unknown tier/);
  });
});

describe("checkQuality — a claimed tier must be backed", () => {
  it("finds nothing unbacked in today's tree", () => {
    expect(checkQuality(join(ROOT, "integrations"))).toEqual([]);
  });

  it("reports a bronze claim with a bronze rule still todo", () => {
    const found = checkQuality(
      fixtureDir({
        "acme/integration.json": ACME,
        "acme/quality.yaml": "tier: silver\nrules:\n  live-probe: todo\n",
      }),
    );
    expect(found.map((f) => f.rule)).toContain("live-probe");
    expect(found[0]!.message).toMatch(/silver/);
  });

  it("refuses an integration that is on the debt list AND has a quality file", () => {
    expect(INTEGRATIONS_WITHOUT_SCALE).not.toContain("notion");
    const found = checkQuality(
      fixtureDir({
        "twenty/integration.json": TWENTY,
        "twenty/quality.yaml": "tier: bronze\nrules: {}\n",
      }),
    );
    expect(found.map((f) => f.message).join(" ")).toMatch(/remove .* from the list/i);
  });

  it("the debt list names only things that exist, so it cannot quietly keep dead entries", () => {
    const known = new Set<string>([...Object.keys(CAPABILITY_DOCS), ...connections.keys()]);
    for (const id of INTEGRATIONS_WITHOUT_SCALE) expect(known.has(id), id).toBe(true);
  });
});

describe("tierOf", () => {
  it("reads the tier a real integration's quality file backs", () => {
    for (const id of ["notion", "slack", "google"]) {
      expect(tierOf(id, join(ROOT, "integrations"))).toBe("none");
    }
  });

  it("answers null for an integration nobody defined", () => {
    expect(tierOf("does-not-exist", join(ROOT, "integrations"))).toBeNull();
  });
});
