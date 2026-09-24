import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import echoNote, { UnauthorizedApproverError } from "../catalogue/echo_note.js";
import { allowedSlackUserIds, isAllowedSlackUserId } from "../lib/slack-allowlist.js";

/**
 * Task 9 — the approval gate, proven on a harmless action before any real write exists.
 *
 * `echo_note` appends a line to a log file and nothing else. Its only job is to be the
 * cheapest possible thing that can prove the mechanism the cutover will hang Gmail sends,
 * CRM writes and reminders on.
 */

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";

function slackAuth(userId: string) {
  // The shape eve's Slack channel builds (buildSlackAuthContext): authenticator
  // "slack-webhook", the user id under attributes.user_id.
  return {
    attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" },
    authenticator: "slack-webhook",
    principalId: `slack:T1:${userId}`,
    principalType: "user",
  };
}

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

let logDir: string;
let logPath: string;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "eve-gate-"));
  logPath = join(logDir, "eve-gate-proof.log");
  process.env["EVE_GATE_PROOF_LOG"] = logPath;
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
});

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
  delete process.env["EVE_GATE_PROOF_LOG"];
  delete process.env["SLACK_ALLOWED_USER_IDS"];
});

describe("the Slack user allowlist", () => {
  it("fails closed when unset or blank", () => {
    delete process.env["SLACK_ALLOWED_USER_IDS"];
    expect(allowedSlackUserIds()).toEqual([]);
    expect(isAllowedSlackUserId(BENDIK)).toBe(false);
    process.env["SLACK_ALLOWED_USER_IDS"] = "   ";
    expect(isAllowedSlackUserId(BENDIK)).toBe(false);
  });

  it("reads a comma-separated list and ignores whitespace", () => {
    process.env["SLACK_ALLOWED_USER_IDS"] = ` ${BENDIK} , U2 `;
    expect(allowedSlackUserIds()).toEqual([BENDIK, "U2"]);
  });

  it("never admits an empty id, however the list is punctuated", () => {
    process.env["SLACK_ALLOWED_USER_IDS"] = ",,";
    expect(isAllowedSlackUserId("")).toBe(false);
    expect(isAllowedSlackUserId(undefined)).toBe(false);
  });
});

describe("echo_note's approval gate", () => {
  it("requires approval on every call", async () => {
    expect(echoNote.approval).toBeTypeOf("function");
    const decision = await echoNote.approval!({
      approvedTools: new Set(["echo_note"]), // already approved once — must still prompt
      callId: "call_1",
      toolName: "echo_note",
      toolInput: { note: "hello" },
      ...ctx(slackAuth(BENDIK)),
    } as never);
    expect(decision).toBe("user-approval");
  });

  it("writes nothing until execute runs", () => {
    // The gate's whole value: eve calls `approval` first and only calls `execute` on an
    // approval. Deciding does not touch the file — so a rejected call leaves no trace.
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("echo_note's execute", () => {
  it("appends the note when an allowlisted person approved", async () => {
    const result = await echoNote.execute({ note: "the gate works" }, ctx(slackAuth(BENDIK)));
    expect(result.path).toBe(logPath);
    expect(readFileSync(logPath, "utf8")).toContain("the gate works");
    expect(readFileSync(logPath, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends rather than replacing, so two proofs both survive", async () => {
    await echoNote.execute({ note: "first" }, ctx(slackAuth(BENDIK)));
    await echoNote.execute({ note: "second" }, ctx(slackAuth(BENDIK)));
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  /**
   * This is the part eve does NOT give you. Its docs are explicit: "Built-in HITL buttons
   * are handled before `onInteraction`, and the person who clicks supplies the Slack auth
   * for the resumed session. Anyone who can interact with the Slack message can answer it."
   *
   * So the approval prompt authenticates that SOMEONE with sight of the message clicked —
   * not that they were allowed to. The channel's inbound allowlist does not cover it,
   * because the click never reaches an authored inbound handler. The tool must re-check.
   */
  it("refuses when the approver is not on the Slack allowlist", async () => {
    await expect(
      echoNote.execute({ note: "not mine to approve" }, ctx(slackAuth(SOMEONE_ELSE))),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(existsSync(logPath)).toBe(false);
  });

  it("refuses a fully unauthenticated session — null current AND null initiator", async () => {
    await expect(echoNote.execute({ note: "x" }, ctx(null))).rejects.toThrow(
      UnauthorizedApproverError,
    );
    expect(existsSync(logPath)).toBe(false);
  });

  it("attributes an anonymous resume to the session's ALLOWLISTED initiator — the Telegram HITL shape", async () => {
    // eve's Telegram channel resumes approval taps with `auth: null` (dist:
    // telegramChannel.js dispatchCallbackQuery) — the tap has no identity of its own.
    // approverFrom then checks the session's INITIATOR: here a secret-token-verified,
    // allowlisted Telegram principal, so the approval passes.
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456789";
    try {
      const telegramInitiator = {
        authenticator: "telegram-webhook",
        attributes: { user_id: 123456789 },
      };
      await echoNote.execute(
        { note: "x" },
        { session: { id: "wrun_test", auth: { current: null, initiator: telegramInitiator } } } as never,
      );
      expect(existsSync(logPath)).toBe(true);
    } finally {
      delete process.env["TELEGRAM_PRINCIPAL_ID"];
    }
  });

  it("refuses an anonymous resume whose initiator is NOT on the allowlist", async () => {
    process.env["TELEGRAM_PRINCIPAL_ID"] = "123456789";
    try {
      const stranger = { authenticator: "telegram-webhook", attributes: { user_id: 999 } };
      await expect(
        echoNote.execute(
          { note: "x" },
          { session: { id: "wrun_test", auth: { current: null, initiator: stranger } } } as never,
        ),
      ).rejects.toThrow(UnauthorizedApproverError);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      delete process.env["TELEGRAM_PRINCIPAL_ID"];
    }
  });

  it("refuses a principal that is not Slack-derived, even with a matching id", async () => {
    // A forged or unrelated authenticator must not satisfy the check by carrying the right
    // user_id: only eve's Slack webhook path can vouch for a Slack user id.
    await expect(
      echoNote.execute(
        { note: "x" },
        ctx({ ...slackAuth(BENDIK), authenticator: "http-basic" }),
      ),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(existsSync(logPath)).toBe(false);
  });

  it("names the approver and the reason, without leaking the note", async () => {
    await expect(
      echoNote.execute({ note: "secret text" }, ctx(slackAuth(SOMEONE_ELSE))),
    ).rejects.toThrow(new RegExp(SOMEONE_ELSE));
    await expect(
      echoNote.execute({ note: "secret text" }, ctx(slackAuth(SOMEONE_ELSE))),
    ).rejects.not.toThrow(/secret text/);
  });
});
