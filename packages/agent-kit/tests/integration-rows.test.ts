import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { integrationRows, DATA_PATH_WORDS } from "../src/integration-rows.js";
import { loadIntegrationManifests } from "../src/integration-manifest.js";

const rows = integrationRows(
  loadIntegrationManifests(join(import.meta.dirname, "..", "..", "..", "integrations")),
);

describe("the Connections rows", () => {
  it("says where the data goes in words an owner reads, for every case", () => {
    expect(DATA_PATH_WORDS).toEqual({
      self_hosted: "Runs on your server",
      eu_cloud: "In the EU",
      non_eu_cloud: "Outside the EU",
      owner_chosen: "Wherever you point it",
    });
    expect(rows.find((r) => r.id === "notion")!.whereTheDataGoes).toBe("Outside the EU");
  });

  it("lists what the agent can do from the capability docs, never from the manifest's prose", () => {
    expect([...rows.find((r) => r.id === "google")!.capabilities].sort()).toEqual(["calendar", "gmail"]);
    expect(rows.find((r) => r.id === "slack")!.capabilities).toEqual([]);
  });

  it("names the secret FILES an installation must provide, and no value", () => {
    const notion = rows.find((r) => r.id === "notion")!;
    expect(notion.needs).toEqual(["notion-token"]);
    expect(JSON.stringify(rows)).not.toMatch(/\/run\/secrets/);
  });

  it("carries no tier until the quality files exist", () => {
    expect(rows.every((r) => r.tier === null)).toBe(true);
  });

  it("is stable: the same manifests render the same rows", () => {
    const again = integrationRows(
      loadIntegrationManifests(join(import.meta.dirname, "..", "..", "..", "integrations")),
    );
    expect(again).toEqual(rows);
  });
});
