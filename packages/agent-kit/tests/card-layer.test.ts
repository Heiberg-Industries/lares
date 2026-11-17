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

import { CARD_DOORS, cardOffersApprove, decideTap, findCard, isCardDoor, placesShowingWhole, textShownWhole, type CardDb } from "../src/card-layer.js";
import * as sentences from "../src/card-sentences.js";
import { shortenedCardSentence } from "../src/card-sentences.js";

const OWNER = "U_OWNER";
const MEMBER = "U_MEMBER";
const owners: Record<string, string> = { slack: OWNER, telegram: "100" };
const ownerOf = (door: string) => owners[door];

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
  it("every door in the table is covered by this contract, and an unknown door is no door", () => {
    expect(Object.keys(CARD_DOORS).sort()).toEqual(["console", "slack", "telegram"]);
    expect(isCardDoor("whatsapp")).toBe(false);
    expect(isCardDoor("toString")).toBe(false);
  });

  it("an unknown door fails closed: nothing is delivered, even for what looks like the owner", async () => {
    const verdict = await decideTap({ door: "whatsapp", tapper: OWNER, cards: [] }, { ownerOf: () => OWNER });
    expect(verdict).toEqual({ deliver: false, why: "refused", sentence: sentences.CARD_REFUSED });
  });
});

describe.each(["slack", "telegram"] as const)("the rules on %s", (door) => {
  const owner = owners[door]!;
  const member = door === "slack" ? MEMBER : "200";
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

describe("the rules on web chat", () => {
  const lookup = { requestId: "a", agent: "agent", sessionId: "s", memberId: "m1" };
  const db = (over: Partial<Row> = {}) => fakeRecord([card({ request_id: "a", door: "console", acting_member_id: "m1", ...over })]);

  it("the member the card was raised for may answer a waiting card", async () => {
    expect(await decideTap({ door: "console", tapper: "m1", cards: [lookup] }, { db: db() })).toEqual({ deliver: true });
  });
  it("another member may not", async () => {
    expect((await decideTap({ door: "console", tapper: "m2", cards: [lookup] }, { db: db() })).deliver).toBe(false);
  });
  it("a settled card is no longer waiting", async () => {
    expect(await decideTap({ door: "console", tapper: "m1", cards: [lookup] }, { db: db({ outcome: "approved" }) }))
      .toEqual({ deliver: false, why: "settled", sentence: sentences.CARD_NO_LONGER_WAITING });
  });
  it("a card with no record fails closed for everyone with the same sentence as before", async () => {
    expect(await decideTap({ door: "console", tapper: "m1", cards: [lookup] }, { db: fakeRecord([]) }))
      .toMatchObject({ deliver: false, why: "settled", sentence: sentences.CARD_NO_LONGER_WAITING });
  });
  it("an unreadable record is not sent on", async () => {
    expect(await decideTap({ door: "console", tapper: "m1", cards: [lookup] }, { db: fakeRecord([], true) }))
      .toMatchObject({ deliver: false, why: "unchecked" });
  });
});

describe("a shortened card (D-6)", () => {
  it("offers Approve only when the card is known to have been shown whole", () => {
    expect(cardOffersApprove(true)).toBe(true);
    expect(cardOffersApprove(false)).toBe(false);
    expect(cardOffersApprove(null)).toBe(false);
    expect(cardOffersApprove(undefined)).toBe(false);
  });

  it("recognises the notices a cut leaves", () => {
    expect(textShownWhole("A short card")).toBe(true);
    expect(textShownWhole("body\n\n— shortened — 12 characters are not shown.")).toBe(false);
    expect(textShownWhole("Send mail (shortened)")).toBe(false);
    expect(textShownWhole("body…(truncated)")).toBe(false);
  });

  it("points to the doors that show a card whole, in the order of the table", () => {
    expect(placesShowingWhole()).toEqual(["web chat"]);
    expect(shortenedCardSentence(["Slack", "web chat"], "https://console.example/waiting?request=r"))
      .toBe("The request above is shortened, so it cannot be approved here. Open it in Slack or web chat, where it shows in full, to approve it. In web chat: https://console.example/waiting?request=r\nDeny still works here.");
    expect(shortenedCardSentence(["Slack"], "https://console.example/x")).not.toContain("https://");
    expect(shortenedCardSentence([], null)).toBe("The request above is shortened, so it cannot be approved here. Deny still works here.");
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
