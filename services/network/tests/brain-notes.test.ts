import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.js";
import {
  selectActiveContacts,
  slugify,
  assignSlugs,
  preferredChannel,
  composePersonNote,
  composeCompanyNote,
  composeMapPage,
  regenerateBrainNotes,
  type BrainContact,
} from "../lib/brain-notes.js";

const NOW = new Date("2026-06-11T12:00:00Z");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** id 1: warm @ Acme · id 2: dormant-warm @ Acme · id 3: cold (excluded) · id 4: warm bare handle (excluded). */
function seedDb(): Db {
  const db = openDb(join(tempDir("brain-test-"), "network.db"));
  const contact = db.prepare(
    "INSERT INTO contacts (display_name, company, title, source, resolved, twenty_id_cache) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const pulse = db.prepare(
    "INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const interaction = db.prepare(
    "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id, answered) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const identity = db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (?, ?, ?, ?)");
  const signal = db.prepare("INSERT INTO signals (contact_id, kind, at, evidence) VALUES (?, ?, ?, ?)");

  contact.run("Kari Nordmann", "Acme", "CTO", "test", 1, "twenty-abc");
  pulse.run(1, 4.2, "STRONG", 0, "2026-06-01T10:00:00Z", "{}");
  interaction.run(1, "imessage", "outbound", "2026-06-01T10:00:00Z", "CONFIDENTIAL-THREAD-TEXT", "m1", null);
  interaction.run(1, "imessage", "inbound", "2026-05-20T10:00:00Z", "more private text", "m2", null);
  interaction.run(1, "call", null, "2026-04-01T10:00:00Z", null, "c1", 1);
  interaction.run(1, "call", null, "2026-05-30T10:00:00Z", null, "c2", 0); // unanswered — excluded from stats
  interaction.run(1, "linkedin_invite", "inbound", "2026-01-01T10:00:00Z", null, "i1", null); // excluded
  identity.run(1, "linkedin_url", "https://www.linkedin.com/in/kari", "test");
  signal.run(1, "job_change", "2026-05-15T00:00:00Z", JSON.stringify({ from: "Beta", to: "Acme" }));

  contact.run("Ola Hansen", "Acme", null, "test", 1, null);
  pulse.run(2, 0.4, "WEAK", 1, "2025-10-01T10:00:00Z", "{}");
  interaction.run(2, "linkedin", "outbound", "2025-10-01T10:00:00Z", "li text", "l1", null);

  contact.run("Cold Person", null, null, "test", 1, null);
  pulse.run(3, 0, "NO_CONNECTION", 0, null, "{}");

  contact.run("+4791234567", null, null, "test", 0, null);
  pulse.run(4, 2.0, "GOOD", 0, "2026-06-01T00:00:00Z", "{}");

  return db;
}

describe("selectActiveContacts", () => {
  it("includes warm + dormant-warm resolved contacts, excludes cold and bare handles", () => {
    const db = seedDb();
    const active = selectActiveContacts(db);
    db.close();
    expect(active.map((c) => c.displayName)).toEqual(["Kari Nordmann", "Ola Hansen"]);
    expect(active[0]!.dormantWarm).toBe(false);
    expect(active[1]!.dormantWarm).toBe(true);
  });

  it("computes channel stats excluding invites and unanswered calls, and never selects content", () => {
    const db = seedDb();
    const active = selectActiveContacts(db); const kari = active[0]!;
    db.close();
    const byChannel = Object.fromEntries(kari.channels.map((ch) => [ch.channel, ch]));
    expect(byChannel.imessage).toMatchObject({ n: 2, lastAt: "2026-06-01T10:00:00Z" });
    expect(byChannel.call).toMatchObject({ n: 1 }); // unanswered call c2 excluded
    expect(byChannel.linkedin_invite).toBeUndefined();
    expect(JSON.stringify(active)).not.toContain("CONFIDENTIAL-THREAD-TEXT");
    expect(JSON.stringify(active)).not.toContain("li text");
  });

  it("carries linkedin url, twenty linkage and signals", () => {
    const db = seedDb();
    const kari = selectActiveContacts(db)[0]!;
    db.close();
    expect(kari.linkedinUrl).toBe("https://www.linkedin.com/in/kari");
    expect(kari.twentyId).toBe("twenty-abc");
    expect(kari.signals).toEqual([{ kind: "job_change", at: "2026-05-15T00:00:00Z", evidence: JSON.stringify({ from: "Beta", to: "Acme" }) }]);
  });
});

describe("slugify", () => {
  it("lowercases, strips diacritics, handles Norwegian letters", () => {
    expect(slugify("Kari Nordmann")).toBe("kari-nordmann");
    expect(slugify("Bjørn Åsen")).toBe("bjorn-asen");
    expect(slugify("Trær & Æsj AS")).toBe("traer-aesj-as");
    expect(slugify("Straße")).toBe("strasse");
  });
  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("unnamed");
  });
});

describe("assignSlugs", () => {
  it("suffixes the contact id on collisions only", () => {
    const fake = (id: number, displayName: string) => ({ id, displayName }) as BrainContact;
    const slugs = assignSlugs([fake(1, "John Smith"), fake(2, "John Smith"), fake(3, "Kari Nordmann")]);
    expect(slugs.get(1)).toBe("john-smith-1");
    expect(slugs.get(2)).toBe("john-smith-2");
    expect(slugs.get(3)).toBe("kari-nordmann");
  });
});

describe("preferredChannel", () => {
  it("picks the channel with the most interactions", () => {
    expect(
      preferredChannel([
        { channel: "imessage", n: 10, lastAt: "2026-01-01T00:00:00Z" },
        { channel: "linkedin", n: 3, lastAt: "2026-06-01T00:00:00Z" },
      ]),
    ).toBe("imessage");
  });
  it("breaks ties by recency", () => {
    expect(
      preferredChannel([
        { channel: "imessage", n: 3, lastAt: "2026-01-01T00:00:00Z" },
        { channel: "linkedin", n: 3, lastAt: "2026-06-01T00:00:00Z" },
      ]),
    ).toBe("linkedin");
  });
  it("returns null with no channels", () => {
    expect(preferredChannel([])).toBeNull();
  });
});

describe("composePersonNote", () => {
  function kari(): BrainContact {
    return {
      id: 1, displayName: "Kari Nordmann", company: "Acme", title: "CTO",
      band: "STRONG", dormantWarm: false, lastInteractionAt: "2026-06-01T10:00:00Z",
      twentyId: "twenty-abc", linkedinUrl: "https://www.linkedin.com/in/kari",
      channels: [
        { channel: "imessage", n: 2, lastAt: "2026-06-01T10:00:00Z" },
        { channel: "call", n: 1, lastAt: "2026-04-01T10:00:00Z" },
      ],
      signals: [{ kind: "job_change", at: "2026-05-15T00:00:00Z", evidence: '{"from":"Beta","to":"Acme"}' }],
    };
  }

  // 2026-09-07: the Brain's scope filter hides a private note from everyone but its `owner`.
  // These notes said `owner: network` — an importer, not a person — so all 520 of them were
  // invisible to Bendik himself. The owner is the person whose network this is; the importer
  // marks its files with `origin: network` instead, so retirement still finds them.
  it("renders Brain-convention frontmatter: owned by the person, marked as the importer's", () => {
    const note = composePersonNote(kari(), { created: "2026-06-11", companySlug: "acme", owner: "bendik" });
    expect(note).toContain('title: "Kari Nordmann"');
    expect(note).toContain("type: person");
    expect(note).toMatch(/^owner: bendik$/m);
    expect(note).toMatch(/^origin: network$/m);
    expect(note).not.toMatch(/^owner: network$/m);
    expect(note).toContain("created: 2026-06-11");
    expect(note).toContain("pulse_band: STRONG");
    expect(note).toContain("last_interaction: 2026-06-01");
    expect(note).toContain("tags: [network, person]");
  });

  it("renders facts: company wikilink, preferred channel, channel stats, CRM linkage, signals", () => {
    const note = composePersonNote(kari(), { created: "2026-06-11", companySlug: "acme", owner: "bendik" });
    expect(note).toContain("[[acme|Acme]]");
    expect(note).toContain("**Preferred channel:** iMessage");
    expect(note).toContain("iMessage — 2×, last 2026-06-01");
    expect(note).toContain("**CRM:** linked to Twenty");
    expect(note).toContain("- 2026-05-15 — job_change (from: Beta, to: Acme)");
  });

  it("marks dormant contacts and omits null fields", () => {
    const c = { ...kari(), dormantWarm: true, title: null, company: null, linkedinUrl: null, twentyId: null, signals: [] };
    const note = composePersonNote(c, { created: "2026-06-11", companySlug: null, owner: "bendik" });
    expect(note).toContain("dormant_warm: true");
    expect(note).toContain("reactivation");
    expect(note).not.toContain("**Title:**");
    expect(note).not.toContain("**Company:**");
    expect(note).not.toContain("## Signals");
    expect(note).toContain("**CRM:** not in Twenty");
  });

  it("created line matches the orchestrator's preservation regex", () => {
    const note = composePersonNote(kari(), { created: "2026-06-11", companySlug: "acme", owner: "bendik" });
    expect(note).toMatch(/^created: \d{4}-\d{2}-\d{2}$/m);
  });

  it("is deterministic", () => {
    expect(composePersonNote(kari(), { created: "2026-06-11", companySlug: "acme", owner: "bendik" }))
      .toBe(composePersonNote(kari(), { created: "2026-06-11", companySlug: "acme", owner: "bendik" }));
  });

  it("sanitizes hostile display data in body text but keeps frontmatter exact", () => {
    const hostile = 'Design | Build\n"AS]]';
    const c = { ...kari(), displayName: hostile, company: "We|ird ]] Co", title: "C:TO" };
    const note = composePersonNote(c, { created: "2026-06-11", companySlug: "weird-co", owner: "bendik" });
    expect(note).toContain(`title: ${JSON.stringify(hostile)}`); // frontmatter JSON-escaped, raw
    expect(note).toContain("# Design / Build \"AS)]"); // body heading cleaned
    expect(note).toContain("[[weird-co|We/ird )] Co]]"); // alias cleaned, link intact
    const summaryLines = note.split("\n").filter((l) => l.startsWith("> [!summary]"));
    expect(summaryLines).toHaveLength(1); // newline collapsed, callout is one line
  });

  it("summary 'via' names the most recent channel, not the busiest", () => {
    const c = {
      ...kari(),
      channels: [
        { channel: "imessage", n: 69, lastAt: "2026-01-12T10:00:00Z" },
        { channel: "call", n: 5, lastAt: "2026-05-28T10:00:00Z" },
      ],
      lastInteractionAt: "2026-05-28T10:00:00Z",
    };
    const note = composePersonNote(c, { created: "2026-06-11", companySlug: "acme", owner: "bendik" });
    expect(note).toContain("last contact 2026-05-28 via Phone");
    expect(note).toContain("**Preferred channel:** iMessage");
  });
});

describe("composeCompanyNote / composeMapPage", () => {
  const people: BrainContact[] = [
    { id: 1, displayName: "Kari Nordmann", company: "Acme", title: "CTO", band: "STRONG", dormantWarm: false, lastInteractionAt: "2026-06-01T10:00:00Z", twentyId: null, linkedinUrl: null, channels: [], signals: [] },
    { id: 2, displayName: "Ola Hansen", company: "Acme", title: null, band: "WEAK", dormantWarm: true, lastInteractionAt: "2025-10-01T10:00:00Z", twentyId: null, linkedinUrl: null, channels: [], signals: [] },
  ];
  const slugs = new Map([[1, "kari-nordmann"], [2, "ola-hansen"]]);

  it("company note lists people warmest-first with wikilinks", () => {
    const note = composeCompanyNote("Acme", people, slugs, { created: "2026-06-11", owner: "bendik" });
    expect(note).toContain("type: company");
    expect(note).toMatch(/^owner: bendik$/m);
    expect(note).toMatch(/^origin: network$/m);
    const kariIdx = note.indexOf("[[kari-nordmann|Kari Nordmann]]");
    const olaIdx = note.indexOf("[[ola-hansen|Ola Hansen]]");
    expect(kariIdx).toBeGreaterThan(-1);
    expect(olaIdx).toBeGreaterThan(kariIdx);
  });

  it("map page splits warm vs reactivation queue and lists companies", () => {
    const companies = new Map([["acme", { name: "Acme", people }]]);
    const map = composeMapPage(people, slugs, companies, { created: "2026-06-11", owner: "bendik" });
    expect(map).toContain("## Warm");
    expect(map).toContain("## Reactivation queue");
    expect(map.indexOf("## Warm")).toBeLessThan(map.indexOf("[[kari-nordmann|Kari Nordmann]]"));
    expect(map.indexOf("## Reactivation queue")).toBeLessThan(map.indexOf("[[ola-hansen|Ola Hansen]]"));
    expect(map).toContain("[[acme|Acme]] — 2");
    expect(map).toMatch(/^owner: bendik$/m);
    expect(map).toMatch(/^origin: network$/m);
  });

  it("throws loudly on a missing slug instead of writing a broken link", () => {
    expect(() => composeCompanyNote("Acme", people, new Map(), { created: "2026-06-11", owner: "bendik" })).toThrow(/no slug/);
    expect(() => composeMapPage(people, new Map(), new Map(), { created: "2026-06-11", owner: "bendik" })).toThrow(/no slug/);
  });
});

describe("regenerateBrainNotes", () => {
  function run(db: Db, vault: string, opts: { dryRun?: boolean; now?: Date } = {}) {
    return regenerateBrainNotes(db, { vaultPath: vault, now: opts.now ?? NOW, dryRun: opts.dryRun, owner: "bendik" });
  }

  it("writes person, company and map notes under wiki/", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    const r = run(db, vault);
    db.close();
    expect(r.written).toHaveLength(4); // 2 people + acme + network.md
    expect(existsSync(join(vault, "wiki", "people", "kari-nordmann.md"))).toBe(true);
    expect(existsSync(join(vault, "wiki", "people", "ola-hansen.md"))).toBe(true);
    expect(existsSync(join(vault, "wiki", "companies", "acme.md"))).toBe(true);
    expect(existsSync(join(vault, "wiki", "network.md"))).toBe(true);
  });

  it("never writes message content anywhere", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    run(db, vault);
    db.close();
    const all = [
      ...readdirSync(join(vault, "wiki", "people")).map((f) => join(vault, "wiki", "people", f)),
      ...readdirSync(join(vault, "wiki", "companies")).map((f) => join(vault, "wiki", "companies", f)),
      join(vault, "wiki", "network.md"),
    ].map((p) => readFileSync(p, "utf8")).join("\n");
    expect(all).not.toContain("CONFIDENTIAL-THREAD-TEXT");
    expect(all).not.toContain("more private text");
  });

  it("is idempotent: a second run writes nothing", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    run(db, vault);
    const second = run(db, vault);
    db.close();
    expect(second.written).toHaveLength(0);
    expect(second.unchanged).toBe(4);
    expect(second.deleted).toHaveLength(0);
  });

  it("preserves created: from an existing file when content changes", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    run(db, vault);
    // simulate an earlier generation date
    const path = join(vault, "wiki", "people", "kari-nordmann.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("created: 2026-06-11", "created: 2026-01-01"));
    // change the data so the note must be rewritten
    db.prepare("UPDATE contacts SET title = 'CEO' WHERE id = 1").run();
    const r = run(db, vault);
    db.close();
    expect(r.written).toContain(path);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("created: 2026-01-01");
    expect(after).toContain("**Title:** CEO");
  });

  it("retires stale owner:network notes to _archive but never touches other files", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    mkdirSync(join(vault, "wiki", "people"), { recursive: true });
    writeFileSync(join(vault, "wiki", "people", "gone-person.md"), "---\nowner: network\n---\nstale");
    writeFileSync(join(vault, "wiki", "people", "manual-note.md"), "---\ntype: person\n---\nBendik wrote this");
    const r = run(db, vault);
    db.close();
    expect(r.deleted).toEqual([join(vault, "wiki", "people", "gone-person.md")]);
    expect(existsSync(join(vault, "wiki", "people", "gone-person.md"))).toBe(false);
    // Tracked archive, not the gitignored .trash/: a cooled relationship stays
    // readable to agents on the box instead of living only on Bendik's Mac.
    expect(existsSync(join(vault, "_archive", "wiki", "people", "gone-person.md"))).toBe(true);
    expect(existsSync(join(vault, ".trash", "gone-person.md"))).toBe(false);
    expect(existsSync(join(vault, "wiki", "people", "manual-note.md"))).toBe(true);
  });

  it("retires a stale note written in the new form too — origin: network with a person as owner", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    mkdirSync(join(vault, "wiki", "people"), { recursive: true });
    const stale = join(vault, "wiki", "people", "gone-person.md");
    writeFileSync(stale, "---\ntitle: \"Gone\"\norigin: network\nowner: bendik\n---\nstale");
    // A hand-written note that merely has an owner is never ours to retire.
    writeFileSync(join(vault, "wiki", "people", "manual-note.md"), "---\ntype: person\nowner: bendik\n---\nBendik wrote this");
    const r = run(db, vault);
    db.close();
    expect(r.deleted).toEqual([stale]);
    expect(existsSync(join(vault, "_archive", "wiki", "people", "gone-person.md"))).toBe(true);
    expect(existsSync(join(vault, "wiki", "people", "manual-note.md"))).toBe(true);
  });

  it("archives people and companies separately, so a shared filename cannot collide", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    mkdirSync(join(vault, "wiki", "people"), { recursive: true });
    mkdirSync(join(vault, "wiki", "companies"), { recursive: true });
    // A name that is NOT in the active set, so both files are stale and get
    // retired. ("acme" would not work — the seed's live company is Acme.)
    writeFileSync(join(vault, "wiki", "people", "kim-vinter.md"), "---\nowner: network\n---\nperson kim");
    writeFileSync(join(vault, "wiki", "companies", "kim-vinter.md"), "---\nowner: network\n---\ncompany kim");
    run(db, vault);
    db.close();
    expect(readFileSync(join(vault, "_archive", "wiki", "people", "kim-vinter.md"), "utf8")).toContain("person kim");
    expect(readFileSync(join(vault, "_archive", "wiki", "companies", "kim-vinter.md"), "utf8")).toContain("company kim");
  });

  it("reclaims an archived note when the contact turns warm again — never two copies", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    run(db, vault);
    const live = join(vault, "wiki", "people", "kari-nordmann.md");
    const archived = join(vault, "_archive", "wiki", "people", "kari-nordmann.md");

    // Cool her off: she drops out of the active set and is archived.
    db.prepare("UPDATE pulse SET band = 'WEAK', dormant_warm = 0 WHERE contact_id = 1").run();
    run(db, vault);
    expect(existsSync(live)).toBe(false);
    expect(existsSync(archived)).toBe(true);

    // She warms up again. The live note returns and the archived copy must go —
    // otherwise a search finds two notes for one person and the stale one wins
    // as often as not.
    db.prepare("UPDATE pulse SET band = 'GOOD' WHERE contact_id = 1").run();
    run(db, vault);
    db.close();
    expect(existsSync(live)).toBe(true);
    expect(existsSync(archived)).toBe(false);
  });

  it("dry-run reports the plan and touches nothing", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    const r = run(db, vault, { dryRun: true });
    db.close();
    expect(r.dryRun).toBe(true);
    expect(r.written).toHaveLength(4);
    expect(existsSync(join(vault, "wiki"))).toBe(false);
  });

  it("does not retire notes that merely mention the marker in body text", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    mkdirSync(join(vault, "wiki", "people"), { recursive: true });
    const essay = join(vault, "wiki", "people", "essay.md");
    writeFileSync(essay, "---\ntype: person\n---\nAbout the convention:\nowner: network\nis the marker line");
    const r = run(db, vault);
    db.close();
    expect(r.deleted).toHaveLength(0);
    expect(existsSync(essay)).toBe(true);
  });

  it("dry-run lists planned retirements without moving anything", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    mkdirSync(join(vault, "wiki", "people"), { recursive: true });
    const stale = join(vault, "wiki", "people", "gone-person.md");
    writeFileSync(stale, "---\nowner: network\n---\nstale");
    const r = run(db, vault, { dryRun: true });
    db.close();
    expect(r.deleted).toEqual([stale]);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(vault, "_archive"))).toBe(false);
  });

  it("self-heals a slug collision across runs: old file retired, suffixed files written", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    run(db, vault);
    db.prepare("INSERT INTO contacts (display_name, company, title, source, resolved) VALUES ('Kari Nordmann', 'Beta', NULL, 'test', 1)").run();
    db.prepare("INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components) VALUES (5, 3.0, 'GOOD', 0, '2026-06-05T00:00:00Z', '{}')").run();
    const r = run(db, vault);
    db.close();
    expect(existsSync(join(vault, "wiki", "people", "kari-nordmann.md"))).toBe(false);
    expect(existsSync(join(vault, "wiki", "people", "kari-nordmann-1.md"))).toBe(true);
    expect(existsSync(join(vault, "wiki", "people", "kari-nordmann-5.md"))).toBe(true);
    expect(r.deleted).toEqual([join(vault, "wiki", "people", "kari-nordmann.md")]);
  });

  it("skips an unreadable planned file instead of aborting the run", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    run(db, vault);
    const kariPath = join(vault, "wiki", "people", "kari-nordmann.md");
    chmodSync(kariPath, 0o000);
    db.prepare("UPDATE contacts SET title = 'CEO' WHERE id = 1").run();
    try {
      const r = run(db, vault);
      expect(r.skipped).toEqual([kariPath]);
      expect(r.written.length).toBeGreaterThan(0); // the rest of the run proceeded
    } finally {
      chmodSync(kariPath, 0o644);
      db.close();
    }
  });

  it("never overwrites a hand-authored file sitting at a planned path", () => {
    const db = seedDb();
    const vault = tempDir("vault-");
    mkdirSync(join(vault, "wiki", "people"), { recursive: true });
    const path = join(vault, "wiki", "people", "kari-nordmann.md");
    writeFileSync(path, "---\ntype: person\n---\nBendik's own Kari page");
    const r = run(db, vault);
    db.close();
    expect(r.skipped).toEqual([path]);
    expect(readFileSync(path, "utf8")).toContain("Bendik's own Kari page");
  });
});

describe("meta channel labels", () => {
  it("renders Instagram and Facebook channel labels in a person note", () => {
    const note = composePersonNote(
      {
        id: 1,
        displayName: "Test Person",
        company: null,
        title: null,
        band: "GOOD",
        dormantWarm: false,
        twentyId: null,
        linkedinUrl: null,
        lastInteractionAt: "2026-06-01T00:00:00Z",
        channels: [
          { channel: "instagram", n: 5, lastAt: "2026-06-01T00:00:00Z" },
          { channel: "facebook", n: 3, lastAt: "2026-05-01T00:00:00Z" },
        ],
        signals: [],
      },
      { created: "2026-06-11T00:00:00Z", companySlug: null, owner: "bendik" },
    );
    expect(note).toContain("Instagram");
    expect(note).toContain("Facebook");
    expect(note).not.toContain("instagram —"); // raw channel key must not leak as a label
  });
});
