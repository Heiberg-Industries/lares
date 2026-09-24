// A setting the code reads and nobody declared is a build failure (W8A-s2).
//
// `settings.ts` (W8A-s1) is one list that claims to say what every setting is for. Nothing
// checked that claim against what the engine's OWN CODE actually reads. This is a TRIPWIRE over
// SOURCE TEXT, the same shape `integration-secret-lint.ts` already uses in this repository: walk
// `.ts`/`.tsx`/`.mts` files under given roots, find every `process.env.X` / `env["X"]` shape, and
// report the two failure directions — a name the code reads that `SETTINGS` does not declare, and
// a name `SETTINGS` declares that the walk cannot find anywhere (a list that only grows is not a
// list).
//
// What this walk CANNOT see, by construction: a name reached only through a helper that takes the
// name as a variable (`readSecret(name)`, `readSecretFile(envVar, ...)`, `keyFromEnv(varName)`),
// a name built from a template (`` `GOOGLE_CLIENT_ID_${org}` ``), or a name read by something
// other than this repository's TypeScript (a shell script's `${VAR}`, the `git` binary, Node's
// own timezone handling). `READ_INDIRECTLY` is the named, shrink-only escape hatch for exactly
// those — every entry names the helper so the exemption stays auditable, never silent.
//
// No credential reads and no I/O at module scope. Build- and test-time only.
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, extname, join, resolve } from "node:path";

export interface EnvUse {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

// Same skip set as `integration-secret-lint.ts` and `one-name.test.ts`, plus the build outputs
// those two files did not need to skip because they never walk `services/console` (Next's own
// `.next`) or an eve dev copy of the tree (`.eve`, `.output`).
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".eve", ".output", ".next"]);

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

/** `root` as given, resolved against the repo root when it is not already absolute — so a caller
 *  can pass either a scratch directory (tests) or a repo-relative path like
 *  `"packages/agent-kit/src"` (the real check, run from any package's own `vitest run`). */
function resolveRoot(root: string): string {
  return isAbsolute(root) ? root : join(REPO_ROOT, root);
}

function walkTextFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a root that does not exist (yet) finds nothing, rather than throwing
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) out.push(join(dir, entry.name));
    }
  }
  return out;
}

// `process.env.X`, `process.env["X"]`, `env.X` and `env["X"]` — the four shapes this codebase
// uses (`one-name.test.ts`'s own `grepRepo` documents the same "walk, skip, match" shape for a
// different tripwire). The name must start with a letter and be at least 3 characters so this
// does not match `env.NODE_ENV`'s own `E`, a stray `env.ts`, or similar noise — every real
// setting name in this codebase already satisfies `^[A-Z][A-Z0-9_]*$` and is well over 2 chars.
const ENV_USE_RE = /\b(?:process\.)?env(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\])/g;

/** Every `process.env.X`, `process.env["X"]`, `env.X` and `env["X"]` under `roots`. `roots` may
 *  be absolute (a scratch directory) or repo-relative (`"packages/agent-kit/src"`). */
export function scanEnvNames(roots: readonly string[]): EnvUse[] {
  const out: EnvUse[] = [];
  for (const root of roots) {
    for (const file of walkTextFiles(resolveRoot(root))) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      const relFile = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
      const re = new RegExp(ENV_USE_RE.source, ENV_USE_RE.flags);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
          const name = m[1] ?? m[2]!;
          out.push({ file: relFile, line: i + 1, name });
        }
      }
    }
  }
  return out;
}

export interface SettingsDrift {
  /** Read by the code, absent from SETTINGS. */
  readonly undeclared: readonly EnvUse[];
  /** Declared, read nowhere the scan can see. */
  readonly unread: readonly string[];
}

/** Two set differences: every distinct name the scan found that `declared` does not contain
 *  (kept as the full `EnvUse` so a failure can name the file and line), and every name
 *  `declared` contains that the scan found nowhere at all. */
export function settingsDrift(uses: readonly EnvUse[], declared: ReadonlySet<string>): SettingsDrift {
  const undeclared: EnvUse[] = [];
  const seenUndeclared = new Set<string>();
  const foundNames = new Set<string>();
  for (const use of uses) {
    foundNames.add(use.name);
    if (declared.has(use.name)) continue;
    const key = `${use.file}\0${use.line}\0${use.name}`;
    if (seenUndeclared.has(key)) continue;
    seenUndeclared.add(key);
    undeclared.push(use);
  }
  const unread = [...declared].filter((name) => !foundNames.has(name)).sort();
  return { undeclared, unread };
}

/** The names reached only through a helper taking the name as a string (or a shell/`git`
 *  read this scan cannot see at all), so the scanner cannot see them as a literal
 *  `process.env.X` / `env["X"]`. Each entry names the helper and where it is used. This list may
 *  only SHRINK — a name leaves it only when the code changes to read it as a literal instead. */
export const READ_INDIRECTLY: Readonly<Record<string, string>> = {
  // packages/agent-kit/src/notes-store.ts:20-22 — `env[STORE_ENV[store]]`, never a literal
  // `env.VAULT_PATH` / `env.ATLAS_PATH`.
  VAULT_PATH: "STORE_ENV in packages/agent-kit/src/notes-store.ts",
  ATLAS_PATH: "STORE_ENV in packages/agent-kit/src/notes-store.ts",
  // services/box/lib/crypto.ts's `keyFromEnv` reads `process.env[varName]` with `varName` a
  // parameter, never a literal `env.TOKEN_ENC_KEY`.
  TOKEN_ENC_KEY: "keyFromEnv in services/box/lib/crypto.ts",
  // services/chief-of-staff/lib/principals.ts's `ENV_VAR_FOR` maps a channel to its env var name,
  // then a caller reads `process.env[ENV_VAR_FOR[channel]]` — never a literal for any of these.
  SLACK_ALLOWED_USER_IDS: "ENV_VAR_FOR in services/chief-of-staff/lib/principals.ts",
  CRM_STATUS_TOKEN: "readSecret in services/console/lib/crm-status.ts",
  CRM_STATUS_TOKEN_FILE: "readSecret's own *_FILE half, in services/console/lib/crm-status.ts",
  CONSOLE_SESSION_SECRET_FILE: "readSecret's own *_FILE half, in services/console/lib/account-oauth-state.ts",
  SIGNAL_ADMIN_TOKEN: "readSecret in services/console/lib/signals.ts",
  SIGNAL_READ_TOKEN: "readSecret in services/console/lib/signals.ts",
  TWENTY_KEY: "readSecret in services/notion-sync/lib/cli.ts",
  NOTION_SYNC_PRINCIPAL: "readSecret in services/notion-sync/lib/cli.ts",
  SLACK_BOT_TOKEN_FILE: "readSecret in services/chief-of-staff/agent/channels/slack.ts",
  SLACK_SIGNING_SECRET_FILE: "readSecret in services/chief-of-staff/agent/channels/slack.ts",
  TELEGRAM_BOT_TOKEN: "eve's own Telegram channel binding, not this repository's TypeScript",
  TELEGRAM_BOT_TOKEN_FILE: "readSecretFile in services/travel/lib/telegram-credentials.ts",
  TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE: "readSecretFile in services/travel/lib/telegram-credentials.ts",
  // `env[`LARES_${channel.toUpperCase()}_PRINCIPAL`]` in services/chief-of-staff/lib/principals.ts
  // — a template-literal key, never a literal `env.LARES_SLACK_PRINCIPAL`. The CLAIM_REVISION
  // pair is written the same templated way by the keeper (`environment[`LARES_${claim.kind
  // .toUpperCase()}_CLAIM_REVISION`]`) and read back by nothing in this repository's TypeScript
  // at all — bookkeeping only, per its own breaksWithout in settings.ts.
  LARES_SLACK_PRINCIPAL: "templated LARES_${channel}_PRINCIPAL key in services/chief-of-staff/lib/principals.ts",
  LARES_CONSOLE_PRINCIPAL: "templated LARES_${channel}_PRINCIPAL key in services/chief-of-staff/lib/principals.ts and services/creative/lib/principals.ts (W8B-s5)",
  LARES_SLACK_CLAIM_REVISION: "templated LARES_${claim.kind}_CLAIM_REVISION key, written only, in services/keeper/lib/compose-agents.ts",
  LARES_TELEGRAM_CLAIM_REVISION: "templated LARES_${claim.kind}_CLAIM_REVISION key, written only, in services/keeper/lib/compose-agents.ts",
  // The GOOGLE_CLIENT_{ID,SECRET}_<ORG>[_FILE] family — one templated shape, three concrete
  // installation-time instances declared in SETTINGS. Every one of them is read through a
  // helper that takes the env var NAME as a string (`readSecretFile(row.clientIdEnv, ...)` in
  // google-orgs.ts, `readSecretFile("GOOGLE_CLIENT_ID_HEIBERG_FILE", ...)` in travel/lib/google.ts,
  // `readSecret(`GOOGLE_CLIENT_ID_${org.toUpperCase()}`)` in console/lib/accounts.ts for any org
  // discovered at runtime) — never read as a direct property access off the environment object.
  GOOGLE_CLIENT_ID_HEIBERG_FILE: "readSecretFile via ORG_SECRET_ENV in services/chief-of-staff/lib/google-orgs.ts",
  GOOGLE_CLIENT_SECRET_HEIBERG_FILE: "readSecretFile via ORG_SECRET_ENV in services/chief-of-staff/lib/google-orgs.ts",
  GOOGLE_CLIENT_ID_ZERO7_FILE: "readSecretFile via ORG_SECRET_ENV in services/chief-of-staff/lib/google-orgs.ts",
  GOOGLE_CLIENT_SECRET_ZERO7_FILE: "readSecretFile via ORG_SECRET_ENV in services/chief-of-staff/lib/google-orgs.ts",
  GOOGLE_CLIENT_ID_CONSOLE: "requireEnv in services/console/app/api/auth/[...route]/route.ts",
  GOOGLE_CLIENT_SECRET_CONSOLE: "requireEnv in services/console/app/api/auth/[...route]/route.ts",
  // services/keeper/lib/compose-agents.ts's `environment` object literal WRITES these as
  // property keys for the AGENT container the keeper renders — nothing in this repository's
  // TypeScript reads either one back off the environment object; they are consumed by
  // whatever HTTP client the running agent process delegates proxying to.
  HTTPS_PROXY: "written as an object key in services/keeper/lib/compose-agents.ts, never read back in this repo",
  HTTP_PROXY: "written as an object key in services/keeper/lib/compose-agents.ts, never read back in this repo",
  // DATABASE_URL, WORKFLOW_POSTGRES_URL, GATEWAY_URL, GATEWAY_KEY_FILE, LARES_AGENT_NAME and
  // LARES_DEFINITION_DIR are also start.sh's own `${VAR:?...}` guard, but every one of THOSE
  // six is read as a literal `env["NAME"]` elsewhere in this repo's TypeScript too (db.ts,
  // gateway-provider.ts, definition-cache.ts, …), so the scan finds them directly and they do
  // NOT need an entry here. DATABASE_PASSWORD_FILE is the one exception: it is read only by
  // start.sh's guard and exported as PGPASSWORD by the same script — no TypeScript in this
  // repo ever names it.
  DATABASE_PASSWORD_FILE: "start.sh's own ${VAR:?...} guard in images/agent-runtime/start.sh",
  // F6 (8F): the neutral stack's own containers (gateway, caddy) are shell/Caddyfile-only,
  // the same shape as DATABASE_PASSWORD_FILE above — no TypeScript in this repo reads them.
  MODEL_PROVIDER_KEY_FILE: "the gateway container's own ${VAR:?...} guard in images/gateway-runtime/start.sh",
  GATEWAY_MASTER_KEY_FILE: "the gateway container's own ${VAR:?...} guard in images/gateway-runtime/start.sh",
  LARES_DOMAIN: "Caddy's own {$LARES_DOMAIN} substitution in services/box/ops/Caddyfile, and written (never read back) by services/box/ops/install.sh",
  // Consumed by something other than this repository's TypeScript.
  TZ: "the Node runtime's own timezone handling, not this repository's TypeScript",
  GIT_AUTHOR_NAME: "the git binary itself, via services/keeper/lib/git-backup.ts's env passthrough",
  GIT_AUTHOR_EMAIL: "the git binary itself, via services/keeper/lib/git-backup.ts's env passthrough",
  GIT_COMMITTER_NAME: "the git binary itself, via services/keeper/lib/git-backup.ts's env passthrough",
  GIT_COMMITTER_EMAIL: "the git binary itself, via services/keeper/lib/git-backup.ts's env passthrough",
  EVE_TELEMETRY_DISABLED: "the eve framework itself; only ever set as a Dockerfile ENV, never read as TypeScript",
};
