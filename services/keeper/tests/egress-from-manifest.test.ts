import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { generateEgress } from "../lib/egress.js";
import { loadIntegrationManifests, assertCapabilityHosts } from "@lares/agent-kit/integration-manifest";
import { hostsFor } from "@lares/agent-kit/persona";

const manifests = loadIntegrationManifests(join(import.meta.dirname, "..", "..", "..", "integrations"));

describe("the allow-list and the manifests", () => {
  it("lets no capability reach a host its manifest did not declare", () => {
    expect(()=>assertCapabilityHosts(manifests,hostsFor)).not.toThrow();
    for(const capability of ['personal_mailbox','personal_calendar']) {
      const {perAgent}=generateEgress([{name:'alpha',address:'172.18.0.40',grants:[{capability,scope:'read'}]}]);
      expect(perAgent.alpha).toEqual(['.googleapis.com','graph.microsoft.com','login.microsoftonline.com']);
    }
    expect(()=>generateEgress([{name:'alpha',address:'172.18.0.40',grants:[{capability:'unknown',scope:'read'}]}])).toThrow();
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
