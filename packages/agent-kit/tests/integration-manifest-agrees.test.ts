import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadIntegrationManifests, parseIntegrationManifest, assertCapabilityHosts } from "../src/integration-manifest.js";
import { CAPABILITY_DOCS, hostsFor } from "../src/persona/index.js";
import { connections, secretsForRefs } from "../src/connections.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const manifests = loadIntegrationManifests(join(ROOT, "integrations"));

describe("a manifest and the registries it will generate", () => {
  it("ships the declared integrations that sit on an SDK", () => {
    expect(manifests.map((m) => m.id).sort()).toEqual(["google", "microsoft", "notion", "slack", "twenty"]);
  });

  it("names known capabilities whose hosts are covered by the implementing provider union", () => {
    expect(()=>assertCapabilityHosts(manifests,hostsFor)).not.toThrow();
    for(const m of manifests)for(const c of m.capability)expect(CAPABILITY_DOCS[c]).toBeDefined();
    const withoutMicrosoft=manifests.filter(m=>m.id!=="microsoft");
    expect(()=>assertCapabilityHosts(withoutMicrosoft,hostsFor)).toThrow("Undeclared capability host");
    expect(()=>assertCapabilityHosts([{...manifests[0],capability:["unknown"]}],hostsFor)).toThrow();
    expect(()=>assertCapabilityHosts(manifests.map(m=>({...m,outbound_hosts:m.outbound_hosts.filter(h=>h!=="graph.microsoft.com")})),hostsFor)).toThrow("graph.microsoft.com");
  });

  it("declares every secret its connection holds, where it has a connection at all", () => {
    for (const m of manifests) {
      const conn = connections.get(m.id);
      if (!conn || m.secrets.length === 0) continue;
      expect(new Set(m.secrets), m.id).toEqual(new Set(secretsForRefs([m.id])));
    }
  });

  it("declares a region on every integration, because generateEgress reads it", () => {
    for (const m of manifests) expect(m.region, m.id).toBeDefined();
  });

  it("could describe a Microsoft Graph integration with no change to the schema", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "integrations/_fixtures/microsoft-365.json"), "utf8"),
    );
    const parsed = parseIntegrationManifest(raw);
    expect(parsed.concept).toEqual(["mailbox", "calendar"]);
    expect(parsed.data_path).toBe("non_eu_cloud");
    expect(parsed.outbound_hosts).toEqual(["graph.microsoft.com", "login.microsoftonline.com"]);
    expect(parsed.owner_supplies_client).toBe(true);
    expect(parsed.sdk?.package).toBe("@microsoft/microsoft-graph-client");
  });

  it("does not load a fixture as a real integration", () => {
    expect(manifests.map((m) => m.id)).not.toContain("microsoft-365");
  });

  // A manifest that names a live probe which is not on disk is claiming a check nobody can run.
  // Two are missing today (one per vendor). The list may only SHRINK: a new
  // manifest with a missing probe fails, and so does an entry here whose file has since appeared.
  const KNOWN_MISSING_PROBES: Record<string, string> = {
    notion: "still to write: services/notion-sync/tests/live/notion.live.mts, with the one Notion client",
    slack: "still to write: services/chief-of-staff/tests/live/slack.live.mts, with the one Slack client",
  };

  it("names a live probe that is really on disk, or is on the shrinking list of ones still to write", () => {
    for (const m of manifests) {
      if (m.live_probe === null) continue;
      const onDisk = existsSync(join(ROOT, m.live_probe));
      if (m.id in KNOWN_MISSING_PROBES) {
        expect(onDisk, `${m.id}: its probe exists now — remove it from KNOWN_MISSING_PROBES`).toBe(false);
      } else {
        expect(onDisk, `${m.id}: live_probe ${m.live_probe} is not on disk`).toBe(true);
      }
    }
  });
});
