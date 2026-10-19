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
// non-test source a client reads secrets from — and, since, two more places that were
// reading secrets nobody was checking: the KEEPER's lib (it is what mounts them) and each role's
// `agent/channels/`, where the Slack, Telegram and eve-route doors read theirs.
const ENGINE_ROOTS = [
  "packages/agent-kit/src", "services/chief-of-staff/lib",
  "services/creative/lib", "services/notion-sync/lib", "services/atlas/lib",
  "services/keeper/lib",
  "services/chief-of-staff/agent/channels",
  "services/creative/agent/channels",
];

// Every secret the engine reads is declared: integrations (generated), or platform and door
// secrets (src/platform-secrets.ts). The old allow-list is gone; a new undeclared secret fails.
const KNOWN_UNDECLARED_SECRETS: ReadonlyArray<{ secret: string; reason: string }> = [];

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
