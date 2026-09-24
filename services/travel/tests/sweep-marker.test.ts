// ORB-104 — the interrupted-sweep marker.
//
// The defect this guards is a SILENCE: a detached sweep killed by a container restart looks
// exactly like a sweep that is still working, and exactly like one that hung. These tests pin
// the whole marker lifecycle, because every one of those states has to become distinguishable.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionAuth } from "eve/context";

vi.mock("eve/channels/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("eve/channels/telegram")>();
  return {
    ...actual,
    sendTelegramMessage: vi.fn(async () => ({ id: "1", chatId: undefined, chatType: undefined, raw: {} })),
    callTelegramApi: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
  };
});

import { sendTelegramMessage } from "eve/channels/telegram";
import {
  INTERRUPTED_SWEEP_DM,
  MARKER_FILE,
  SWEEP_ALREADY_RUNNING,
  SWEEP_FRESH_MS,
  clearSweepMarker,
  isSweepRunning,
  notifyIfSweepInterrupted,
  readSweepMarker,
  writeSweepMarker,
} from "../lib/sweep-marker.js";
import { createSveipTool, type SveipDeps } from "../catalogue/sveip.js";
import type { BackfillResult } from "../lib/bookings.js";

const sendMock = vi.mocked(sendTelegramMessage);
const ADMIN_ID = "123456789";
const NOW = 1_786_970_000_000;

const EMPTY_RESULT: BackfillResult = {
  filed: 0,
  duplicates: 0,
  noTrip: 0,
  notBooking: 0,
  unclearSubjects: [],
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-sweep-marker-"));
  process.env["MARCEL_DATA_ROOT"] = root;
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
  process.env["TELEGRAM_BOT_TOKEN"] = "test-token";
  sendMock.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_DATA_ROOT"];
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
  delete process.env["TELEGRAM_BOT_TOKEN"];
});

const markerFile = () => path.join(root, MARKER_FILE);

describe("the marker file", () => {
  it("round-trips the start time", () => {
    writeSweepMarker(root, NOW);
    expect(readSweepMarker(root)).toEqual({ startedAt: NOW });
  });

  it("reads as absent when no sweep has ever run", () => {
    expect(readSweepMarker(root)).toBeNull();
  });

  it("reads as absent rather than throwing when the file is corrupt", () => {
    fs.writeFileSync(markerFile(), "{not json");
    expect(readSweepMarker(root)).toBeNull();
  });

  it("reads as absent when the file parses but carries no usable timestamp", () => {
    fs.writeFileSync(markerFile(), JSON.stringify({ startedAt: "soon" }));
    expect(readSweepMarker(root)).toBeNull();
  });

  it("is written atomically, leaving no tmp file behind", () => {
    writeSweepMarker(root, NOW);
    expect(fs.readdirSync(root)).toEqual([MARKER_FILE]);
  });

  it("clears, and clearing twice is not an error", () => {
    writeSweepMarker(root, NOW);
    clearSweepMarker(root);
    clearSweepMarker(root);
    expect(readSweepMarker(root)).toBeNull();
  });

  it("never throws when the data root cannot be written", () => {
    expect(() => writeSweepMarker("/proc/nonexistent/nope", NOW)).not.toThrow();
  });
});

describe("isSweepRunning", () => {
  it("is true inside the freshness window", () => {
    expect(isSweepRunning({ startedAt: NOW }, NOW + 60_000)).toBe(true);
  });

  it("is false once the window passes — a hung sweep must not wedge /sveip forever", () => {
    expect(isSweepRunning({ startedAt: NOW }, NOW + SWEEP_FRESH_MS + 1)).toBe(false);
  });

  it("is false with no marker at all", () => {
    expect(isSweepRunning(null, NOW)).toBe(false);
  });
});

describe("the startup check", () => {
  it("DMs the admin when a marker survived the last process", async () => {
    writeSweepMarker(root, NOW);
    const notify = vi.fn(async () => {});

    const notified = await notifyIfSweepInterrupted({ dataRoot: root, now: () => NOW + 1000, notify });

    expect(notified).toBe(true);
    expect(notify).toHaveBeenCalledWith(INTERRUPTED_SWEEP_DM);
    expect(INTERRUPTED_SWEEP_DM).toContain("avbrutt av en omstart");
    expect(INTERRUPTED_SWEEP_DM).toContain("gratis");
  });

  it("says nothing when the last sweep reported normally", async () => {
    const notify = vi.fn(async () => {});
    expect(await notifyIfSweepInterrupted({ dataRoot: root, now: () => NOW, notify })).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("clears the marker, so a restart loop cannot DM on every boot", async () => {
    writeSweepMarker(root, NOW);
    const notify = vi.fn(async () => {});

    await notifyIfSweepInterrupted({ dataRoot: root, now: () => NOW, notify });
    await notifyIfSweepInterrupted({ dataRoot: root, now: () => NOW, notify });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(readSweepMarker(root)).toBeNull();
  });

  it("still clears the marker when the DM itself fails", async () => {
    writeSweepMarker(root, NOW);
    const notify = vi.fn(async () => {
      throw new Error("telegram down at boot");
    });

    expect(await notifyIfSweepInterrupted({ dataRoot: root, now: () => NOW, notify })).toBe(false);
    expect(readSweepMarker(root)).toBeNull();
  });

  it("notifies even for a marker far older than the freshness window", async () => {
    writeSweepMarker(root, NOW - SWEEP_FRESH_MS * 10);
    const notify = vi.fn(async () => {});
    expect(await notifyIfSweepInterrupted({ dataRoot: root, now: () => NOW, notify })).toBe(true);
  });
});

describe("/sveip's marker lifecycle", () => {
  function auth(): SessionAuth {
    const a = {
      authenticator: "telegram-webhook",
      principalId: `telegram:${ADMIN_ID}`,
      principalType: "user",
      attributes: { chat_id: ADMIN_ID, chat_type: "private", user_id: ADMIN_ID },
    } as never;
    return { current: a, initiator: a } as SessionAuth;
  }
  const ctx = () => ({ session: { id: "wrun", auth: auth() } }) as never;

  /** Lets a test hold the sweep open, then settle it on demand. */
  function deferred(): { promise: Promise<BackfillResult>; resolve(): void; reject(e: Error): void } {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<BackfillResult>((res, rej) => {
      resolve = () => res(EMPTY_RESULT);
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function deps(over: Partial<SveipDeps> = {}): SveipDeps {
    return { backfill: async () => EMPTY_RESULT, orphans: () => [], now: () => NOW, ...over };
  }

  it("writes the marker when the sweep detaches", async () => {
    const gate = deferred();
    const tool = createSveipTool(deps({ backfill: () => gate.promise }));

    await tool.execute!({}, ctx());

    expect(readSweepMarker(root)).toEqual({ startedAt: NOW });
    gate.resolve();
    await gate.promise;
  });

  it("clears it once the sweep reports successfully", async () => {
    const tool = createSveipTool(deps());
    await tool.execute!({}, ctx());
    await new Promise((r) => setImmediate(r));
    expect(readSweepMarker(root)).toBeNull();
  });

  it("clears it when the sweep FAILS — a reported failure is not an interruption", async () => {
    const tool = createSveipTool(deps({ backfill: async () => { throw new Error("gmail exploded"); } }));
    await tool.execute!({}, ctx());
    await new Promise((r) => setImmediate(r));
    expect(readSweepMarker(root)).toBeNull();
  });

  it("refuses a second sweep while one is genuinely running", async () => {
    const gate = deferred();
    const tool = createSveipTool(deps({ backfill: () => gate.promise }));
    await tool.execute!({}, ctx());
    sendMock.mockClear();

    const second = await tool.execute!({}, ctx());

    expect(second).toBe(SWEEP_ALREADY_RUNNING);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]![0].body.text).toContain(SWEEP_ALREADY_RUNNING);
    gate.resolve();
    await gate.promise;
  });

  it("does not start a second backfill when it refuses", async () => {
    const gate = deferred();
    const backfill = vi.fn(() => gate.promise);
    const tool = createSveipTool(deps({ backfill }));
    await tool.execute!({}, ctx());
    await tool.execute!({}, ctx());

    expect(backfill).toHaveBeenCalledTimes(1);
    gate.resolve();
    await gate.promise;
  });

  it("allows a new sweep once a stale marker ages out — a hang must not wedge the tool", async () => {
    writeSweepMarker(root, NOW - SWEEP_FRESH_MS - 1);
    const backfill = vi.fn(async () => EMPTY_RESULT);
    const tool = createSveipTool(deps({ backfill }));

    const result = await tool.execute!({}, ctx());

    expect(result).not.toBe(SWEEP_ALREADY_RUNNING);
    expect(backfill).toHaveBeenCalledTimes(1);
  });
});
