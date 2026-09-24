import { describe, it, expect } from "vitest";
import { parseNotionSyncConfig, MIN_NOTION_VERSION } from "../lib/config.js";

const valid = {
  notionVersion: "2026-03-11",
  meetingsDataSourceId: "27fcc987-b457-8092-830c-000b13ab5b0b",
  vaultPath: "/srv/vault",
  selfEmail: "owner@example.com",
  calendarWindowDays: 400,
  projects: [
    { notionProject: "Zero7", vaultFolder: "zero7" },
    { notionProject: "Orakel", vaultFolder: "orakel" },
  ],
};

describe("parseNotionSyncConfig", () => {
  it("accepts a valid config and defaults calendarWindowDays", () => {
    const cfg = parseNotionSyncConfig(valid);
    expect(cfg.meetingsDataSourceId).toBe("27fcc987-b457-8092-830c-000b13ab5b0b");
    expect(cfg.projects).toHaveLength(2);
    expect(cfg.projects[0].vaultFolder).toBe("zero7");

    const { calendarWindowDays: _omit, ...noWindow } = valid;
    expect(parseNotionSyncConfig(noWindow).calendarWindowDays).toBe(400);
  });

  it("rejects a notionVersion below the Markdown Content API floor", () => {
    expect(() => parseNotionSyncConfig({ ...valid, notionVersion: "2025-09-03" }))
      .toThrow(new RegExp(MIN_NOTION_VERSION));
  });

  it("rejects duplicate notionProject values", () => {
    const dupes = { ...valid, projects: [
      { notionProject: "Zero7", vaultFolder: "zero7" },
      { notionProject: "Zero7", vaultFolder: "other" },
    ] };
    expect(() => parseNotionSyncConfig(dupes)).toThrow(/duplicate notionProject/);
  });

  it("rejects an empty projects array", () => {
    expect(() => parseNotionSyncConfig({ ...valid, projects: [] })).toThrow(/non-empty array/);
  });

  it("names the offending field when a project entry is malformed", () => {
    const bad = { ...valid, projects: [{ notionProject: "Zero7" }] };
    expect(() => parseNotionSyncConfig(bad)).toThrow(/projects\[0\]\.vaultFolder/);
  });

  it("still accepts selfEmail as a single string, and normalises it to a list", () => {
    expect(parseNotionSyncConfig(valid).selfEmails).toEqual(["owner@example.com"]);
  });

  it("accepts selfEmail as a list, for a principal with mailboxes in several orgs", () => {
    const multi = {
      ...valid,
      selfEmail: ["owner@example.com", "owner@second-org.example"],
    };
    expect(parseNotionSyncConfig(multi).selfEmails)
      .toEqual(["owner@example.com", "owner@second-org.example"]);
  });

  it("rejects an empty or malformed selfEmail list", () => {
    expect(() => parseNotionSyncConfig({ ...valid, selfEmail: [] }))
      .toThrow(/non-empty array/);
    expect(() => parseNotionSyncConfig({ ...valid, selfEmail: ["ok@example.com", ""] }))
      .toThrow(/selfEmail\[1\]/);
  });
});

describe("parseNotionSyncConfig — wiki pass (Phase 2)", () => {
  const wikiValid = {
    ...valid,
    docsDataSourceId: "11111111-1111-1111-1111-111111111111",
    docsDatabaseId: "22222222-2222-2222-2222-222222222222",
    wikiProject: "Portfolio",
  };

  it("keeps a Phase 1 config valid: no wiki keys ⇒ cfg.wiki stays undefined", () => {
    expect(parseNotionSyncConfig(valid).wiki).toBeUndefined();
  });

  it("assembles the wiki group and defaults wikiDir", () => {
    expect(parseNotionSyncConfig(wikiValid).wiki).toEqual({
      docsDataSourceId: "11111111-1111-1111-1111-111111111111",
      docsDatabaseId: "22222222-2222-2222-2222-222222222222",
      wikiDir: "wiki",
      project: "Portfolio",
    });
  });

  it("accepts a wikiDir override and keeps docsDatabaseId optional", () => {
    const { docsDatabaseId: _omit, ...noDb } = wikiValid;
    const cfg = parseNotionSyncConfig({ ...noDb, wikiDir: "knowledge" });
    expect(cfg.wiki?.wikiDir).toBe("knowledge");
    expect(cfg.wiki?.docsDatabaseId).toBeUndefined();
  });

  it("requires wikiProject alongside docsDataSourceId — the Project select is config, never code", () => {
    const { wikiProject: _omit, ...noProject } = wikiValid;
    expect(() => parseNotionSyncConfig(noProject)).toThrow(/wikiProject/);
  });

  it("rejects a stray wiki key without docsDataSourceId — a typo'd id must not become a silent skip", () => {
    expect(() => parseNotionSyncConfig({ ...valid, wikiProject: "Portfolio" }))
      .toThrow(/docsDataSourceId/);
    expect(() => parseNotionSyncConfig({ ...valid, wikiDir: "wiki" }))
      .toThrow(/docsDataSourceId/);
    expect(() => parseNotionSyncConfig({ ...valid, docsDatabaseId: "22222222" }))
      .toThrow(/docsDataSourceId/);
  });

  it("rejects a wikiDir that is not a bare relative folder path", () => {
    expect(() => parseNotionSyncConfig({ ...wikiValid, wikiDir: "wiki/" })).toThrow(/wikiDir/);
    expect(() => parseNotionSyncConfig({ ...wikiValid, wikiDir: "/wiki" })).toThrow(/wikiDir/);
    expect(() => parseNotionSyncConfig({ ...wikiValid, wikiDir: "" })).toThrow(/wikiDir/);
  });
});

describe("parseNotionSyncConfig — desk dirs (Phase 3)", () => {
  const wikiKeys = {
    docsDataSourceId: "11111111-1111-1111-1111-111111111111",
    wikiDir: "wiki",
    wikiProject: "Portfolio",
  };
  const desksValid = {
    ...valid,
    ...wikiKeys,
    deskDirs: [
      { dir: "desks/one", project: "One" },
      { dir: "writing", project: "Portfolio" },
    ],
    twoWayDirs: ["desks/one"],
    mirrorFilePrefixes: ["writing/ghost__"],
  };

  it("keeps a Phase 2 config valid: no desk keys ⇒ cfg.desks stays undefined", () => {
    expect(parseNotionSyncConfig({ ...valid, ...wikiKeys }).desks).toBeUndefined();
  });

  it("assembles the desks group and defaults the two optional lists to empty", () => {
    expect(parseNotionSyncConfig(desksValid).desks).toEqual({
      deskDirs: [
        { dir: "desks/one", project: "One" },
        { dir: "writing", project: "Portfolio" },
      ],
      twoWayDirs: ["desks/one"],
      mirrorFilePrefixes: ["writing/ghost__"],
    });

    const { twoWayDirs: _a, mirrorFilePrefixes: _b, ...bare } = desksValid;
    expect(parseNotionSyncConfig(bare).desks).toEqual({
      deskDirs: bare.deskDirs,
      twoWayDirs: [],
      mirrorFilePrefixes: [],
    });
  });

  it("rejects a stray desk key without deskDirs — a typo'd list must not become a silent skip", () => {
    expect(() => parseNotionSyncConfig({ ...valid, ...wikiKeys, twoWayDirs: ["desks/one"] }))
      .toThrow(/deskDirs/);
    expect(() => parseNotionSyncConfig({ ...valid, ...wikiKeys, mirrorFilePrefixes: ["writing/ghost__"] }))
      .toThrow(/deskDirs/);
  });

  it("requires docsDataSourceId — desk folders sync into the same Docs database", () => {
    const { docsDataSourceId: _omit, wikiDir: _d, wikiProject: _p, ...noDocs } = desksValid;
    expect(() => parseNotionSyncConfig(noDocs)).toThrow(/docsDataSourceId/);
  });

  it("names the offending field when a deskDirs entry is malformed", () => {
    expect(() => parseNotionSyncConfig({ ...desksValid, deskDirs: [{ dir: "desks/one" }], twoWayDirs: [] }))
      .toThrow(/deskDirs\[0\]\.project/);
    expect(() => parseNotionSyncConfig({ ...desksValid, deskDirs: ["desks/one"], twoWayDirs: [] }))
      .toThrow(/deskDirs\[0\] must be an object/);
  });

  it("rejects an empty deskDirs array — present means configured", () => {
    expect(() => parseNotionSyncConfig({ ...desksValid, deskDirs: [], twoWayDirs: [] }))
      .toThrow(/non-empty array/);
  });

  it("rejects a desk dir that is not a bare relative folder path", () => {
    for (const dir of ["desks/one/", "/desks/one", "", ".", "../outside"]) {
      expect(() => parseNotionSyncConfig({
        ...desksValid, deskDirs: [{ dir, project: "One" }], twoWayDirs: [],
      })).toThrow(/deskDirs\[0\]\.dir/);
    }
  });

  it("rejects a desk dir that is the wiki dir, or nested either way", () => {
    for (const dir of ["wiki", "wiki/people"]) {
      expect(() => parseNotionSyncConfig({
        ...desksValid, deskDirs: [{ dir, project: "One" }], twoWayDirs: [],
      })).toThrow(/wikiDir/);
    }
    // …and the other direction: a wikiDir nested inside a desk dir.
    expect(() => parseNotionSyncConfig({
      ...desksValid, wikiDir: "desks/one/wiki", deskDirs: [{ dir: "desks/one", project: "One" }], twoWayDirs: [],
    })).toThrow(/wikiDir/);
  });

  it("rejects desk dirs that overlap each other — one file must belong to exactly one dir", () => {
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "desks", project: "A" }, { dir: "desks/one", project: "B" }],
      twoWayDirs: [],
    })).toThrow(/overlap/);
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "desks/one", project: "A" }, { dir: "desks/one", project: "B" }],
      twoWayDirs: [],
    })).toThrow(/overlap/);
  });

  it("rejects a twoWayDir that is not one of the desk dirs", () => {
    expect(() => parseNotionSyncConfig({ ...desksValid, twoWayDirs: ["desks/typo"] }))
      .toThrow(/twoWayDirs\[0\]/);
  });

  it("rejects malformed twoWayDirs / mirrorFilePrefixes entries", () => {
    expect(() => parseNotionSyncConfig({ ...desksValid, twoWayDirs: "desks/one" }))
      .toThrow(/twoWayDirs must be an array/);
    expect(() => parseNotionSyncConfig({ ...desksValid, mirrorFilePrefixes: [""] }))
      .toThrow(/mirrorFilePrefixes\[0\]/);
    expect(() => parseNotionSyncConfig({ ...desksValid, mirrorFilePrefixes: ["/writing/ghost__"] }))
      .toThrow(/mirrorFilePrefixes\[0\]/);
  });
});

describe("parseNotionSyncConfig — deskDirs exclude (Phase 4)", () => {
  const wikiKeys = {
    docsDataSourceId: "11111111-1111-1111-1111-111111111111",
    wikiDir: "wiki",
    wikiProject: "Portfolio",
  };
  const desksValid = {
    ...valid,
    ...wikiKeys,
    deskDirs: [
      { dir: "zero7", project: "Zero7", exclude: ["transcripts"] },
      { dir: "writing", project: "Portfolio" },
    ],
  };

  it("accepts exclude and scopes each entry to its own deskDirs entry", () => {
    const cfg = parseNotionSyncConfig(desksValid);
    expect(cfg.desks?.deskDirs[0]).toEqual({ dir: "zero7", project: "Zero7", exclude: ["transcripts"] });
    expect(cfg.desks?.deskDirs[1]).toEqual({ dir: "writing", project: "Portfolio" });
  });

  it("omits exclude entirely when absent — byte-identical to a pre-Phase-4 config", () => {
    const bareDeskDirs = desksValid.deskDirs.map(({ dir, project }) => ({ dir, project }));
    const cfg = parseNotionSyncConfig({ ...desksValid, deskDirs: bareDeskDirs });
    expect(cfg.desks?.deskDirs).toEqual(bareDeskDirs);
    expect(cfg.desks?.deskDirs[0]).not.toHaveProperty("exclude");
  });

  it("treats an empty exclude list the same as an absent one", () => {
    const cfg = parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "zero7", project: "Zero7", exclude: [] }, desksValid.deskDirs[1]],
    });
    expect(cfg.desks?.deskDirs[0]).not.toHaveProperty("exclude");
  });

  it("rejects an exclude entry with a leading or trailing slash", () => {
    for (const bad of ["/transcripts", "transcripts/"]) {
      expect(() => parseNotionSyncConfig({
        ...desksValid,
        deskDirs: [{ dir: "zero7", project: "Zero7", exclude: [bad] }, desksValid.deskDirs[1]],
      })).toThrow(/deskDirs\[0\]\.exclude\[0\]/);
    }
  });

  it("rejects an exclude entry with leading or trailing whitespace", () => {
    // The one malformed entry the eye cannot catch and every other guard lets
    // through: `"transcripts "` is a valid non-empty string, has no slash edges
    // and no `..`, so it used to parse clean — and then match NOTHING on either
    // surface, silently leaving the sub-tree in the desk scope. That silence is
    // the exact failure this exclusion exists to prevent, so it must be loud.
    for (const bad of ["transcripts ", " transcripts", "trans cripts\t", "\ntranscripts"]) {
      expect(() => parseNotionSyncConfig({
        ...desksValid,
        deskDirs: [{ dir: "zero7", project: "Zero7", exclude: [bad] }, desksValid.deskDirs[1]],
      })).toThrow(/deskDirs\[0\]\.exclude\[0\].*whitespace/);
    }
  });

  it("rejects whitespace on any bare dir, not just exclude entries", () => {
    // Same validator, so the same guard: a padded `dir` would build every
    // vault_path and Notion Folder value with the space baked in.
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "zero7 ", project: "Zero7" }, desksValid.deskDirs[1]],
    })).toThrow(/deskDirs\[0\]\.dir.*whitespace/);
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      transcripts: { dir: " transcripts", projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }] },
    })).toThrow(/transcripts\.dir.*whitespace/);
  });

  it("keeps an inner space — a folder may legitimately have one", () => {
    // Only the EDGES are the typo. Real desk folders carry inner spaces.
    const cfg = parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "zero7", project: "Zero7", exclude: ["meeting notes"] }, desksValid.deskDirs[1]],
    });
    expect(cfg.desks?.deskDirs[0].exclude).toEqual(["meeting notes"]);
  });

  it("rejects an exclude entry containing a `..` segment", () => {
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "zero7", project: "Zero7", exclude: ["../escape"] }, desksValid.deskDirs[1]],
    })).toThrow(/deskDirs\[0\]\.exclude\[0\]/);
  });

  it("rejects exclude entries that overlap each other, including exact duplicates", () => {
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "zero7", project: "Zero7", exclude: ["a", "a/b"] }, desksValid.deskDirs[1]],
    })).toThrow(/deskDirs\[0\]\.exclude.*overlap/);
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [
        { dir: "zero7", project: "Zero7", exclude: ["transcripts", "transcripts"] },
        desksValid.deskDirs[1],
      ],
    })).toThrow(/deskDirs\[0\]\.exclude.*overlap/);
  });

  it("rejects a non-array exclude", () => {
    expect(() => parseNotionSyncConfig({
      ...desksValid,
      deskDirs: [{ dir: "zero7", project: "Zero7", exclude: "transcripts" }, desksValid.deskDirs[1]],
    })).toThrow(/deskDirs\[0\]\.exclude must be an array/);
  });
});

describe("parseNotionSyncConfig — transcripts (Phase 4)", () => {
  const transcriptsValid = {
    ...valid,
    transcripts: {
      dir: "transcripts",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
    },
  };

  it("keeps a Phase 3 config valid: no transcripts key ⇒ cfg.transcripts is absent, not merely undefined", () => {
    const cfg = parseNotionSyncConfig(valid);
    expect(cfg.transcripts).toBeUndefined();
    expect(cfg).not.toHaveProperty("transcripts");
  });

  it("assembles the transcripts group and defaults dir", () => {
    const { dir: _omit, ...noDir } = transcriptsValid.transcripts;
    const cfg = parseNotionSyncConfig({ ...valid, transcripts: noDir });
    expect(cfg.transcripts).toEqual({
      dir: "transcripts",
      projects: [{ notionProject: "Zero7", vaultFolder: "zero7" }],
    });
  });

  it("accepts an explicit dir override", () => {
    const cfg = parseNotionSyncConfig({
      ...valid,
      transcripts: { dir: "meetings", projects: transcriptsValid.transcripts.projects },
    });
    expect(cfg.transcripts?.dir).toBe("meetings");
  });

  it("rejects an empty transcripts.projects array", () => {
    expect(() => parseNotionSyncConfig({ ...valid, transcripts: { projects: [] } }))
      .toThrow(/transcripts\.projects must be a non-empty array/);
  });

  it("rejects duplicate notionProject values within transcripts.projects", () => {
    expect(() => parseNotionSyncConfig({
      ...valid,
      transcripts: { projects: [
        { notionProject: "Zero7", vaultFolder: "zero7" },
        { notionProject: "Zero7", vaultFolder: "other" },
      ] },
    })).toThrow(/duplicate notionProject/);
  });

  it("names the offending field when a transcripts.projects entry is malformed", () => {
    expect(() => parseNotionSyncConfig({ ...valid, transcripts: { projects: [{ notionProject: "Zero7" }] } }))
      .toThrow(/transcripts\.projects\[0\]\.vaultFolder/);
  });

  it("rejects a transcripts.dir that is not a bare relative folder path", () => {
    for (const dir of ["transcripts/", "/transcripts", "", ".", "../outside"]) {
      expect(() => parseNotionSyncConfig({
        ...valid,
        transcripts: { dir, projects: transcriptsValid.transcripts.projects },
      })).toThrow(/transcripts\.dir/);
    }
  });

  it("rejects a non-object transcripts value", () => {
    expect(() => parseNotionSyncConfig({ ...valid, transcripts: "zero7" })).toThrow(/transcripts must be an object/);
  });
});

describe("parseNotionSyncConfig — people (Phase 4)", () => {
  it("keeps a Phase 3 config valid: no people key ⇒ cfg.people is absent, not merely undefined", () => {
    const cfg = parseNotionSyncConfig(valid);
    expect(cfg.people).toBeUndefined();
    expect(cfg).not.toHaveProperty("people");
  });

  it("assembles the people group and keeps databaseId optional", () => {
    const cfg = parseNotionSyncConfig({
      ...valid,
      people: { dataSourceId: "33333333-3333-3333-3333-333333333333" },
    });
    expect(cfg.people).toEqual({ dataSourceId: "33333333-3333-3333-3333-333333333333" });
  });

  it("accepts an optional databaseId alongside dataSourceId", () => {
    const cfg = parseNotionSyncConfig({
      ...valid,
      people: {
        dataSourceId: "33333333-3333-3333-3333-333333333333",
        databaseId: "44444444-4444-4444-4444-444444444444",
      },
    });
    expect(cfg.people).toEqual({
      dataSourceId: "33333333-3333-3333-3333-333333333333",
      databaseId: "44444444-4444-4444-4444-444444444444",
    });
  });

  it("rejects people present without dataSourceId — an empty section", () => {
    expect(() => parseNotionSyncConfig({ ...valid, people: {} })).toThrow(/people\.dataSourceId/);
  });

  it("rejects a databaseId set without dataSourceId — a typo'd id must not become a silent skip", () => {
    expect(() => parseNotionSyncConfig({
      ...valid,
      people: { databaseId: "44444444-4444-4444-4444-444444444444" },
    })).toThrow(/people\.dataSourceId/);
  });

  it("rejects a non-object people value", () => {
    expect(() => parseNotionSyncConfig({ ...valid, people: "zero7" })).toThrow(/people must be an object/);
  });
});
