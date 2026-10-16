import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { generateEgress } from "../lib/egress.js";
import { loadIntegrationManifests } from "@lares/agent-kit/integration-manifest";
import { hostsFor } from "@lares/agent-kit/persona";

const manifests = loadIntegrationManifests(join(import.meta.dirname, "..", "..", "..", "integrations"));

describe("the allow-list and the manifests", () => {
  it("lets no capability reach a host its manifest did not declare", () => {
    for (const m of manifests) {
      for (const c of m.capability) {
        for (const host of hostsFor(c)) {
          expect(m.outbound_hosts, `${m.id}/${c}`).toContain(host);
        }
      }
    }
  });

  it("puts a manifest's hosts into the squid file the keeper writes", () => {
    const { squid, perAgent } = generateEgress([
      { name: "alpha", address: "172.18.0.40", grants: [{ capability: "notion", scope: "read" }] },
    ]);
    expect(perAgent.alpha).toEqual(["api.notion.com"]);
    expect(squid).toContain("acl dst_alpha dstdomain api.notion.com");
  });

  it("accepts every host every manifest declares — none would be rejected as malformed", () => {
    for (const m of manifests) {
      expect(
        () =>
          generateEgress([
            { name: "alpha", address: "172.18.0.40", grants: [], infrastructureHosts: m.outbound_hosts },
          ]),
        m.id,
      ).not.toThrow();
    }
  });
});
