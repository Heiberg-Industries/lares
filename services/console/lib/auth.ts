// Uses Web Crypto (SubtleCrypto) — works in both Edge Runtime and Node.js 20+.
// NO node:crypto — this file is imported by Edge middleware.

export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Resolve the signing secret at call time (not module load) so Next.js build
 * doesn't throw when CONSOLE_SESSION_SECRET isn't set in the build environment.
 * In production the guard fires on the first actual request.
 *
 * DELIBERATELY STILL A PLAIN process.env READ (W8C-s2b/b): lib/secrets.ts's `readSecret`
 * imports `node:fs` to resolve a `_FILE` name, and `node:fs` cannot appear anywhere in this
 * file's import graph — webpack's Edge Runtime compiler refuses it outright ("Reading from
 * 'node:fs' is not handled by plugins"), confirmed against this file with both a static and a
 * runtime-guarded dynamic `import("./secrets")` (`next build --webpack`, both fail the same
 * way; middleware.ts imports `verify` from here with no `runtime: "nodejs"` override, so it
 * compiles for Edge). lib/account-oauth-state.ts is Node-only and switched to `readSecret`
 * instead; this file did not, and CONSOLE_SESSION_SECRET_FILE has no effect on the session
 * cookie until either middleware moves off the Edge runtime or this reads its secret some
 * other way — a call the controller should make, not this slice.
 */
function getSecret(): string {
  const s = process.env.CONSOLE_SESSION_SECRET;
  if (!s && process.env.NODE_ENV === "production") {
    throw new Error("CONSOLE_SESSION_SECRET is required in production");
  }
  return s ?? "dev-only-secret";
}

// ---------------------------------------------------------------------------
// Base64url helpers — pure Web Crypto, no Buffer dependency
// ---------------------------------------------------------------------------

function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const raw = atob(padded + "=".repeat(pad));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

async function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64uEncode(new Uint8Array(sig));
}

/** Constant-time verify via crypto.subtle.verify — not vulnerable to timing attacks. */
async function hmacVerify(
  secret: string,
  data: string,
  sigB64u: string,
): Promise<boolean> {
  const key = await importHmacKey(secret, "verify");
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64uDecode(sigB64u);
  } catch {
    return false;
  }
  // Cast to ArrayBuffer to satisfy strict TS lib types (no SharedArrayBuffer).
  const sigBuf = new Uint8Array(sigBytes).buffer as ArrayBuffer;
  const dataBuf = new TextEncoder().encode(data).buffer as ArrayBuffer;
  return crypto.subtle.verify("HMAC", key, sigBuf, dataBuf);
}

// ---------------------------------------------------------------------------
// Session payload
// ---------------------------------------------------------------------------

interface SessionPayload {
  e: string;   // email
  exp: number; // Unix epoch seconds
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Sign an email into a session cookie value. Lifetime: SESSION_MAX_AGE seconds. */
export async function sign(email: string): Promise<string> {
  const secret = getSecret();
  const payload: SessionPayload = {
    e: email,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  const body = b64uEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

/**
 * Internal helper for testing expiry paths only.
 * @internal
 */
export async function _signWithExp(email: string, expSeconds: number): Promise<string> {
  const secret = getSecret();
  const payload: SessionPayload = { e: email, exp: expSeconds };
  const body = b64uEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

/**
 * Verify a session cookie value.
 * Returns the email on success; null if invalid, tampered, expired, or not on
 * the allow-list. Allow-list is enforced here so every request path (middleware
 * + server actions) honors it automatically — not just at OAuth callback time.
 */
export async function verify(cookie: string | undefined): Promise<string | null> {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  if (dot === -1) return null;
  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!body || !sig) return null;

  const secret = getSecret();
  const valid = await hmacVerify(secret, body, sig);
  if (!valid) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(body))) as SessionPayload;
  } catch {
    return null;
  }

  if (Math.floor(Date.now() / 1000) > payload.exp) return null;

  // I2: enforce allow-list on every request, not just at OAuth callback
  if (!allowed(payload.e)) return null;

  return payload.e;
}

/** Return true if `email` is on the allow-list. Throws in production if env is unset. */
export function allowed(email: string): boolean {
  const raw = process.env.CONSOLE_ALLOWED_EMAILS;
  if (!raw && process.env.NODE_ENV === "production") {
    throw new Error("CONSOLE_ALLOWED_EMAILS is required in production");
  }
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(email);
}
