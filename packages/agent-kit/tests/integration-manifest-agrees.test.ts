import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadIntegrationManifests, parseIntegrationManifest } from "../src/integration-manifest.js";
import { CAPABILITY_DOCS, hostsFor } from "../src/persona/index.js";
import { connections, secretsForRefs } from "../src/connections.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const manifests = loadIntegrationManifests(join(ROOT, "integrations"));

describe("a manifest and the registries it will generate", () => {
  it("ships exactly the three integrations wave 6 collapses onto an SDK", () => {
    expect(manifests.map((m) => m.id).sort()).toEqual(["google", "notion", "slack"]);
  });

  it("names only capabilities the fleet knows, and agrees with each one's declared hosts", () => {
    for (const m of manifests) {
      for (const c of m.capability) {
        expect(CAPABILITY_DOCS[c], `${m.id} names unknown capability ${c}`).toBeDefined();
        expect(hostsFor(c), `${m.id}/${c}`).toEqual(
          hostsFor(c).filter((h) => m.outbound_hosts.includes(h)),
        );
      }
    }
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
  // Two are missing today (wave 6B writes them, one per vendor). The list may only SHRINK: a new
  // manifest with a missing probe fails, and so does an entry here whose file has since appeared.
  const KNOWN_MISSING_PROBES: Record<string, string> = {
    notion: "W6B writes services/notion-sync/tests/live/notion.live.mts with the one Notion client",
    slack: "W6B writes services/chief-of-staff/tests/live/slack.live.mts with the one Slack client",
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
