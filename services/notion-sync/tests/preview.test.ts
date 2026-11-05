import { describe, expect, it } from "vitest";
import { parseNotionSyncConfig } from "../lib/config.js";
import { parseOneShotArgs } from "../lib/cli.js";
import { attendeePreview, peoplePreview, runPreview, selectPasses } from "../lib/preview.js";
import type { AttendeeSyncResult } from "../lib/run.js";
import type { PeopleSyncResult } from "../lib/people-sync.js";

const managed = {
  notionVersion: "2026-03-11",
  meetingsDataSourceId: "00000000-0000-4000-8000-000000000001",
  selfEmail: "owner@example.com",
  passes: ["attendees", "people"],
  people: { dataSourceId: "00000000-0000-4000-8000-000000000002" },
};

describe("config passes (a managed install without a vault)", () => {
  it("needs neither a vault path nor project folders when only vault-free passes are named", () => {
    const cfg = parseNotionSyncConfig(managed);
    expect(cfg.passes).toEqual(["attendees", "people"]);
    expect(cfg.vaultPath).toBe("");
    expect(cfg.projects).toEqual([]);
  });

  it("still demands its project folders once a vault pass is named", () => {
    expect(() => parseNotionSyncConfig({ ...managed, passes: ["attendees", "wiki"] })).toThrow(/projects must be/);
  });

  it("an older config with no passes list keeps every pass and still demands its project folders", () => {
    const { passes: _p, ...older } = managed;
    expect(() => parseNotionSyncConfig(older)).toThrow(/projects must be/);
  });

  it("refuses an unknown, repeated or empty passes list, and people without its group", () => {
    expect(() => parseNotionSyncConfig({ ...managed, passes: ["attendees", "teleport"] })).toThrow(/unknown pass/);
    expect(() => parseNotionSyncConfig({ ...managed, passes: ["attendees", "attendees"] })).toThrow(/twice/);
    expect(() => parseNotionSyncConfig({ ...managed, passes: [] })).toThrow(/non-empty/);
    const { people: _g, ...noGroup } = managed;
    expect(() => parseNotionSyncConfig(noGroup)).toThrow(/people group is missing/);
  });
});

describe("selectPasses", () => {
  const all = ["attendees", "transcripts", "pull", "people"].map((name) => ({ name }));
  it("keeps only the allowed passes, in tick order", () => {
    expect(selectPasses(all, ["people", "attendees"]).map((p) => p.name)).toEqual(["attendees", "people"]);
  });
  it("allows everything when the config names no list", () => {
    expect(selectPasses(all, undefined)).toHaveLength(4);
  });
});

describe("preview counts", () => {
  it("maps an attendee dry run onto the four counts", () => {
    const result = { scanned: 10, filled: 3, flagged: 2, errored: 1 } as AttendeeSyncResult;
    expect(attendeePreview(result)).toEqual({ create: 0, adoptPatch: 3, skip: 4, conflict: 3 });
  });
  it("maps a people dry run onto the four counts", () => {
    const result = {
      created: 2, updated: 1, relationsUpdated: 4, unchanged: 5, notNeeded: 7, noEmail: 3, relationsUnchanged: 2,
      skipped: [{}], contestedAddresses: [{}, {}], duplicates: [], errored: 1,
    } as unknown as PeopleSyncResult;
    expect(peoplePreview(result)).toEqual({ create: 2, adoptPatch: 5, skip: 17, conflict: 4 });
  });
});

describe("runPreview", () => {
  it("runs exactly the allowed passes", async () => {
    const zero = { create: 0, adoptPatch: 1, skip: 2, conflict: 0 };
    const report = await runPreview({ attendees: async () => zero, people: async () => { throw new Error("must not run"); } }, ["attendees"]);
    expect(report).toEqual({ version: 1, passes: { attendees: zero } });
  });
  it("refuses a pass it has no preview for instead of leaving a gap", async () => {
    await expect(runPreview({}, ["wiki"])).rejects.toThrow(/no preview for the "wiki" pass/);
    await expect(runPreview({}, [])).rejects.toThrow(/no pass to preview/);
  });
});

describe("--preview flag", () => {
  it("is a one-shot of its own and cannot be combined", () => {
    expect(parseOneShotArgs(["--preview"])).toEqual({ once: false, mode: "preview" });
    expect(() => parseOneShotArgs(["--preview", "--once"])).toThrow(/cannot be combined/);
    expect(() => parseOneShotArgs(["--preview", "--people"])).toThrow(/one one-shot flag/);
  });
});
