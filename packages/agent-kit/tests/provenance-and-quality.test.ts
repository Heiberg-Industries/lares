import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadIntegrationManifests } from "../src/integration-manifest.js";
import { checkQuality, tierOf, INTEGRATIONS_WITHOUT_SCALE } from "../src/integration-quality.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

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

describe("provenance and quality are two questions", () => {
  it("every integration answers both, separately", () => {
    const manifests = loadIntegrationManifests(join(ROOT, "integrations"));
    for (const m of manifests) {
      expect(m.provenance, m.id).toBeDefined();
      expect(tierOf(m.id, join(ROOT, "integrations")), m.id).not.toBeUndefined();
    }
  });

  it("a private integration is never asked for a live probe it cannot run", () => {
    const findings = checkQuality(
      fixtureDir({
        "acme/integration.json": JSON.stringify({
          ...JSON.parse(ACME),
          provenance: "private",
          live_probe: null,
        }),
        "acme/quality.yaml": "tier: none\nrules: {}\n",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("a contributed or shipped integration is always asked for the entry tier", () => {
    const findings = checkQuality(
      fixtureDir({
        "acme/integration.json": JSON.stringify({
          ...JSON.parse(ACME),
          provenance: "contributed",
          live_probe: "tests/live/acme.live.mts",
        }),
        "acme/quality.yaml": "tier: none\nrules: {}\n",
      }),
    );
    expect(findings.map((f) => f.message).join(" ")).toMatch(/entry tier|bronze/i);
  });

  it("provenance is not a tier and a tier is not provenance", () => {
    expect(INTEGRATIONS_WITHOUT_SCALE).not.toContain("core");
    const manifests = loadIntegrationManifests(join(ROOT, "integrations"));
    for (const m of manifests)
      expect(["none", "bronze", "silver", "gold"]).not.toContain(m.provenance);
  });
});
