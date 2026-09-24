import { describe, it, expect, beforeEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../lib/db.js";
import { importMeta } from "../lib/importers/meta.js";
import { upsertContact } from "../lib/resolve.js";
import { fixMojibake, participantNames, igUsername } from "../lib/importers/meta.js";

const META_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "meta");
const OWN_NAME = "Bendik Heiberg";

describe("meta helpers", () => {
  it("repairs double-encoded mojibake", () => {
    expect(fixMojibake("HÃ¸stmark")).toBe("Høstmark");
    expect(fixMojibake("MachÃ©")).toBe("Maché");
    expect(fixMojibake("Plain Ascii")).toBe("Plain Ascii");
  });

  it("normalizes both participant shapes to repaired names", () => {
    expect(participantNames([{ name: "JÃ¸rund Johansen" }, { name: "Bendik Heiberg" }])).toEqual([
      "Jørund Johansen",
      "Bendik Heiberg",
    ]);
    expect(participantNames(["Aksel Aannerud", "Bendik Heiberg"])).toEqual(["Aksel Aannerud", "Bendik Heiberg"]);
  });

  it("extracts the instagram username from a thread_path", () => {
    expect(igUsername("inbox/jorundjohansen_567196094678567")).toBe("jorundjohansen");
    expect(igUsername(undefined)).toBeNull();
    expect(igUsername("inbox/nounderscore")).toBeNull();
  });
});

describe("importMeta — DMs", () => {
  let db: Db;
  beforeEach(() => { db = openDb(":memory:"); });

  it("ingests instagram and facebook(messenger) 1:1 threads, skipping groups/bots/requests", () => {
    const s = importMeta(db, META_FIXTURES, OWN_NAME);
    expect(s.instagram.messages).toBe(3); // jorund 2 (attachment skipped) + ola 1
    expect(s.facebook.messages).toBe(2);  // aksel 2; empty thread 0
    const ig = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='instagram'").get() as { n: number };
    expect(ig.n).toBe(3);
    const fb = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='facebook'").get() as { n: number };
    expect(fb.n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE display_name='Meta AI'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE display_name='Cold Sender'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE display_name='A Person'").get()).toEqual({ n: 0 });
  });

  it("reads the encrypted Messenger schema (senderName/text/timestamp) and classifies direction", () => {
    importMeta(db, META_FIXTURES, OWN_NAME);
    const c = db.prepare("SELECT id FROM contacts WHERE display_name='Aksel Aannerud'").get() as { id: number };
    expect(c).toBeTruthy();
    const rows = db
      .prepare("SELECT direction, content FROM interactions WHERE contact_id=? AND channel='facebook' ORDER BY at")
      .all(c.id) as { direction: string; content: string }[];
    // 2 text messages ingested (the media row has no text and is skipped)
    expect(rows).toEqual([
      { direction: "inbound", content: "Long time no see" },
      { direction: "outbound", content: "Indeed!" },
    ]);
  });

  it("classifies direction by sender and repairs mojibake names", () => {
    importMeta(db, META_FIXTURES, OWN_NAME);
    const c = db.prepare("SELECT id FROM contacts WHERE display_name='Jørund Johansen'").get() as { id: number };
    expect(c).toBeTruthy();
    const dirs = db.prepare("SELECT direction FROM interactions WHERE contact_id=? ORDER BY at").all(c.id) as { direction: string }[];
    expect(dirs).toEqual([{ direction: "inbound" }, { direction: "outbound" }]);
  });

  it("links to an existing contact only on a unique name match", () => {
    upsertContact(db, { displayName: "Jørund Johansen", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/jorund" }] });
    const s = importMeta(db, META_FIXTURES, OWN_NAME);
    expect(s.linkedExisting).toBeGreaterThanOrEqual(1);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE display_name='Jørund Johansen'").get() as { n: number };
    expect(rows.n).toBe(1);
    const idn = db.prepare("SELECT COUNT(*) AS n FROM identities WHERE kind='instagram' AND value='jorundjohansen'").get() as { n: number };
    expect(idn.n).toBe(1);
  });

  it("does not link when the name is ambiguous (two same-named contacts)", () => {
    upsertContact(db, { displayName: "Ola Nordmann", source: "contacts", identities: [{ kind: "email", value: "ola1@example.com" }] });
    upsertContact(db, { displayName: "Ola Nordmann", source: "contacts", identities: [{ kind: "email", value: "ola2@example.com" }] });
    importMeta(db, META_FIXTURES, OWN_NAME);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE display_name='Ola Nordmann'").get() as { n: number };
    expect(rows.n).toBe(3);
  });

  it("collapses facebook + messenger of the same name via meta_name and is idempotent", () => {
    importMeta(db, META_FIXTURES, OWN_NAME);
    const before = db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as { n: number };
    const beforeC = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
    importMeta(db, META_FIXTURES, OWN_NAME);
    const after = db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as { n: number };
    const afterC = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(afterC.n).toBe(beforeC.n);
  });
});

describe("importMeta — handle directory", () => {
  let db: Db;
  beforeEach(() => { db = openDb(":memory:"); });

  it("stores following/followers/threads/friends rows with the right relations", () => {
    const s = importMeta(db, META_FIXTURES, OWN_NAME);
    expect(s.handles.stored).toBeGreaterThanOrEqual(5);
    const byRel = (rel: string) => (db.prepare("SELECT COUNT(*) AS n FROM handles WHERE relation=?").get(rel) as { n: number }).n;
    expect(byRel("following")).toBe(1);
    expect(byRel("follower")).toBe(1);
    expect(byRel("threads_following")).toBe(1);
    expect(byRel("threads_follower")).toBe(1);
    expect(byRel("friend")).toBe(1);
    const sb = db.prepare("SELECT handle, display_name FROM handles WHERE relation='following'").get() as { handle: string; display_name: string | null };
    expect(sb.handle).toBe("somebrand");
    expect(sb.display_name).toBeNull();
    const fr = db.prepare("SELECT handle, display_name FROM handles WHERE relation='friend'").get() as { handle: string | null; display_name: string };
    expect(fr.handle).toBeNull();
    expect(fr.display_name).toBe("Morten Sandberg");
  });

  it("enriches an existing same-named contact with the Threads instagram handle", () => {
    const cid = upsertContact(db, { displayName: "Arnt Christian Scheele", source: "contacts", identities: [{ kind: "email", value: "arnt@example.com" }] });
    const s = importMeta(db, META_FIXTURES, OWN_NAME);
    expect(s.handles.linkedToContacts).toBeGreaterThanOrEqual(1);
    const idn = db.prepare("SELECT contact_id FROM identities WHERE kind='instagram' AND value='twistedmind'").get() as { contact_id: number } | undefined;
    expect(idn?.contact_id).toBe(cid);
    const row = db.prepare("SELECT contact_id FROM handles WHERE handle='twistedmind'").get() as { contact_id: number | null };
    expect(row.contact_id).toBe(cid);
  });

  it("is idempotent — re-import adds no duplicate handles", () => {
    importMeta(db, META_FIXTURES, OWN_NAME);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM handles").get() as { n: number }).n;
    importMeta(db, META_FIXTURES, OWN_NAME);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM handles").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
