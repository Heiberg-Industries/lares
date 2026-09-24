import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEnvNames, settingsDrift, READ_INDIRECTLY } from "../src/settings-scan.js";
import { SETTING_NAMES } from "../src/settings.js";

const ROOTS = [
  "packages/agent-kit/src", "packages/vault-format/src",
  "services/chief-of-staff/lib", "services/chief-of-staff/agent",
  "services/chief-of-staff/catalogue",
  "services/travel/lib", "services/travel/agent", "services/travel/catalogue",
  "services/creative/lib", "services/creative/agent",
  "services/console/lib", "services/console/app",
  "services/box/lib", "services/keeper/lib",
  "services/atlas/lib", "services/atlas/bin",
  "services/notion-sync/lib", "services/notion-sync/bin",
  "services/readability/bin",
];

// The names that are doc-comment EXAMPLES, not settings: `X_KEY_FILE`
// (packages/agent-kit/src/integration-secret-lint.ts) and `SOME_CLIENT_ID_FILE` / `MY_KEY`
// (the console's own secrets tests), as the plan names them — plus `NAME`, which this repo's
// own `packages/vault-format/src/settings.ts` acquired after the plan was written: its header
// comment spells out the shape `process.env.NAME` / `env["NAME"]` to describe what this very
// scanner looks for, and that description is itself a literal match for the pattern it
// describes. Same kind of false positive as the other three, found only once settings.ts
// existed for this scanner to walk.
const EXAMPLES_IN_COMMENTS = new Set(["X_KEY_FILE", "SOME_CLIENT_ID_FILE", "MY_KEY", "NAME"]);

describe("the settings list and the code agree", () => {
  it("finds a name in each of the four shapes the code uses", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-scan-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"),
        'const a = process.env.ALPHA;\nconst b = process.env["BETA"];\n' +
        'function f(env: NodeJS.ProcessEnv) { return env.GAMMA ?? env["DELTA"]; }\n');
      const uses = scanEnvNames([join(dir, "src")]);
      expect(uses.map((u) => u.name).sort()).toEqual(["ALPHA", "BETA", "DELTA", "GAMMA"]);
      expect(uses.find((u) => u.name === "BETA")!.line).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("declares every environment name the engine actually reads", () => {
    const uses = scanEnvNames(ROOTS).filter((u) => !EXAMPLES_IN_COMMENTS.has(u.name));
    const { undeclared } = settingsDrift(uses, SETTING_NAMES);
    expect(undeclared.map((u) => `${u.name} (${u.file}:${u.line})`)).toEqual([]);
  });

  it("declares nothing it cannot point at, except the names read through a helper", () => {
    const uses = scanEnvNames(ROOTS);
    const { unread } = settingsDrift(uses, SETTING_NAMES);
    expect(unread.filter((n) => !(n in READ_INDIRECTLY))).toEqual([]);
  });

  it("the indirect list may only shrink, and every entry names its helper", () => {
    // The plan's own read of the code estimated "at least 24" indirect names before
    // `settings.ts` existed to scan. Running this scanner for real against the repository
    // finds 33: the plan's own contradiction-item-1 list already named 32 of them
    // (VAULT_PATH/ATLAS_PATH, TOKEN_ENC_KEY, the Slack/Telegram/Signal/Twenty/Notion/CRM
    // secret names, the GOOGLE_CLIENT_*_<ORG>/_CONSOLE family, HTTPS_PROXY/HTTP_PROXY,
    // DATABASE_PASSWORD_FILE, TZ, GIT_AUTHOR_*/GIT_COMMITTER_*, EVE_TELEMETRY_DISABLED); the
    // 33rd, CRM_STATUS_TOKEN_FILE, is CRM_STATUS_TOKEN's own `_FILE` half through the same
    // `readSecret` call. 26 was the plan's estimate, written before this file existed to
    // check it against — this bound is the real, measured count instead of that estimate,
    // still a fixed ceiling a future PR must justify raising.
    //
    // RAISED 33 → 34, W8B-s5, with its justification: `LARES_CONSOLE_PRINCIPAL` is the managed
    // half of the new `console` channel's allow-list, and it is reached through the SAME
    // `env[\`LARES_${channel.toUpperCase()}_PRINCIPAL\`]` template that already put
    // LARES_SLACK_PRINCIPAL on this list — a scanner looking for a literal `env.X` cannot see any
    // of them. It is a new setting, not a new kind of exemption. Its unmanaged twin,
    // CONSOLE_ALLOWED_EMAILS, is NOT added: the console reads that one as a literal, so the
    // scanner finds it without help.
    //
    // RAISED 34 → 35, W8C-s2b(b): `CONSOLE_SESSION_SECRET_FILE` is the same shape as
    // CRM_STATUS_TOKEN_FILE two lines above it — services/console/lib/account-oauth-state.ts now
    // reads its secret through `readSecret("CONSOLE_SESSION_SECRET")`, which builds the `_FILE`
    // name with a template literal (`` `${name}_FILE` ``) inside lib/secrets.ts, never as a
    // literal `env.CONSOLE_SESSION_SECRET_FILE` anywhere this scanner walks. Not a new kind of
    // exemption either. services/console/lib/auth.ts does NOT gain this reader: it stays on the
    // plain `process.env.CONSOLE_SESSION_SECRET` on purpose (see its own getSecret() comment) —
    // readSecret's `node:fs` import cannot appear in a file middleware.ts pulls into the Edge
    // Runtime build, confirmed with a real `next build --webpack` failure.
    //
    // RAISED 35 → 38, F6 (8F): the neutral stack's own two new containers get three names
    // (MODEL_PROVIDER_KEY_FILE, GATEWAY_MASTER_KEY_FILE, LARES_DOMAIN) — declared in SETTINGS by
    // hand under the new "gateway"/"caddy" readers, exactly as DATABASE_PASSWORD_FILE already is,
    // because none of `images/gateway-runtime/start.sh`, `services/box/ops/Caddyfile` or
    // `services/box/ops/install.sh` is TypeScript this scanner walks. Not a new kind of exemption.
    expect(Object.keys(READ_INDIRECTLY).length).toBeLessThanOrEqual(38);
    for (const [name, how] of Object.entries(READ_INDIRECTLY)) {
      expect(SETTING_NAMES.has(name), name).toBe(true);
      expect(how.length, name).toBeGreaterThan(10);
    }
    expect(READ_INDIRECTLY["VAULT_PATH"]).toMatch(/STORE_ENV/);
    expect(READ_INDIRECTLY["SLACK_ALLOWED_USER_IDS"]).toMatch(/ENV_VAR_FOR/);
    expect(READ_INDIRECTLY["TOKEN_ENC_KEY"]).toMatch(/keyFromEnv/);
  });
});
