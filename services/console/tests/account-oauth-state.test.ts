import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signAccountState, verifyAccountState } from "../lib/account-oauth-state";

beforeEach(() => { process.env.CONSOLE_SESSION_SECRET = "test-secret"; });
afterEach(() => { delete process.env.CONSOLE_SESSION_SECRET_FILE; });

describe("account oauth state", () => {
  it("round-trips org + principal", () => {
    const s = signAccountState({ org: "zero7", principal: "U_bendik", email: "owner@owner.example" });
    const r = verifyAccountState(s);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ org: "zero7", principal: "U_bendik", email: "owner@owner.example" });
  });

  it("rejects a tampered body", () => {
    const s = signAccountState({ org: "heiberg", principal: "U_bendik", email: "owner@owner.example" });
    const [body, sig] = s.split(".");
    const tampered = `${body}x.${sig}`;
    expect(verifyAccountState(tampered)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("rejects a malformed string", () => {
    expect(verifyAccountState("nodot")).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("rejects an expired state", () => {
    const past = 1_000_000;
    const s = signAccountState({ org: "heiberg", principal: "U_bendik", email: "owner@owner.example" }, { nowMs: past });
    expect(verifyAccountState(s, { nowMs: past + 11 * 60 * 1000 })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects a state signed with a different secret", () => {
    const s = signAccountState({ org: "heiberg", principal: "U_bendik", email: "owner@owner.example" });
    process.env.CONSOLE_SESSION_SECRET = "different-secret";
    expect(verifyAccountState(s)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  // W8C-s2b(b): CONSOLE_SESSION_SECRET_FILE wins over the plain env value — readSecret's own
  // file-first rule (services/console/lib/secrets.ts), now used here too.
  it("prefers CONSOLE_SESSION_SECRET_FILE over the plain env value", () => {
    const dir = mkdtempSync(join(tmpdir(), "account-oauth-state-"));
    try {
      const file = join(dir, "console-session-secret");
      writeFileSync(file, "from-the-file\n");
      process.env.CONSOLE_SESSION_SECRET_FILE = file;
      process.env.CONSOLE_SESSION_SECRET = "plain-value-must-be-ignored";
      const s = signAccountState({ org: "fixture-org", principal: "fixture-owner", email: "owner@example.test" });
      // Changing the plain value afterwards must not matter — the file already won.
      process.env.CONSOLE_SESSION_SECRET = "changed-plain-value";
      const r = verifyAccountState(s);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The commit security review found that this key could drift to a value anybody knows: an empty
// or unreadable secret file silently became the dev key (or an EMPTY key) even with a real secret
// in the environment, and production never refused. These pin the three rules in `secret()`.
describe("the key an OAuth state is signed with never quietly becomes a known one", () => {
  const payload = { org: "fixture-org", principal: "fixture-owner", email: "owner@example.test" };
  const env = process.env as Record<string, string | undefined>;
  let savedNodeEnv: string | undefined;
  beforeEach(() => { savedNodeEnv = env.NODE_ENV; });
  afterEach(() => { env.NODE_ENV = savedNodeEnv; });

  it("an unreadable secret file falls back to the plain value, not to the dev key", () => {
    env.CONSOLE_SESSION_SECRET_FILE = join(tmpdir(), "there-is-no-such-secret-file");
    env.CONSOLE_SESSION_SECRET = "the-real-plain-secret";
    const signed = signAccountState(payload);
    delete env.CONSOLE_SESSION_SECRET_FILE;            // verify with the plain value alone
    expect(verifyAccountState(signed).ok).toBe(true);
  });

  it("an EMPTY secret file is not a secret: it falls back too, and never signs with an empty key", () => {
    const dir = mkdtempSync(join(tmpdir(), "account-oauth-state-"));
    try {
      const file = join(dir, "console-session-secret");
      writeFileSync(file, "\n");
      env.CONSOLE_SESSION_SECRET_FILE = file;
      env.CONSOLE_SESSION_SECRET = "the-real-plain-secret";
      const signed = signAccountState(payload);
      delete env.CONSOLE_SESSION_SECRET_FILE;
      expect(verifyAccountState(signed).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("in production, no usable secret is a refusal — never the dev key", () => {
    delete env.CONSOLE_SESSION_SECRET;
    delete env.CONSOLE_SESSION_SECRET_FILE;
    env.NODE_ENV = "production";
    expect(() => signAccountState(payload)).toThrow(/required in production/);
    expect(() => verifyAccountState("a.b")).toThrow(/required in production/);
    env.CONSOLE_SESSION_SECRET = "   ";               // blank is not a secret either
    expect(() => signAccountState(payload)).toThrow(/required in production/);
  });

  it("outside production the dev key still works, so local development is unchanged", () => {
    delete env.CONSOLE_SESSION_SECRET;
    env.NODE_ENV = "test";
    expect(verifyAccountState(signAccountState(payload)).ok).toBe(true);
  });
});

it('signs and returns the agent incarnation, and rejects unsigned rebinding',()=>{
 const payload={org:'tenant',principal:'explicit-owner',email:'owner@example.test',agent:'example',mailbox:'selected@example.test',incarnation:'11111111-1111-4111-8111-111111111111'};
 const state=signAccountState(payload);expect(verifyAccountState(state)).toEqual({ok:true,data:payload});
 const [body,sig]=state.split('.');const changed=JSON.parse(Buffer.from(body,'base64url').toString());changed.a='other';
 expect(verifyAccountState(Buffer.from(JSON.stringify(changed)).toString('base64url')+'.'+sig)).toMatchObject({ok:false,reason:'bad_signature'});
});

it("rejects managed state missing the selected mailbox",()=>{
 expect(verifyAccountState(signAccountState({org:"tenant",principal:"explicit",email:"owner@example.test",agent:"example",incarnation:"11111111-1111-4111-8111-111111111111"}))).toMatchObject({ok:false,reason:"malformed"});
});
