/**
 * The card layer's contract (ADR-0025 rule 9): the rules every door must get, run over every door
 * in the layer's table with a fake record. A door adapter (Slack, Telegram, web chat) has its own
 * test beside its code that drives the real adapter through the same cases; this file is the
 * rules themselves, and it fails if a door is added to the table without being covered here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CARD_DOORS, decideTap, findCard, isCardDoor, placesShowingWhole, textShownWhole, type CardDb } from "../src/card-layer.js";
import * as sentences from "../src/card-sentences.js";
import { shortenedCardSentence } from "../src/card-sentences.js";

// The doors come from the layer's table, so a door added there is run through every case below.
const ownerDoors = Object.entries(CARD_DOORS).filter(([, row]) => row.answeredBy === "owner").map(([name]) => name);
const memberDoors = Object.entries(CARD_DOORS).filter(([, row]) => row.answeredBy === "card-member").map(([name]) => name);
const OWNER = "U_OWNER";
const ownerOf = (door: string) => `${OWNER}-${door}`;

interface Row {
  request_id: string; kind: string; door: string | null; put_to: string | null; shown_whole: boolean | null;
  acting_member_id: string | null; outcome: string | null; used_at: unknown; address?: { channel: string; message: string };
}
/** A fake card record: finds a row by request id (with the optional narrowing) or by address. */
function fakeRecord(rows: Row[], fail = false): CardDb {
  return {
    async query(sql, values) {
      if (fail) throw new Error("database unavailable");
      if (sql.includes("card_address")) {
        const [door, channel, message] = values as string[];
        return { rows: rows.filter((r) => r.door === door && r.address?.channel === channel && r.address?.message === message) as never };
      }
      const [id, ...narrow] = values as string[];
      void narrow;
      return { rows: rows.filter((r) => r.request_id === id) as never };
    },
  };
}
const card = (over: Partial<Row> & { request_id: string }): Row => ({
  kind: "approval", door: null, put_to: null, shown_whole: true, acting_member_id: null, outcome: null, used_at: null, ...over,
});

describe("the door table", () => {
  it("every door in the table is run through this contract, and an unknown door is no door", () => {
    expect([...ownerDoors, ...memberDoors].sort()).toEqual(Object.keys(CARD_DOORS).sort());
    expect(Object.keys(CARD_DOORS).length).toBeGreaterThanOrEqual(3);
    expect(isCardDoor("whatsapp")).toBe(false);
    expect(isCardDoor("toString")).toBe(false);
  });

  it("an unknown door fails closed: nothing is delivered, even for what looks like the owner", async () => {
    const verdict = await decideTap({ door: "whatsapp", tapper: OWNER, cards: [] }, { ownerOf: () => OWNER });
    expect(verdict).toEqual({ deliver: false, why: "refused", sentence: sentences.CARD_REFUSED });
  });
});

describe.each(ownerDoors)("the rules on %s", (door) => {
  const owner = ownerOf(door);
  const member = `U_MEMBER-${door}`;
  const lookup = (id: string) => ({ requestId: id });

  it("a tap from nobody the door can name starts nothing", async () => {
    expect((await decideTap({ door, tapper: undefined, cards: [lookup("a")] }, { ownerOf, db: fakeRecord([card({ request_id: "a" })]) })).deliver).toBe(false);
    expect((await decideTap({ door, tapper: "", cards: [lookup("a")] }, { ownerOf, db: fakeRecord([card({ request_id: "a" })]) })).deliver).toBe(false);
  });

  it("the owner's tap on a waiting approval is delivered", async () => {
    expect(await decideTap({ door, tapper: owner, cards: [lookup("a")] }, { ownerOf, db: fakeRecord([card({ request_id: "a", door })]) })).toEqual({ deliver: true });
  });

  it("a member's tap on an approval is refused with the kit's sentence", async () => {
    expect(await decideTap({ door, tapper: member, cards: [lookup("a")] }, { ownerOf, db: fakeRecord([card({ request_id: "a", door })]) }))
      .toEqual({ deliver: false, why: "refused", sentence: sentences.CARD_REFUSED });
  });

  it("a question takes the answer of the person it was put to, and refuses everybody else, the owner included", async () => {
    const db = fakeRecord([card({ request_id: "q", kind: "question", door, put_to: member })]);
    expect(await decideTap({ door, tapper: member, cards: [lookup("q")] }, { ownerOf, db })).toEqual({ deliver: true });
    expect((await decideTap({ door, tapper: owner, cards: [lookup("q")] }, { ownerOf, db })).deliver).toBe(false);
    expect((await decideTap({ door, tapper: "U_STRANGER", cards: [lookup("q")] }, { ownerOf, db })).deliver).toBe(false);
  });

  it("a question with nobody recorded is the owner's to answer", async () => {
    const db = fakeRecord([card({ request_id: "q", kind: "question", door })]);
    expect((await decideTap({ door, tapper: owner, cards: [lookup("q")] }, { ownerOf, db })).deliver).toBe(true);
    expect((await decideTap({ door, tapper: member, cards: [lookup("q")] }, { ownerOf, db })).deliver).toBe(false);
  });

  it("a late or second tap on a settled card starts nothing and is told the kit's sentence", async () => {
    for (const settled of [{ outcome: "approved" }, { outcome: "cancelled" }, { outcome: null, used_at: new Date() }]) {
      const db = fakeRecord([card({ request_id: "a", door, ...settled })]);
      expect(await decideTap({ door, tapper: owner, cards: [lookup("a")] }, { ownerOf, db }))
        .toEqual({ deliver: false, why: "settled", sentence: sentences.CARD_NO_LONGER_WAITING });
    }
  });

  it("a card is found by where it sits on the platform", async () => {
    const db = fakeRecord([card({ request_id: "a", door, address: { channel: "C1", message: "7" } })]);
    const at = (message: string) => ({ door, address: { channel: "C1", message } });
    expect(await decideTap({ door, tapper: owner, cards: [at("7")] }, { ownerOf, db })).toEqual({ deliver: true });
    expect((await decideTap({ door, tapper: member, cards: [at("7")] }, { ownerOf, db })).deliver).toBe(false);
    const settled = fakeRecord([card({ request_id: "a", door, outcome: "approved", address: { channel: "C1", message: "7" } })]);
    expect((await decideTap({ door, tapper: owner, cards: [at("7")] }, { ownerOf, db: settled }))).toMatchObject({ why: "settled" });
  });

  it("on an unknown card the owner's tap reaches eve and a member's is refused", async () => {
    const db = fakeRecord([]);
    expect(await decideTap({ door, tapper: owner, cards: [lookup("nobody-knows")] }, { ownerOf, db })).toEqual({ deliver: true });
    expect(await decideTap({ door, tapper: owner, cards: [] }, { ownerOf, db })).toEqual({ deliver: true });
    expect(await decideTap({ door, tapper: member, cards: [lookup("nobody-knows")] }, { ownerOf, db }))
      .toEqual({ deliver: false, why: "refused", sentence: sentences.CARD_REFUSED });
  });

  it("a record that cannot be read lets the owner through to eve and holds everybody else back", async () => {
    const db = fakeRecord([], true);
    expect(await decideTap({ door, tapper: owner, cards: [lookup("a")] }, { ownerOf, db })).toEqual({ deliver: true });
    expect(await decideTap({ door, tapper: member, cards: [lookup("a")] }, { ownerOf, db }))
      .toEqual({ deliver: false, why: "unchecked", sentence: sentences.CARD_UNCHECKED });
  });

  it("an owner id that cannot be read names nobody", async () => {
    const unreadable = () => { throw new Error("environment not readable"); };
    expect((await decideTap({ door, tapper: owner, cards: [lookup("a")] }, { ownerOf: unreadable, db: fakeRecord([card({ request_id: "a" })]) })).deliver).toBe(false);
  });

  it("no owner on record means nobody is the owner", async () => {
    expect((await decideTap({ door, tapper: owner, cards: [lookup("a")] }, { ownerOf: () => undefined, db: fakeRecord([card({ request_id: "a" })]) })).deliver).toBe(false);
  });
});

describe.each(memberDoors)("the rules on %s, where each conversation is one member's", (door) => {
  const lookup = { requestId: "a", agent: "agent", sessionId: "s", memberId: "m1" };
  const db = (over: Partial<Row> = {}) => fakeRecord([card({ request_id: "a", door, acting_member_id: "m1", ...over })]);

  it("the member the card was raised for may answer a waiting card", async () => {
    expect(await decideTap({ door, tapper: "m1", cards: [lookup] }, { db: db() })).toEqual({ deliver: true });
  });
  it("another member may not", async () => {
    expect((await decideTap({ door, tapper: "m2", cards: [lookup] }, { db: db() })).deliver).toBe(false);
  });
  it("a settled card is no longer waiting", async () => {
    expect(await decideTap({ door, tapper: "m1", cards: [lookup] }, { db: db({ outcome: "approved" }) }))
      .toEqual({ deliver: false, why: "settled", sentence: sentences.CARD_NO_LONGER_WAITING });
  });
  it("a card with no record fails closed for everyone, owner or not, with the same sentence as before", async () => {
    expect(await decideTap({ door, tapper: "m1", cards: [lookup] }, { db: fakeRecord([]) }))
      .toMatchObject({ deliver: false, why: "settled", sentence: sentences.CARD_NO_LONGER_WAITING });
  });
  it("an unreadable record is not sent on", async () => {
    expect(await decideTap({ door, tapper: "m1", cards: [lookup] }, { db: fakeRecord([], true) }))
      .toMatchObject({ deliver: false, why: "unchecked" });
  });
});

describe("a shortened card (D-6)", () => {
  it("recognises the notices a cut leaves", () => {
    expect(textShownWhole("A short card")).toBe(true);
    expect(textShownWhole("body\n\n— shortened — 12 characters are not shown.")).toBe(false);
    expect(textShownWhole("Send mail (shortened)")).toBe(false);
    expect(textShownWhole("body…(truncated)")).toBe(false);
  });

  it("points to the places that show a card whole, in the order of the table, in words that are true of each", () => {
    expect(placesShowingWhole()).toEqual([{ where: "the Waiting on you page in the console", hasLink: true }]);
    expect(shortenedCardSentence(placesShowingWhole(), "https://console.example/waiting?request=r"))
      .toBe("The request above is shortened, so it cannot be approved here. Open it in the Waiting on you page in the console, where it shows in full, to approve it. The page for this request: https://console.example/waiting?request=r\nDeny still works here.");
    // Without an address, the sentence still names the page and invents no link.
    expect(shortenedCardSentence(placesShowingWhole(), null)).not.toContain("http");
    expect(shortenedCardSentence(placesShowingWhole(), null)).toContain("Waiting on you page in the console");
    // Once Slack shows a long card whole its row says so, and the same words name it first.
    const slack = { where: "Slack", hasLink: false };
    expect(shortenedCardSentence([slack, ...placesShowingWhole()], "https://console.example/x"))
      .toBe("The request above is shortened, so it cannot be approved here. Open it in Slack or the Waiting on you page in the console, where it shows in full, to approve it. The page for this request: https://console.example/x\nDeny still works here.");
    expect(shortenedCardSentence([slack], "https://console.example/x")).not.toContain("https://");
    expect(shortenedCardSentence([], null)).toBe("The request above is shortened, so it cannot be approved here. Deny still works here.");
  });
});

describe("where a person is sent to read a card too long for its door", () => {
  const SLACK_LIST = "SLACK_ALLOWED_USER_IDS";
  const sentence = (env: NodeJS.ProcessEnv, link: string | null) => shortenedCardSentence(placesShowingWhole(env), link);

  it("Slack's row says it draws a long card whole; the console's page is the only place that lists every door's cards", () => {
    expect(CARD_DOORS["slack"]!.showsLongCardWhole).toBe(true);
    expect(CARD_DOORS["slack"]!.listsCardsFromEveryDoor).toBe(false);
    expect(CARD_DOORS["telegram"]!.showsLongCardWhole).toBe(false);
    expect(CARD_DOORS["console"]!.listsCardsFromEveryDoor).toBe(true);
  });

  it.each([
    ["Slack connected, console address set", { [SLACK_LIST]: "U_OWNER" }, "https://console.example/waiting?request=r"],
    ["Slack connected, no console address", { [SLACK_LIST]: "U_OWNER" }, null],
    ["Slack not connected, console address set", {}, "https://console.example/waiting?request=r"],
    ["Slack not connected, no console address", {}, null],
  ] as const)("%s: names the page in the console, never Slack (the request is not on Slack), and a link only when there is one", (_name, env, link) => {
    const text = sentence(env, link);
    expect(text).toContain("Open it in the Waiting on you page in the console, where it shows in full, to approve it.");
    expect(text).not.toContain("Slack");
    expect(text).not.toContain("Telegram");
    expect(text.includes("http")).toBe(link !== null);
    expect(text.endsWith("\nDeny still works here.")).toBe(true);
  });

  it("a door that lists every door's cards is named only while it is connected, best first", () => {
    const doors = {
      first: { ...CARD_DOORS["console"]!, whereToOpen: "First", opensWithLink: false, connected: (env: NodeJS.ProcessEnv) => env["FIRST"] === "yes" },
      console: CARD_DOORS["console"]!,
    };
    expect(placesShowingWhole({ FIRST: "yes" }, doors).map((p) => p.where)).toEqual(["First", "the Waiting on you page in the console"]);
    expect(placesShowingWhole({}, doors).map((p) => p.where)).toEqual(["the Waiting on you page in the console"]);
    const broken = { ...doors, first: { ...doors.first, connected: () => { throw new Error("unreadable"); } } };
    expect(placesShowingWhole({}, broken).map((p) => p.where)).toEqual(["the Waiting on you page in the console"]);
  });

  it("a door that shows a long card whole but lists only its own is never named for a card cut elsewhere", () => {
    const only = { slack: { ...CARD_DOORS["slack"]!, connected: () => true } };
    expect(placesShowingWhole({}, only)).toEqual([]);
  });

  it("door names are plain words", () => {
    expect(sentences.doorName("telegram")).toBe("Telegram");
    expect(sentences.doorName("slack")).toBe("Slack");
    expect(sentences.doorName("console")).toBe("web chat");
    expect(sentences.doorName("web")).toBe("web chat");
    for (const [id, row] of Object.entries(CARD_DOORS)) expect(row.label, id).toBe(sentences.doorName(id));
  });
});

describe("the card record lookup", () => {
  it("two rows for one card are as good as none", async () => {
    const rows = [card({ request_id: "a" }), card({ request_id: "a" })];
    expect(await findCard(fakeRecord(rows), { requestId: "a" })).toBeNull();
  });
});

describe("a door holds no sentence of its own (ADR-0025 rule 9, check 10)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", "..");
  // The adapters that handle a tap. The sentences below live in `card-sentences.ts` and nowhere else.
  const doorFiles = [
    "packages/agent-kit/src/slack-door.ts",
    "packages/agent-kit/src/door-channels.ts",
    "services/chief-of-staff/lib/telegram-tap-gate.ts",
    "services/chief-of-staff/agent/channels/telegram-webhook.ts",
    "services/chief-of-staff/agent/channels/telegram.ts",
    "services/console/lib/chat-proxy.ts",
  ];
  const own = [
    sentences.CARD_REFUSED, sentences.CARD_NO_LONGER_WAITING, sentences.CARD_UNRECOGNISED, sentences.CARD_UNCHECKED,
    sentences.CARD_OUTCOME_TEXT.approved, sentences.CARD_OUTCOME_TEXT.notApproved, sentences.CARD_REVISED_TEXT,
    sentences.CARD_NOTE_CLOSED_TEXT, "The request above is shortened",
  ];
  it.each(doorFiles)("%s says nothing the kit says", (file) => {
    const text = readFileSync(join(root, file), "utf8");
    for (const sentence of own) expect(text, `${file} repeats: ${sentence}`).not.toContain(sentence);
  });
});
