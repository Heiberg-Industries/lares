/**
 * tests/approval-advisories.test.ts — the published approval-card advisories, as cases THIS
 * installation has to pass (W7A-s7).
 *
 * Source: `02-openclaw.md` §6 ("The approval-card class of bug — directly relevant to Lares"),
 * a reading of another self-hosted agent project's published security advisories. Its titles
 * name four failure shapes: (1) what is shown is not what runs, (2) the approval is not bound
 * to the exact payload, (3) the approver's identity is not checked, (4) an approval lives
 * longer or wider than what was reviewed.
 *
 * THIS FILE IS A GATE, NOT A FEATURE. It adds no production code. Every case below calls the
 * REAL function that is supposed to close the advisory, with a hostile input, and asserts the
 * control actually bites — never a grep for a name standing in for behaviour. Where the honest
 * answer is "this installation has not closed that shape", the case says so once, in one
 * sentence, rather than assert something true of a smaller, easier question.
 *
 * If any case here cannot be made to pass without changing production code, that is a hole
 * wave 7 has not closed — STOP and report it; this slice does not fix it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ApprovalPayloadChangedError,
  assertApprovedCall,
  payloadFingerprint,
  StaleApprovalError,
  type AskOutcome,
  type AskRow,
  type ApprovalLedgerReader,
  APPROVAL_TTL_MS,
} from "@lares/agent-kit/approval-ledger";
import { mustAlwaysAsk } from "@lares/agent-kit/always-ask";
import { clearBoardCache, decideApproval, type BoardDeps } from "@lares/agent-kit/board-approval";
import { DETAILS_MAX_LENGTH, detailsForApproval } from "@lares/agent-kit/approval-summary";

import { approverFrom } from "../lib/approvals.js";
import { HITL_CALLBACK_PREFIX, refusedApprovalTap } from "../lib/telegram-tap-gate.js";

const here = dirname(fileURLToPath(import.meta.url));

// ─── shared fixtures for the payload/freshness cases (2) and (4) ────────────────────────────
const NOW = new Date("2026-09-20T12:00:00Z");
const ASKED_INPUT = { to: ["a@x.example"], subject: "Q3" };

/** A ledger holding exactly one row, so each case can bend one dimension (age, payload,
 *  outcome) and watch `assertApprovedCall` — the real function — react. `settled` records
 *  what the check itself decided to write, so a case can prove the OUTCOME was classified
 *  correctly, not merely that *something* threw. */
function ledgerWithRow(overrides: Partial<AskRow> = {}): {
  ledger: ApprovalLedgerReader;
  settled: AskOutcome[];
} {
  const settled: AskOutcome[] = [];
  const row: AskRow = {
    requestId: "req-1",
    callId: "call-1",
    agent: "fixture-agent",
    tool: "gmail_send",
    payloadHash: payloadFingerprint("gmail_send", ASKED_INPUT),
    askedAt: new Date(NOW.getTime() - 60_000),
    answeredAt: null,
    outcome: null,
    answeredVia: null,
    usedAt: null,
    useCount: 0,
    ...overrides,
  };
  return {
    ledger: {
      ask: async () => row,
      settle: async (_requestId, outcome) => {
        settled.push(outcome);
      },
      markUsed: async () => null,
    },
    settled,
  };
}

describe("(1) what is shown is not what runs", () => {
  it("'Exec approval display truncation could hide the command being approved' — a shortened card says so", () => {
    const out = detailsForApproval("gmail_send", {
      to: ["a@x.example"],
      subject: "Long",
      bodyText: "x".repeat(5000),
    });
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(DETAILS_MAX_LENGTH);
    // A bare trailing "…" would read as stylistic; the card has to ADMIT what it cut.
    expect(out).toMatch(/— shortened — \d+ characters are not shown\.$/);
  });

  it("a send names every recipient, never 'and 3 more' alone", () => {
    // W7A-s1
    const out = detailsForApproval("gmail_send", {
      to: ["a@x.example", "b@x.example", "c@x.example", "d@x.example"],
      subject: "Q3",
      bodyText: "Here it is.",
    });
    expect(out).toContain("*To:* a@x.example, b@x.example, c@x.example, d@x.example");
    expect(out).not.toMatch(/and \d+ more/);
  });
});

describe("(2) the approval is not bound to the exact payload", () => {
  it("'Reusable exec approvals could authorize changed arguments' — changed arguments refuse", async () => {
    // W7A-s5
    const { ledger, settled } = ledgerWithRow();
    await expect(
      assertApprovedCall(ledger, {
        callId: "call-1",
        toolName: "gmail_send",
        input: { ...ASKED_INPUT, to: ["a@x.example", "stranger@y.example"] },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
    expect(settled).toEqual(["payload-changed"]);
  });

  it("'Shell wrapper argv could change between approval and execution' — the fingerprint covers every field", () => {
    // Not just the recipient: an added, unreviewed field must move the hash too, or a wrapper
    // that appends a field the card never showed would slip through unnoticed.
    const shown = payloadFingerprint("gmail_send", { to: ["a@x.example"], subject: "Q3" });
    const withExtraField = payloadFingerprint("gmail_send", {
      to: ["a@x.example"],
      subject: "Q3",
      cc: "extra@x.example",
    });
    expect(withExtraField).not.toBe(shown);
  });
});

describe("(3) the approver's identity is not checked", () => {
  it("'QQBot native approval buttons did not enforce configured approver identity' — a tap from another id is refused", () => {
    // W7A-s3
    const env = { TELEGRAM_PRINCIPAL_ID: "111" } as NodeJS.ProcessEnv;
    const raw = JSON.stringify({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 222, is_bot: false },
        message: { chat: { id: 111 } },
        data: `${HITL_CALLBACK_PREFIX}0`,
      },
    });
    expect(refusedApprovalTap(raw, env)).toEqual({ callbackQueryId: "cb1", chatId: "111" });
  });

  it("'Slack plugin approvals used the exec approver gate for plugin actions' — one gate, named per tool", () => {
    // W7A-s6's structural rule, re-asserted here directly over the real catalogue/tool files —
    // not by trusting board-wiring.test.ts, which is a different slice's own test.
    const dirs = [join(here, "..", "agent", "tools"), join(here, "..", "catalogue")];
    const behind: string[] = [];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter(
        (n) => n.endsWith(".ts") && n !== "index.ts" && n !== "catalogue.ts",
      )) {
        const src = readFileSync(join(dir, name), "utf8");
        if (/assertApprover\(/.test(src) && !/await assertApproval\(ctx, "/.test(src)) {
          behind.push(name);
        }
      }
    }
    expect(behind).toEqual([]);
  });
});

describe("(4) an approval lives longer or wider than what was reviewed", () => {
  it("'Exec approvals could outlive their reviewed working directory' — a card past the window refuses", async () => {
    // W7A-s5
    const { ledger, settled } = ledgerWithRow({
      askedAt: new Date(NOW.getTime() - APPROVAL_TTL_MS - 1),
    });
    await expect(
      assertApprovedCall(ledger, { callId: "call-1", toolName: "gmail_send", input: ASKED_INPUT, now: NOW }),
    ).rejects.toBeInstanceOf(StaleApprovalError);
    expect(settled).toEqual(["expired"]);
  });

  it("a 🚫 on the board refuses even an always-ask tool, and no level loosens one", async () => {
    // mustAlwaysAsk + board-approval. agent-kit__vault_drop is a plain `delete` category tool
    // (not a RECIPIENTS_OF one), so decideApproval's simplest path is exercised directly.
    expect(mustAlwaysAsk("agent-kit__vault_drop")).toEqual({
      ask: true,
      reason: "deleting data always asks first",
    });

    const deps = (level: "never" | "gated" | "autonomous" | null): BoardDeps => ({
      explicitLevel: async () => level,
      record: async () => {},
      now: () => Date.now(),
    });
    const call = {
      agent: "fixture-agent",
      tool: "agent-kit__vault_drop",
      capability: "vault",
      startingLevel: "gated" as const,
      action: "private",
    };

    // A 🚫 refuses it outright, even though it is already an always-ask tool.
    clearBoardCache();
    const never = await decideApproval(call, deps("never"));
    expect(never.decision).toBe("denied");

    // "act on its own" does NOT loosen an always-ask lock — it still asks. Cache cleared again:
    // decideApproval caches the board's level per (agent, capability, action) for 30s, and the
    // first call above would otherwise still answer for this one.
    clearBoardCache();
    const autonomous = await decideApproval(call, deps("autonomous"));
    expect(autonomous.decision).toBe("locked");
  });
});

describe("what this installation has NOT closed, stated rather than hidden", () => {
  it("eve discards the Telegram tapper's identity; ours is checked at the door, not by the framework", () => {
    // eve's own Telegram HITL resume carries `auth: null` — no tapper identity at all — and
    // approverFrom's initiator fallback is the workaround, not the framework doing this for us.
    // Calling the real function proves the fallback still works; reading the file proves the
    // gap it exists to cover is still WRITTEN DOWN, not quietly assumed away.
    const env = { TELEGRAM_PRINCIPAL_ID: "111" } as NodeJS.ProcessEnv;
    const principal = approverFrom(
      { current: null, initiator: { authenticator: "telegram-webhook", attributes: { user_id: 111 } } },
      env,
    );
    expect(principal).toEqual({ authenticator: "telegram-webhook", userId: "111" });

    const src = readFileSync(join(here, "..", "lib", "approvals.ts"), "utf8");
    expect(src).toContain("auth: null");
    expect(src).toContain("INITIATOR");
  });

  it("a reusable grant (eve's once()) is used by no tool in this repo — a grep, so it stays true", () => {
    // Matches actual USE as an approval policy (`approval: once(...)`, the same shape every
    // tool's real policy is assigned in, e.g. `approval: always()` / `approval: approvalFor(...)`)
    // rather than a bare `once(` substring — echo_note.ts's own header says, in prose, "not
    // once():", which a substring match would wrongly count as a hit.
    const servicesRoot = join(here, "..", "..");
    const dirs = readdirSync(servicesRoot)
      .map((svc) => join(servicesRoot, svc, "catalogue"))
      .filter((dir) => existsSync(dir));
    dirs.push(join(here, "..", "..", "..", "packages", "agent-kit", "extension", "tools"));

    const found: string[] = [];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        const src = readFileSync(join(dir, name), "utf8");
        if (/approval:\s*once\(/.test(src)) found.push(join(dir, name));
      }
    }
    expect(found).toEqual([]);
  });
});
