import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  parseIntegrationManifest,
  loadIntegrationManifests,
  DATA_PATHS,
  PROVENANCES,
} from "../src/integration-manifest.js";

// `integrations/` is a top-level directory, not a package-relative one; `vitest run` here
// executes with cwd = packages/agent-kit (per `pnpm -C packages/agent-kit exec vitest run`),
// so the loader is pointed at the repo root the same way integration-manifest-agrees.test.ts
// does, rather than at a bare "integrations" that would only resolve if this file ran from
// the repo root itself.
const ROOT = join(import.meta.dirname, "..", "..", "..");

const good = {
  id: "notion",
  name: "Notion",
  provenance: "core",
  concept: [],
  capability: ["notion"],
  region: "global",
  data_path: "non_eu_cloud",
  outbound_hosts: ["api.notion.com"],
  secrets: ["notion-token"],
  credential_type: "api_key",
  owner_supplies_client: false,
  sdk: { package: "@notionhq/client", licence: "MIT" },
  live_probe: "services/notion-sync/tests/live/notion.live.mts",
  quality: "integrations/notion/quality.yaml",
  codeowner: "lares-core",
};

describe("the integration manifest", () => {
  it("accepts a complete manifest and keeps every field", () => {
    expect(parseIntegrationManifest(good)).toEqual(good);
  });

  it("is strict: a misspelled key is a refusal, not a silent default", () => {
    expect(() => parseIntegrationManifest({ ...good, outbound_host: ["api.notion.com"] }))
      .toThrow(/outbound_host/);
  });

  it("names the offending field, the way parseManifest does", () => {
    expect(() => parseIntegrationManifest({ ...good, data_path: "the cloud" }))
      .toThrow(/data_path/);
    expect([...DATA_PATHS]).toEqual(["self_hosted", "eu_cloud", "non_eu_cloud", "owner_chosen"]);
    expect([...PROVENANCES]).toEqual(["core", "contributed", "private"]);
  });

  it("refuses a host that is a URL, a wildcard, a port or a bare suffix — generateEgress would throw later", () => {
    for (const host of ["https://api.notion.com", "*.notion.com", "api.notion.com:443", ".com"]) {
      expect(() => parseIntegrationManifest({ ...good, outbound_hosts: [host] }), host).toThrow();
    }
    expect(parseIntegrationManifest({ ...good, outbound_hosts: [".googleapis.com"] }).outbound_hosts)
      .toEqual([".googleapis.com"]);
  });

  it("refuses a secret path: a manifest names secret FILES, never a value and never a path", () => {
    for (const s of ["/run/secrets/notion-token", "NOTION_TOKEN=abc", "../notion-token"]) {
      expect(() => parseIntegrationManifest({ ...good, secrets: [s] }), s).toThrow();
    }
  });

  it("requires a live probe on anything shipped in the engine, and allows none on a private one", () => {
    expect(() => parseIntegrationManifest({ ...good, live_probe: null })).toThrow(/live_probe/);
    expect(parseIntegrationManifest({ ...good, provenance: "private", live_probe: null }).live_probe)
      .toBeNull();
  });

  it("loads a directory, skips underscored fixtures, and refuses a folder whose name is not its id", () => {
    const loaded = loadIntegrationManifests(join(ROOT, "integrations"));
    expect(loaded.map((m) => m.id).sort()).toEqual(["google", "notion", "slack"]);
  });
});
