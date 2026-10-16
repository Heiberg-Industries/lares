import { describe, expect, it, vi } from "vitest";

import { CLAIM_REPLY_CONNECTED, CLAIM_REPLY_NOT_YET, interceptTelegramClaim } from "../src/door-channels.js";

const env = { LARES_AGENT_NAME: "example-agent", LARES_AGENT_INCARNATION: "11111111-2222-3333-4444-555555555555" } as NodeJS.ProcessEnv;
const privateHuman = (text: string, id = "42") => ({ text, chat: { type: "private" }, from: { id, isBot: false } });

/** A database that answers the claim statement with `claimRows` and the door lookup with `door`. */
function fakeDb(opts: { claimRows?: unknown[]; door?: Record<string, unknown> }) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("agent_door_connections c SET attempts")) return { rows: opts.claimRows ?? [] };
      return { rows: [{ enabled: true, applied_enabled: true, pending: false, principal: null, claimed_at: null, ...opts.door }] };
    }),
  };
}

describe("the door's fixed replies", () => {
  it("confirms a successful claim in one line", async () => {
    const reply = vi.fn(async () => {});
    const handled = await interceptTelegramClaim(privateHuman("claim ABCDEFGHJKLMNPQRSTUVWXYZ"), fakeDb({ claimRows: [{ name: "example-agent" }] }), env, reply);
    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledExactlyOnceWith(CLAIM_REPLY_CONNECTED);
  });

  it("answers a wrong code with the same generic line, never saying why", async () => {
    const reply = vi.fn(async () => {});
    expect(await interceptTelegramClaim(privateHuman("claim WRONG"), fakeDb({ claimRows: [] }), env, reply)).toBe(true);
    expect(reply).toHaveBeenCalledExactlyOnceWith(CLAIM_REPLY_NOT_YET);
  });

  it("answers a bare code (no claim word) from an unclaimed door, then still refuses the message", async () => {
    const reply = vi.fn(async () => {});
    await expect(interceptTelegramClaim(privateHuman("ABCDEFGHJKLMNPQRSTUVWXYZ"), fakeDb({}), env, reply)).rejects.toThrow();
    expect(reply).toHaveBeenCalledExactlyOnceWith(CLAIM_REPLY_NOT_YET);
  });

  it("says nothing in a group chat", async () => {
    const reply = vi.fn(async () => {});
    const group = { text: "claim WRONG", chat: { type: "supergroup" }, from: { id: "42", isBot: false } };
    expect(await interceptTelegramClaim(group, fakeDb({}), env, reply)).toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });

  it("the unusable-message line reveals nothing about the installation", () => {
    expect(CLAIM_REPLY_NOT_YET).not.toMatch(/example-agent|owner|principal|claimed|already/i);
    expect(CLAIM_REPLY_NOT_YET.length).toBeLessThan(140);
  });

  it("a failing send never changes the decision", async () => {
    const reply = vi.fn(async () => { throw new Error("network down"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await interceptTelegramClaim(privateHuman("claim WRONG"), fakeDb({}), env, reply)).toBe(true);
  });

  it("an installation without managed identity does nothing at all", async () => {
    const reply = vi.fn(async () => {});
    expect(await interceptTelegramClaim(privateHuman("claim X"), fakeDb({}), {} as NodeJS.ProcessEnv, reply)).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});
