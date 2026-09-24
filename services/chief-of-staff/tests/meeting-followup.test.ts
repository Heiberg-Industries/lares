import { describe, it, expect } from "vitest";
import {
  stripFootnoteAnchors, parseActionItems, parseAttendees, buildFollowupPrompt,
  filterActionItemsForExternals, hashSummaryBlock } from "../lib/meeting-followup.js";

describe("hashSummaryBlock (LAR-28)", () => {
  it("is stable for the identical block", () => {
    const block = "### Handlingspunkter\n- Stefan: domener";
    expect(hashSummaryBlock(block)).toBe(hashSummaryBlock(block));
  });

  it("changes when the block's content changes — the whole point of the reclaim rule", () => {
    const before = "### Handlingspunkter\n- Stefan: domener";
    const after = "### Handlingspunkter\n- Kjetil: domener"; // the owner corrected who is responsible
    expect(hashSummaryBlock(before)).not.toBe(hashSummaryBlock(after));
  });

  it("ignores leading/trailing whitespace Notion's renderer may add or drop", () => {
    const block = "### Handlingspunkter\n- Stefan: domener";
    expect(hashSummaryBlock(block)).toBe(hashSummaryBlock(`  ${block}  \n\n`));
  });

  it("is never the same for genuinely different content, even superficially similar", () => {
    expect(hashSummaryBlock("a")).not.toBe(hashSummaryBlock("b"));
  });
});

describe("stripFootnoteAnchors", () => {
  it("removes Notion transcript deep-links, which externals cannot open", () => {
    const raw = "Stefan: sjekker domener [^https://app.notion.com/p/3c6cc987b45#3c6cc987b457] i SE/DK";
    expect(stripFootnoteAnchors(raw)).toBe("Stefan: sjekker domener i SE/DK");
  });

  it("removes several anchors on one line without eating the words between them", () => {
    const raw = "A [^https://app.notion.com/p/a#b] og B [^https://app.notion.com/p/c#d] og C";
    expect(stripFootnoteAnchors(raw)).toBe("A og B og C");
  });

  it("leaves ordinary text and ordinary links alone", () => {
    expect(stripFootnoteAnchors("se folkepuls.no for mer")).toBe("se folkepuls.no for mer");
  });
});

describe("parseActionItems", () => {
  it("splits Notion's <br>-joined list and drops the bullet markers", () => {
    const raw = "- Bendik: setter opp infrastruktur<br>- Stefan: sjekker domener<br>- Alle: ett navn";
    expect(parseActionItems(raw)).toEqual([
      "Bendik: setter opp infrastruktur",
      "Stefan: sjekker domener",
      "Alle: ett navn",
    ]);
  });

  it("strips footnote anchors from each item", () => {
    const raw = "- Stefan: domener [^https://app.notion.com/p/a#b]<br>- Alle: ett navn";
    expect(parseActionItems(raw)).toEqual(["Stefan: domener", "Alle: ett navn"]);
  });

  it("returns [] for an empty field rather than one empty item", () => {
    expect(parseActionItems("")).toEqual([]);
    expect(parseActionItems("<br><br>")).toEqual([]);
  });
});

describe("parseAttendees", () => {
  it("reads the `Name <email>, …` format ORB-155 writes", () => {
    const raw = "kjetiltu <taylor@example.com>, Stefan <sam@example.com>, bendik <owner@owner.example>";
    expect(parseAttendees(raw)).toEqual([
      { name: "kjetiltu", email: "taylor@example.com" },
      { name: "Stefan", email: "sam@example.com" },
      { name: "bendik", email: "owner@owner.example" },
    ]);
  });

  it("ignores a malformed entry instead of inventing an address", () => {
    // A half-parsed address is a wrong recipient. Dropping it means the card shows fewer
    // people than expected, which a human notices; inventing one means a stranger gets mail.
    expect(parseAttendees("Stefan, ada <ada@x.co>")).toEqual([{ name: "ada", email: "ada@x.co" }]);
  });

  it("returns [] for an empty field", () => {
    expect(parseAttendees("")).toEqual([]);
  });

  it("drops a segment with two bracketed addresses rather than half-parsing it", () => {
    // A lazy name-capture would backtrack past the first "<a@x.co>", swallow it into the
    // name, and return the second address as if the entry were well-formed — a REAL address
    // silently lost and a stray "<...>" left in the name. That is worse than the plain
    // malformed case above: it doesn't even look wrong on the approval card. Dropping the
    // whole segment is the same rule as everywhere else in this function: an entry that
    // isn't cleanly "Name <email>" gets no address at all, not a guessed one.
    expect(parseAttendees("Weird <a@x.co> <b@x.co>, ada <ada@x.co>")).toEqual([
      { name: "ada", email: "ada@x.co" },
    ]);
  });
});

describe("buildFollowupPrompt", () => {
  const input = {
    title: "Folkepuls",
    whenIso: "2026-08-24T10:00:00.000+02:00",
    summaryBlock: "### Handlingspunkter\n- Stefan: domener",
    actionItems: ["Stefan: sjekker domener", "Alle: ett navn"],
    recipients: ["sam@example.com", "taylor@example.com"],
    lang: "no" as const,
    voiceBlock: "VOICE CARD: kort, direkte.",
  };

  it("includes the summary block, every action item, and the voice card", () => {
    const prompt = buildFollowupPrompt(input);
    expect(prompt).toContain("### Handlingspunkter");
    expect(prompt).toContain("Stefan: sjekker domener");
    expect(prompt).toContain("Alle: ett navn");
    expect(prompt).toContain("VOICE CARD: kort, direkte.");
  });

  it("forbids inventing commitments and forbids any Notion link", () => {
    // Both are hard rules from the spec, and both are the kind of thing a model will do by
    // default if not told otherwise: recaps attract invented next steps, and a summary that
    // came from Notion attracts a link back to it.
    const prompt = buildFollowupPrompt(input);
    expect(prompt.toLowerCase()).toContain("notion");
    expect(prompt).toMatch(/never .*link|no .*link|ikke .*lenke/i);
  });

  it("forbids a model-written closing or sign-off", () => {
    const prompt = buildFollowupPrompt(input);
    expect(prompt).toMatch(/do not write any closing line or sign-off/i);
    expect(prompt).not.toContain("then one closing line");
  });

  it("names the language so a Norwegian meeting does not get an English recap", () => {
    expect(buildFollowupPrompt(input)).toMatch(/norsk|Norwegian/i);
    expect(buildFollowupPrompt({ ...input, lang: "en" })).toMatch(/English/i);
  });

  it("never contains the word transcript as content to include", () => {
    expect(buildFollowupPrompt(input)).not.toContain("<transcript>");
  });
});

// 2026-09-08: a one-off intro (no series) sent an external the full internal action list —
// "Amalie's fund/PE-partner work", "publisere intern kode". For a meeting without a series, only
// the action items that involve the recipients are shared; an item that names only the member is
// theirs alone and is dropped. Items naming nobody are shared. Recurring series keep everything
// (the list is the team's shared record) — the caller decides, this is the pure rule.
describe("filterActionItemsForExternals — one-off follow-ups keep only the shared items", () => {
  const names = { self: ["Bendik Heiberg", "Bendik"], recipients: ["Lars Christian Andrésen", "Lars Christian"] };

  it("drops an item that names only the member", () => {
    expect(filterActionItemsForExternals(["Bendik: fikse login slik at andre kan slippes inn", "Bendik publiserer intern kode"], names)).toEqual([]);
  });

  it("keeps an item that names a recipient, even when it names the member too", () => {
    const items = ["Bendik og Lars Christian avtaler neste møte", "Lars Christian sender pitch deck", "Bendik: send Lars Christian the demo link"];
    expect(filterActionItemsForExternals(items, names)).toEqual(items);
  });

  it("keeps an item that names nobody — shared by default", () => {
    expect(filterActionItemsForExternals(["Undersøke finansieringsmuligheter", "Neste møte: fredag 13:15"], names)).toEqual(["Undersøke finansieringsmuligheter", "Neste møte: fredag 13:15"]);
  });

  it("matches names on word boundaries and case-insensitively — 'bendik' inside another word is not him", () => {
    expect(filterActionItemsForExternals(["Send the Bendikssen invoice", "bendik ringer banken"], names)).toEqual(["Send the Bendikssen invoice"]);
  });
});
