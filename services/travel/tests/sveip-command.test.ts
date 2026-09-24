// ORB-107 — /sveip is a CHANNEL-LEVEL command, dispatched past the model.
//
// The bug these tests exist for: on 2026-08-17 the model refused four consecutive `/sveip`s
// because it believed a sweep it had acked at 13:44 was still running. It was not — a deploy
// had killed it — but the completion report is a raw Telegram send the session never sees, so
// nothing could correct the belief, and the refusal happened UPSTREAM of the tool, so ORB-104's
// marker file (which held the truth) was never consulted.
//
// Two halves are tested here:
//   1. the command never reaches the model at all (this file's channel tests), and
//   2. the model is told the truth every turn anyway, from the same marker, so a
//      CONVERSATIONAL "kan du sveipe?" cannot repeat the refusal (the status-line tests).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sweepStatusMarkdown } from "../agent/instructions/trip-context.js";
import { clearSweepMarker, writeSweepMarker, SWEEP_FRESH_MS } from "../lib/sweep-marker.js";

const ADMIN_ID = "123456789";
const OTHER_ID = "999999999";

async function freshChannel() {
  vi.resetModules();
  return await import("../agent/channels/telegram.js");
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    attachments: [],
    caption: "",
    chat: { id: "123", type: "private" },
    from: { id: ADMIN_ID, isBot: false, firstName: "Bendik" },
    messageId: "1",
    raw: {},
    text: "/sveip",
    ...overrides,
  } as never;
}

function fakeCtx() {
  return {
    telegram: {
      botUsername: "MarcelConciergeBot",
      chatId: "",
      startTyping: vi.fn(async () => {}),
      request: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
      sendMessage: vi.fn(async () => ({ id: "1", raw: {} })),
    },
  } as never;
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    tripForChat: vi.fn(async () => null),
    appendInbound: vi.fn(),
    transcriptFor: () => "",
    isKillSwitchOn: () => false,
    setKillSwitch: vi.fn(),
    gatekeeper: { consider: vi.fn(async () => ({ action: "silent" as const })) },
    budget: { exceeded: () => false, notifyOnce: () => false, add: vi.fn() },
    notifyBudgetExceeded: vi.fn(),
    sendInfoCard: vi.fn(),
    appendNotert: vi.fn(),
    startSveip: vi.fn(async () => "started"),
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eve-marcel-sveip-cmd-"));
  process.env["MARCEL_DATA_ROOT"] = root;
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_DATA_ROOT"];
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

describe("/sveip as a channel-level command", () => {
  it("starts the sweep directly and NEVER starts a model turn — the whole point of ORB-107", async () => {
    const { createOnMessage } = await freshChannel();
    const deps = baseDeps();
    const ctx = fakeCtx();

    const result = await createOnMessage(deps as never)(ctx, message({ text: "/sveip" }));

    expect(deps.startSveip).toHaveBeenCalledTimes(1);
    // null = no turn. The model never sees this message, so it cannot decline it.
    expect(result).toBeNull();
    expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).not.toHaveBeenCalled();
  });

  it("accepts Telegram's own /sveip@BotName form", async () => {
    const { createOnMessage } = await freshChannel();
    const deps = baseDeps();

    await createOnMessage(deps as never)(fakeCtx(), message({ text: "/sveip@MarcelConciergeBot" }));

    expect(deps.startSveip).toHaveBeenCalledTimes(1);
  });

  it("does NOT hijack a conversational ask — that still becomes a normal turn, tool and all", async () => {
    const { createOnMessage } = await freshChannel();
    const deps = baseDeps();

    const result = await createOnMessage(deps as never)(
      fakeCtx(),
      message({ text: "kan du sveipe innboksen for meg?" }),
    );

    expect(deps.startSveip).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("refuses a non-admin sender — a year of Bendik's Reise mail is not a public command", async () => {
    const { createOnMessage } = await freshChannel();
    const deps = baseDeps();

    const result = await createOnMessage(deps as never)(
      fakeCtx(),
      message({ from: { id: OTHER_ID, isBot: false } }),
    );

    expect(deps.startSveip).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("refuses it in a group, even from the admin's own id", async () => {
    const { createOnMessage } = await freshChannel();
    const deps = baseDeps();

    await createOnMessage(deps as never)(
      fakeCtx(),
      message({ chat: { id: "-100123", type: "group", title: "Big Apple" } }),
    );

    expect(deps.startSveip).not.toHaveBeenCalled();
  });

  it("stays behind the kill switch — a silenced Marcel must not start a sweep that DMs", async () => {
    const { createOnMessage } = await freshChannel();
    const deps = baseDeps({ isKillSwitchOn: () => true });

    const result = await createOnMessage(deps as never)(fakeCtx(), message({ text: "/sveip" }));

    expect(deps.startSveip).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("swallows a start failure — a thrown onMessage would make Telegram redeliver the same /sveip", async () => {
    const { createOnMessage } = await freshChannel();
    const deps = baseDeps({
      startSveip: vi.fn(async () => {
        throw new Error("telegram down");
      }),
    });

    const result = await createOnMessage(deps as never)(fakeCtx(), message({ text: "/sveip" }));

    expect(result).toBeNull();
  });
});

describe("the per-turn sweep-status line (the model's only correction path)", () => {
  it("says a sweep is running while the marker is fresh, and names when it started", () => {
    const now = Date.parse("2026-08-17T16:30:00Z");
    writeSweepMarker(root, now - 60_000);

    const md = sweepStatusMarkdown(root, "Europe/Oslo", now);

    expect(md).toContain("## Reise-sveip");
    expect(md).toContain("kjører NÅ");
    expect(md).toContain("18:29"); // Europe/Oslo, one minute before 18:30
  });

  it("says no sweep is running once the marker is cleared — the state the model got wrong", () => {
    const now = Date.now();
    writeSweepMarker(root, now);
    clearSweepMarker(root);

    const md = sweepStatusMarkdown(root, "Europe/Oslo", now);

    expect(md).toContain("Ingen reise-sveip kjører nå");
    // Not merely "no sweep" — the line has to actively overrule the model's own memory, which
    // is what beat it on 2026-08-17.
    expect(md).toMatch(/husker fra tidligere i samtalen/);
  });

  it("treats a stale marker as 'not running' — a sweep that died must not block the next one forever", () => {
    const now = Date.now();
    writeSweepMarker(root, now - SWEEP_FRESH_MS - 1);

    expect(sweepStatusMarkdown(root, "Europe/Oslo", now)).toContain("Ingen reise-sveip kjører nå");
  });
});
