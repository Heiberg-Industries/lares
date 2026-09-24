// Ported from services/marcel/tests/conversation-log.test.ts, plus a dedicated
// today+yesterday-but-not-older window test (Task 8b — closing the cross-task gap left by
// Task 3's inventory listing this file without a dispatched brief that actually built it).
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConversationLog, type LogEntry } from "../lib/conversation-log.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-convlog-"));
});

function entry(overrides: Partial<LogEntry>): LogEntry {
  return { ts: 1784669400, from: "123", name: "Emma", text: "hei", ...overrides };
}

// "now" in seconds — recent()/transcript() look at today's+yesterday's files relative to the
// real clock, so those tests need real-clock-relative data.
const nowSec = () => Math.floor(Date.now() / 1000);

describe("ConversationLog.append", () => {
  it("writes a jsonl file named for the tz-local date", () => {
    const log = new ConversationLog(dir, "Europe/Paris");
    log.append(entry({ ts: 1784669400, text: "en" }));
    log.append(entry({ ts: 1784669401, text: "to" }));
    log.append(entry({ ts: 1784669402, text: "tre" }));

    const file = path.join(dir, "2026-07-21.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual(entry({ ts: 1784669400, text: "en" }));
  });

  it("creates the chatlog directory on first write when it doesn't exist yet", () => {
    const freshDir = path.join(dir, "trips", "paris-2026", "chatlog");
    expect(fs.existsSync(freshDir)).toBe(false);
    const log = new ConversationLog(freshDir, "Europe/Paris");

    log.append(entry({}));

    expect(fs.existsSync(freshDir)).toBe(true);
  });
});

describe("ConversationLog.recent", () => {
  it("returns the last n entries in chronological order across today+yesterday", () => {
    const log = new ConversationLog(dir, "Europe/Paris");
    const t = nowSec();
    log.append(entry({ ts: t - 20, text: "en" }));
    log.append(entry({ ts: t - 10, text: "to" }));
    log.append(entry({ ts: t, text: "tre" }));

    const result = log.recent(2);
    expect(result.map((e) => e.text)).toEqual(["to", "tre"]);
  });

  it("includes yesterday's entries and today's, but not the day before yesterday", () => {
    const log = new ConversationLog(dir, "UTC");
    const t = nowSec();
    log.append(entry({ ts: t - 2 * 86400, text: "for gammel" })); // day before yesterday — excluded
    log.append(entry({ ts: t - 86400, text: "i gar" })); // yesterday — included
    log.append(entry({ ts: t, text: "i dag" })); // today — included

    const result = log.recent(10);

    expect(result.map((e) => e.text)).toEqual(["i gar", "i dag"]);
  });
});

describe("ConversationLog.day", () => {
  it("returns only entries for the given date", () => {
    const log = new ConversationLog(dir, "Europe/Paris");
    log.append(entry({ ts: 1784669400, text: "en" })); // 2026-07-21
    log.append(entry({ ts: 1784673000, text: "to" })); // 2026-07-22

    expect(log.day("2026-07-21").map((e) => e.text)).toEqual(["en"]);
    expect(log.day("2026-07-22").map((e) => e.text)).toEqual(["to"]);
    expect(log.day("2026-07-23")).toEqual([]);
  });
});

describe("ConversationLog.transcript", () => {
  it("renders 'Name: text' lines; marcel-flagged entries render as 'Marcel:' regardless of name", () => {
    const log = new ConversationLog(dir, "Europe/Paris");
    const t = nowSec();
    log.append(entry({ ts: t - 1, name: "Emma", text: "ja takk" }));
    log.append(entry({ ts: t, name: "Concierge", text: "bare hyggelig", marcel: true }));

    expect(log.transcript(2)).toBe("Emma: ja takk\nMarcel: bare hyggelig");
  });

  it("includes yesterday's transcript lines ahead of today's, still excluding older days", () => {
    const log = new ConversationLog(dir, "UTC");
    const t = nowSec();
    log.append(entry({ ts: t - 2 * 86400, name: "Old", text: "for gammel" }));
    log.append(entry({ ts: t - 86400, name: "Emma", text: "i gar" }));
    log.append(entry({ ts: t, name: "Jonas", text: "i dag" }));

    expect(log.transcript(10)).toBe("Emma: i gar\nJonas: i dag");
  });
});

describe("ConversationLog midnight straddle", () => {
  it("puts entries either side of Europe/Paris midnight into separate files", () => {
    const log = new ConversationLog(dir, "Europe/Paris");
    log.append(entry({ ts: 1784669400, text: "before midnight" })); // 2026-07-21 23:30 CEST
    log.append(entry({ ts: 1784673000, text: "after midnight" })); // 2026-07-22 00:30 CEST

    const before = path.join(dir, "2026-07-21.jsonl");
    const after = path.join(dir, "2026-07-22.jsonl");
    expect(fs.existsSync(before)).toBe(true);
    expect(fs.existsSync(after)).toBe(true);
    expect(fs.readFileSync(before, "utf8")).toContain("before midnight");
    expect(fs.readFileSync(after, "utf8")).toContain("after midnight");
  });
});
