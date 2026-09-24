import { describe, it, expect, vi } from "vitest";
import type { TurnLogEntry } from "../lib/turn-capture.js";
import {
  parseConversationLog,
  readConversationLogs,
  readConversationEntries,
  type EntryReader,
  type LogReaderBrain,
} from "../lib/dream/log-reader.js";
import type { ConversationEntry } from "@lares/agent-kit/conversation-record";

// The legacy markdown format the retired writer (`lib/conversation-log.ts`, removed W3B-s8)
// used to produce, inlined here as a plain fixture builder — nothing in production writes this
// format any more, but the parser (`lib/dream/log-reader.ts`) still reads it for the one
// installation-lifetime gap `readConversationEntries` fills and for the one-time importer.
// Neutral, caller-supplied labels throughout: the parser under test knows no name of its own
// (W3B-s7), so neither does this fixture.
const FIXTURE_SPEAKER = "Person";
const FIXTURE_AGENT_LABEL = "Helper";

function renderMd(e: TurnLogEntry): { relPath: string; text: string } {
  const date = e.at.slice(0, 10);
  const stamp = e.at.replace(/[:.]/g, "-");
  const relPath = `_meta/conversations/${date}/${stamp}-${e.door}.md`;
  const speaker = e.lane ? `${e.lane} (scheduled)` : FIXTURE_SPEAKER;
  const text = [
    `---`,
    `at: ${e.at}`,
    `door: ${e.door}`,
    `principal: ${e.principal}`,
    ...(e.lane ? [`lane: ${e.lane}`] : []),
    `proposals: ${e.proposals.join(", ")}`,
    `---`,
    ``,
    `**${speaker}:** ${e.input}`,
    ...(e.reply ? [``, `**${FIXTURE_AGENT_LABEL}:** ${e.reply}`, ``] : [``]),
  ].join("\n");
  return { relPath, text };
}

const entry: TurnLogEntry = {
  at: "2026-08-19T10:00:00.000Z", door: "slack", principal: "U1",
  input: "hei", reply: "hei igjen", proposals: ["brain.write"],
};

describe("writer/reader round-trip — the legacy format, parseConversationLog reads back", () => {
  it("what the retired writer used to produce, parseConversationLog reads back", async () => {
    const { text } = renderMd(entry);
    const parsed = parseConversationLog(text, FIXTURE_AGENT_LABEL);
    expect(parsed).not.toBeNull();
    expect(parsed!.at).toBe("2026-08-19T10:00:00.000Z");
    expect(parsed!.door).toBe("slack");
  });

  it("a scheduled turn round-trips with its lane", async () => {
    const { text } = renderMd({ ...entry, lane: "morning-brief" });
    expect(parseConversationLog(text, FIXTURE_AGENT_LABEL)!.lane).toBe("morning-brief");
  });

  it("returns null for content with no frontmatter", () => {
    expect(parseConversationLog("just prose", FIXTURE_AGENT_LABEL)).toBeNull();
  });

  it("returns null when `at` is missing — such an entry is invisible to the cursor", () => {
    expect(parseConversationLog("---\ndoor: slack\n---\n\nbody", FIXTURE_AGENT_LABEL)).toBeNull();
  });
});

describe("the parser names no person and no persona (W3B-s7) — it only knows what the caller tells it", () => {
  const md = (speaker: string, input: string, agent: string, reply: string, extra = "") =>
    [
      "---",
      "at: 2026-09-18T10:00:00.000Z",
      "door: slack",
      "principal: fixture-owner",
      `proposals: ${extra}`,
      "---",
      "",
      `**${speaker}:** ${input}`,
      "",
      `**${agent}:** ${reply}`,
      "",
    ].join("\n");

  it("finds the speaker and the reply using two invented labels — neither is special", () => {
    const parsed = parseConversationLog(md("Owner", "what's for dinner?", "Helper", "pasta"), "Helper");
    expect(parsed).not.toBeNull();
    expect(parsed!.input).toBe("what's for dinner?");
    expect(parsed!.reply).toBe("pasta");
  });

  it("a scheduled lane's label is read the same way, as long as it is not the agent's own", () => {
    const parsed = parseConversationLog(
      md("morning-brief (scheduled)", "write the brief", "Helper", "here it is"),
      "Helper",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.input).toBe("write the brief");
    expect(parsed!.reply).toBe("here it is");
  });

  it("swapping which label is 'the agent' changes what is read as speaker vs reply — no label is hardcoded", () => {
    const body = md("Owner", "hello", "Helper", "hi there");
    expect(parseConversationLog(body, "Helper")!.input).toBe("hello");
    // Same bytes, opposite reading: telling the parser "Owner" is the agent's own label makes
    // it treat "Helper" as the speaker instead — proving neither string means anything to it.
    expect(parseConversationLog(body, "Owner")!.input).toBe("hi there");
  });
});

describe("readConversationLogs cursor behaviour", () => {
  function fakeBrain(files: Record<string, string>) {
    return {
      list: async () => Object.keys(files),
      read: async (p: string) => files[p],
    };
  }

  it("keeps only entries strictly newer than `since`, sorted ascending", async () => {
    const a = renderMd({ ...entry, at: "2026-08-18T10:00:00.000Z" });
    const b = renderMd({ ...entry, at: "2026-08-19T10:00:00.000Z" });
    const c = renderMd({ ...entry, at: "2026-08-20T10:00:00.000Z" });
    const brain = fakeBrain({ [a.relPath]: a.text, [b.relPath]: b.text, [c.relPath]: c.text });

    const out = await readConversationLogs(brain, { since: "2026-08-18T10:00:00.000Z", agentLabel: FIXTURE_AGENT_LABEL });
    expect(out.map((e) => e.at)).toEqual([
      "2026-08-19T10:00:00.000Z",
      "2026-08-20T10:00:00.000Z",
    ]);
  });

  it("drops unparseable files instead of throwing", async () => {
    const good = renderMd(entry);
    const brain = fakeBrain({
      [good.relPath]: good.text,
      "_meta/conversations/2026-08-19/broken.md": "not a log",
    });
    const out = await readConversationLogs(brain, { since: "1970-01-01T00:00:00.000Z", agentLabel: FIXTURE_AGENT_LABEL });
    expect(out.length).toBe(1);
  });

  it("an EMPTY log directory yields zero entries — the Aug-13→19 condition", async () => {
    const out = await readConversationLogs(fakeBrain({}), { since: "1970-01-01T00:00:00.000Z", agentLabel: FIXTURE_AGENT_LABEL });
    expect(out).toEqual([]);
  });
});

describe("readConversationEntries — the table, with a fallback for one installation-lifetime gap (W3B-s3)", () => {
  function mdBrain(files: Record<string, string>): LogReaderBrain {
    return {
      list: async () => Object.keys(files),
      read: async (p: string) => files[p],
    };
  }

  function tableRow(over: Partial<ConversationEntry>): ConversationEntry {
    return {
      id: "row-id",
      agent: "canary",
      sessionId: "s1",
      turnId: "t1",
      door: "slack",
      personKey: "fixture-owner",
      lane: null,
      origin: "owner",
      input: "table input",
      reply: "table reply",
      proposals: [],
      at: new Date("2026-09-18T10:00:00Z"),
      recordedAt: new Date("2026-09-18T10:00:00Z"),
      ...over,
    };
  }

  /** A fake `EntryReader` over an in-memory row set, matching the real store's contract
   *  (strictly-after `since`, ascending, `excludeLanes` and `limit` both honoured). */
  function fakeReader(rows: ConversationEntry[]): EntryReader {
    return {
      since: async (o) => {
        let out = rows.filter((r) => r.at.getTime() > o.since.getTime());
        if (o.excludeLanes) out = out.filter((r) => r.lane === null);
        out = [...out].sort((a, b) => a.at.getTime() - b.at.getTime());
        return o.limit !== undefined ? out.slice(0, o.limit) : out;
      },
    };
  }

  const CURSOR = "2026-09-18T00:00:00.000Z";

  it("table only: the table alone answers once its own coverage reaches back through the cursor — markdown is never touched", async () => {
    const reader = fakeReader([
      tableRow({ turnId: "before-cursor", at: new Date("2026-09-17T00:00:00Z") }), // <= cursor: proves coverage
      tableRow({ turnId: "after-cursor", at: new Date("2026-09-18T11:00:00Z"), input: "from the table" }),
    ]);
    const brain = mdBrain({ "_meta/conversations/2026-09-18/should-not-be-read.md": "would blow up parseConversationLog if read as a log" });
    const readSpy = vi.spyOn(brain, "read");

    const got = await readConversationEntries(reader, brain, { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL });

    expect(got.map((e) => e.input)).toEqual(["from the table"]);
    expect(got[0]!.origin).toBe("owner");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("markdown only: a box that has not applied migration 060 fails soft, warns once, and never throws", async () => {
    const missingTable = Object.assign(new Error('relation "conversation_entries" does not exist'), { code: "42P01" });
    const reader: EntryReader = { since: async () => { throw missingTable; } };
    const { relPath, text } = renderMd({ ...entry, at: "2026-09-18T11:00:00.000Z" });
    const brain = mdBrain({ [relPath]: text });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const got = await readConversationEntries(reader, brain, { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL });
      expect(got.map((e) => e.input)).toEqual([entry.input]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/conversation_entries does not exist/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not crash the nightly job on a missing-table error — resolves, does not reject", async () => {
    const missingTable = Object.assign(new Error("boom"), { code: "42P01" });
    const reader: EntryReader = { since: async () => { throw missingTable; } };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(readConversationEntries(reader, mdBrain({}), { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL })).resolves.toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a non-missing-table error is not swallowed — this function only fails soft for an unapplied migration", async () => {
    const reader: EntryReader = { since: async () => { throw new Error("connection refused"); } };
    await expect(readConversationEntries(reader, mdBrain({}), { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL })).rejects.toThrow(/connection refused/);
  });

  it("the hand-over day: the table only has rows after the cursor, markdown fills the gap before them, and no turn is read from both sources", async () => {
    const reader = fakeReader([
      tableRow({ turnId: "table-entry", at: new Date("2026-09-18T12:00:00Z"), input: "from the table" }),
    ]);
    const { relPath: gapPath, text: gapText } = renderMd({
      ...entry,
      at: "2026-09-18T09:00:00.000Z", // after cursor, before the table's earliest row — the true gap
      input: "gap entry, markdown-only",
    });
    const { relPath: coveredPath, text: coveredText } = renderMd({
      ...entry,
      at: "2026-09-18T13:00:00.000Z", // after the table's earliest row — the table already owns this window
      input: "this turn belongs to the table's window and must be dropped from markdown",
    });
    const brain = mdBrain({ [gapPath]: gapText, [coveredPath]: coveredText });

    const got = await readConversationEntries(reader, brain, { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL });

    // Ascending order, the gap entry from markdown followed by the table's own row — and
    // nothing from markdown past the table's earliest row (never both sources for one turn).
    expect(got.map((e) => e.input)).toEqual(["gap entry, markdown-only", "from the table"]);
  });

  // W3B-s8: the markdown WRITE stops, but an installation that has never run the one-time
  // importer (`bin/import-conversation-logs.ts`) still has its whole legacy history living
  // ONLY in markdown, under a table that only started filling up recently ("a young table").
  // The gap-fill above is what carries that installation through until it runs the importer —
  // this pins that every legacy turn still comes back exactly once, never dropped and never
  // duplicated against the table's own rows.
  it("an installation that has NOT run the importer still gets every legacy turn exactly once, via the gap-fill alone", async () => {
    const reader = fakeReader([
      tableRow({ turnId: "recent-1", at: new Date("2026-09-18T14:00:00Z"), input: "recent turn one" }),
      tableRow({ turnId: "recent-2", at: new Date("2026-09-18T15:00:00Z"), input: "recent turn two" }),
    ]);
    const legacy1 = renderMd({ ...entry, at: "2026-09-18T08:00:00.000Z", input: "legacy turn one" });
    const legacy2 = renderMd({ ...entry, at: "2026-09-18T09:00:00.000Z", input: "legacy turn two" });
    const legacy3 = renderMd({ ...entry, at: "2026-09-18T10:00:00.000Z", input: "legacy turn three" });
    const brain = mdBrain({
      [legacy1.relPath]: legacy1.text,
      [legacy2.relPath]: legacy2.text,
      [legacy3.relPath]: legacy3.text,
    });

    const got = await readConversationEntries(reader, brain, { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL });

    expect(got.map((e) => e.input)).toEqual([
      "legacy turn one",
      "legacy turn two",
      "legacy turn three",
      "recent turn one",
      "recent turn two",
    ]);
    const inputs = got.map((e) => e.input);
    expect(new Set(inputs).size).toBe(inputs.length); // exactly once each
  });

  it("carries origin through from the table, so the reflector's input can tell an owner's words from a third-party read", async () => {
    const reader = fakeReader([
      tableRow({ turnId: "before-cursor", at: new Date("2026-09-17T00:00:00Z") }),
      tableRow({ turnId: "tainted", at: new Date("2026-09-18T11:00:00Z"), origin: "third_party", input: "a summary of a fetched email" }),
    ]);
    const got = await readConversationEntries(reader, mdBrain({}), { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL });
    expect(got[0]!.origin).toBe("third_party");
  });

  it("excludes scheduled lanes from the table the same way the markdown reader always has", async () => {
    const reader = fakeReader([
      tableRow({ turnId: "before-cursor", at: new Date("2026-09-17T00:00:00Z") }),
      tableRow({ turnId: "scheduled", at: new Date("2026-09-18T11:00:00Z"), lane: "morning-brief", origin: "system" }),
      tableRow({ turnId: "human", at: new Date("2026-09-18T12:00:00Z"), input: "a human turn" }),
    ]);
    const got = await readConversationEntries(reader, mdBrain({}), { agent: "canary", since: CURSOR, agentLabel: FIXTURE_AGENT_LABEL });
    expect(got.map((e) => e.input)).toEqual(["a human turn"]);
  });
});
