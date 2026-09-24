// services/console/lib/account-oauth-state.ts
// Tamper-proof, short-lived OAuth `state` for the add-account round-trip. Carries the chosen org
// + principal through Google and back. HMAC-SHA256, 10-min TTL. Node-only (used in nodejs route
// handlers). Ported from old-Nora's enrollment-state.ts; keyed by CONSOLE_SESSION_SECRET, read
// through readSecret so a mounted CONSOLE_SESSION_SECRET_FILE wins over the plain env value —
// this file is Node-only (never imported by Edge middleware), so unlike lib/auth.ts it can
// safely depend on readSecret's own node:fs read.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readSecret } from "./secrets";

const TTL_MS = 10 * 60 * 1000;

// `email` binds the state to the session that initiated the flow (CSRF: the callback rejects a
// state whose email != the completing session's email). HMAC over the body means it can't be forged.
export type AccountStatePayload = { org: string; principal: string; email: string; agent?:string; incarnation?:string; mailbox?:string };

/**
 * The key this state is signed with. Three rules, each closing a way to end up signing with a key
 * anybody knows:
 *  - an EMPTY value is not a value — an empty secret file, or a blank env value, must never become
 *    an empty HMAC key;
 *  - a `_FILE` that is set but unreadable or empty falls back to the plain env value (the same
 *    secret lib/auth.ts signs the session cookie with) instead of silently dropping to the dev key
 *    while a real secret is sitting in the environment;
 *  - with nothing usable, PRODUCTION THROWS — exactly as lib/auth.ts does — and only a
 *    non-production run gets the publicly known dev key.
 */
function secret(): string {
  const fromFile = readSecret("CONSOLE_SESSION_SECRET");
  const usable = [fromFile, process.env.CONSOLE_SESSION_SECRET].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (usable !== undefined) return usable.trim();
  if (process.env.NODE_ENV === "production") {
    throw new Error("CONSOLE_SESSION_SECRET is required in production");
  }
  return "dev-only-secret";
}

export function signAccountState(payload: AccountStatePayload, opts: { nowMs?: number } = {}): string {
  const nowMs = opts.nowMs ?? Date.now();
  const blob = { o: payload.org, p: payload.principal, e: payload.email, a: payload.agent, i: payload.incarnation, m: payload.mailbox, nonce: randomBytes(16).toString("hex"), exp: nowMs + TTL_MS };
  const body = Buffer.from(JSON.stringify(blob)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; data: AccountStatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyAccountState(state: string, opts: { nowMs?: number } = {}): VerifyResult {
  if (!state || !state.includes(".")) return { ok: false, reason: "malformed" };
  const dot = state.lastIndexOf(".");
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!body || !sig) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  let blob: { o: string; p: string; e: string; a?:string; i?:string; m?:string; exp: number };
  try {
    blob = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const nowMs = opts.nowMs ?? Date.now();
  if (typeof blob.exp !== "number" || blob.exp < nowMs) return { ok: false, reason: "expired" };
  if ((blob.a !== undefined || blob.i !== undefined) && (typeof blob.a !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(blob.a) || typeof blob.i !== 'string' || !/^[a-f0-9-]{36}$/.test(blob.i) || typeof blob.m !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(blob.m))) return {ok:false,reason:'malformed'};
  return { ok: true, data: { org: blob.o, principal: blob.p, email: blob.e, ...(blob.a ? {agent:blob.a,incarnation:blob.i,mailbox:blob.m} : {}) } };
}
