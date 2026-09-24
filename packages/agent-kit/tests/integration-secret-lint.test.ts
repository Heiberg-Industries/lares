import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintUndeclaredSecrets, SECRET_PATH_RE } from "../src/integration-secret-lint.js";

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "secret-lint-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

// The roots the real check below scans: every service's `lib/` plus the kit's own `src/` — the
// non-test source a client reads secrets from — and, since LAR-76, two more places that were
// reading secrets nobody was checking: the KEEPER's lib (it is what mounts them) and each role's
// `agent/channels/`, where the Slack, Telegram and eve-route doors read theirs.
const ENGINE_ROOTS = [
  "packages/agent-kit/src", "services/chief-of-staff/lib", "services/travel/lib",
  "services/creative/lib", "services/notion-sync/lib", "services/atlas/lib",
  "services/keeper/lib",
  "services/chief-of-staff/agent/channels", "services/travel/agent/channels",
  "services/creative/agent/channels",
];

// DEVIATION FROM THE SLICE, recorded here rather than silently: the slice's own draft test
// asserted `lintUndeclaredSecrets(ENGINE_ROOTS)` is `[]` today. Running the finished lint against
// the real tree contradicts that — it finds six real, pre-existing undeclared secrets, none of
// them introduced by this slice. Renaming a secret, editing a door or adding a name to a manifest
// just to make the count zero would be the exact silencing this slice exists to prevent. Instead
// the check ships this committed allow-list: every entry is a KNOWN gap with a one-line reason,
// the list may only ever get SHORTER (a future fix removes the entry, it can never grow to cover
// a new gap), and it rots loudly — the second test below fails the day a fix makes an entry here
// no longer true, forcing it out of the list in the same change.
const KNOWN_UNDECLARED_SECRETS: ReadonlyArray<{ secret: string; reason: string }> = [
  {
    secret: "runtime-control",
    reason: "keeper's own runtime-control-plane password, not a vendor credential — no integration manifest is the right home for it",
  },
  {
    secret: "token-enc-key",
    reason: "the Google-token-at-rest encryption key, not a vendor credential itself — no integration manifest is the right home for it",
  },
  {
    secret: "langfuse-keys",
    reason: "Langfuse (observability) has no integration manifest yet — outside 6A's three vendors (Notion, Slack, Google)",
  },
  {
    secret: "marcel-eve-telegram-webhook-secret",
    reason: "installation.json's telegram:marcel instance declares only the bot token; the webhook secret for that same instance was never added",
  },
  {
    secret: "marcel-eve-gateway-key",
    reason: "named marcel-eve-gateway-key in code but declared as marcel-gateway-key in installation.json's gateway:marcel instance — same credential, two spellings",
  },
  // `google-places-api-key` left this list in LAR-76: it now has a `places` connection entry in
  // integrations/installation.json, which is what closing an entry looks like.
  //
  // Everything below arrived with LAR-76's two new roots (the keeper's lib and the role doors).
  // Not one of them is a new hole — they were always there, just unscanned. NOTHING here was
  // renamed to make the lint quieter: a door's secret file name is what the box already calls it.
  {
    secret: "database-password",
    reason: "the agent container's own Postgres password, written by the keeper — not a vendor credential, so no integration manifest is its home",
  },
  {
    secret: "eve-route-password",
    reason: "the agent's own HTTP route password — a platform secret declared by hand in services/keeper/lib/runtime-bindings.ts, deliberately not an integration",
  },
  {
    secret: "eve-slack-bot-token",
    reason: "the chief-of-staff Slack door's real file name; installation.json's slack:saga instance declares `slack-bot-token`, a spelling no code reads",
  },
  {
    secret: "eve-slack-signing-secret",
    reason: "the same door's signing secret; slack:saga declares `slack-app-token`, which is a different credential, not another spelling",
  },
  {
    secret: "eve-telegram-bot-token",
    reason: "the chief-of-staff Telegram door's real file name; installation.json's telegram:saga declares `telegram-bot-token`, a spelling no code reads",
  },
  {
    secret: "eve-telegram-webhook-secret",
    reason: "the same door's webhook secret, never declared for that instance — the exact gap already recorded above for the other Telegram instance",
  },
  {
    secret: "calliope-slack-signing-secret",
    reason: "the creative Slack door's signing secret; its slack instance declares an app token, not a signing secret",
  },
];

describe("undeclared secrets", () => {
  it("finds a secret file a manifest never declared", () => {
    const root = scratch({ "lib/x.ts": `const p = "/run/secrets/stripe-key";` });
    const found = lintUndeclaredSecrets([root]);
    expect(found.map((f) => f.secret)).toEqual(["stripe-key"]);
    expect(found[0]!.message).toMatch(/integrations\//);
  });

  it("says nothing about a secret that IS declared", () => {
    const root = scratch({ "lib/y.ts": `const p = "/run/secrets/notion-token";` });
    expect(lintUndeclaredSecrets([root])).toEqual([]);
  });

  it("reads a *_FILE env default too, not only a bare literal", () => {
    const root = scratch({
      "lib/z.ts": `const f = process.env["STRIPE_KEY_FILE"] ?? "/run/secrets/stripe-key";`,
    });
    expect(lintUndeclaredSecrets([root]).map((f) => f.secret)).toEqual(["stripe-key"]);
  });

  it("never reports a secret's VALUE, only its file name", () => {
    const root = scratch({ "lib/q.ts": `const k = "sk-live-abcdef";` });
    expect(lintUndeclaredSecrets([root])).toEqual([]);
    expect(SECRET_PATH_RE.source).not.toMatch(/sk-/);
  });

  // The load-bearing pair. Read together, they are the whole mechanism: (1) nothing NEW may
  // slip in undeclared, and (2) nothing on the list may quietly stop being true — the allow-list
  // can only shrink, never rot in place.
  it("finds only the known, allow-listed undeclared secrets anywhere in the engine today", () => {
    const found = lintUndeclaredSecrets(ENGINE_ROOTS);
    const allowed = new Set(KNOWN_UNDECLARED_SECRETS.map((k) => k.secret));
    const unexpected = found.filter((f) => !allowed.has(f.secret));
    expect(unexpected, `new undeclared secret(s) not on the allow-list:\n${
      unexpected.map((f) => `  ${f.secret} (${f.file})`).join("\n")
    }`).toEqual([]);
  });

  it("keeps the allow-list honest: every entry must still be undeclared", () => {
    const found = new Set(lintUndeclaredSecrets(ENGINE_ROOTS).map((f) => f.secret));
    const stale = KNOWN_UNDECLARED_SECRETS.filter((k) => !found.has(k.secret));
    expect(stale, `allow-listed secret(s) no longer undeclared — remove from the list:\n${
      stale.map((k) => `  ${k.secret}`).join("\n")
    }`).toEqual([]);
  });
});
