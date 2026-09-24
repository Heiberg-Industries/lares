// services/box/lib/doctor.ts — W8A-s6: one command says what is wrong with this installation,
// and what to type. Plan: .claude/plans/2026-09-20-prelaunch-wave-8.md, "8A — one validated
// settings list, and `lares doctor`", slice W8A-s6.
//
// READ-ONLY, BY CONSTRUCTION. Every check below is a SELECT, or a read of a file's existence and
// readability (never its contents when a setting is marked secret). Nothing here writes to the
// database, writes a file, restarts anything, or makes a network call: the "gateway" check is
// always `unknown` in this slice, because asking the model gateway is a paid outside call the
// owner has to ask for (`lares doctor --test-model`, W8A-s7, owner decision A2) — this file makes
// none. `tests/doctor.test.ts`'s "only ever reads" case records every statement sent through a
// fake `Queryable` and asserts each one starts with SELECT.
//
// PURE CORE + INJECTED EFFECTS. `DoctorDeps` carries the environment, a `Queryable` (or `null`
// when the database could not even be reached), the directory to read migrations from, a clock,
// and — because `checkSettings` (W8A-s3) needs one — a way to probe a `*_FILE` setting's file
// without ever reading its bytes. Every branch here is exercised by tests/doctor.test.ts with a
// fake database, no Docker and no real files.
//
// NEVER A CRASH. A database that cannot be reached, or a table this file wants that a fresh
// install has not migrated yet, is ITSELF a finding, with a fix — never an exception that reaches
// the caller. Each check below catches its own failure.
//
// NEVER A SECRET. `checkSettings` only ever sees a setting's NAME and, for a `*_FILE` setting,
// three booleans about the file it names (exists / readable / empty) — never the file's bytes,
// and never an environment VALUE for a setting `SETTINGS` marks secret.
//
// THE LEFTOVER OWNER (A3). `services/box/sql/014_identity.sql` seeds one installation's owner —
// contradiction 4 in the plan's own read of the code. This file does not carry that person's name
// as a literal: `readEngineSeed` (imported from `./first-owner.js`, the ONE implementation of
// this reader — W8C-s7) reads the seed file's own `INSERT INTO users (...)` statement at run time
// and compares the register's one row against what that statement actually inserts. On this
// worktree that still resolves to the engine's real seed row (the file has not been swept yet —
// wave 9's job), which is exactly why `tests/doctor.test.ts`'s fixture using that same seed still
// matches: the check is reading the file, not a name written into this module.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import type { Queryable } from "./db.js";
import { readMigrations, planMigrations, looksAlreadyMigrated } from "./migration-runner.js";
import { listApplied, type AppliedMigration } from "./migration-ledger.js";
import { readEngineSeed } from "./first-owner.js";
import type { SettingReader } from "@lares/vault-format/settings";
import { settingByName } from "@lares/vault-format/settings";
import { checkSettings, type FileProbe, type ProbeFile } from "@lares/vault-format/settings-check";

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface CheckResult {
  readonly id: string; // "settings" | "database" | "migrations" | "owner" | "backup" | "repairs" | "gateway"
  readonly state: CheckState;
  readonly say: string; // one sentence saying what was found
  readonly fix: string | null; // paste-ready — a command, or an exact line for an exact file
}

export interface DoctorDeps {
  readonly db: Queryable | null; // null when the database could not be reached at all
  readonly env: NodeJS.ProcessEnv;
  readonly sqlDir: string;
  readonly now: Date;
  /** How to learn what is true of a `*_FILE` setting's file, without reading its bytes. Defaults
   *  to a real filesystem probe; a test injects its own. */
  readonly probeFile?: ProbeFile;
  /** W8A-s7: present ONLY when the caller asked for `--test-model` (owner decision A2 — a plain
   *  `lares doctor` makes no outside call at all). When set, the `gateway` check spends this one
   *  real, tiny completion to prove the key works; when absent, `gateway` stays `unknown` exactly
   *  as W8A-s6 left it, and this module makes no network call. `bin/doctor.ts` is the only place
   *  that ever constructs one, and only after `--gateway`/`--alias`/`--key-file` are all given. */
  readonly testModel?: ModelTestDeps;
}

/** The readers whose settings a database-owning installation needs — the three role readers each
 *  get their own startup guard (W8A-s4); this is what is left for the box/console side of one. */
const DOCTOR_READERS: readonly SettingReader[] = ["box", "console"];

/** A day, plus enough slack that a nightly job running a few hours late is not a false alarm. */
const BACKUP_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Postgres's `undefined_table` code: the table a check wants has not been migrated yet. */
function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/** The real filesystem probe used outside a test: reads no bytes, only three facts about a path. */
function realProbeFile(path: string): FileProbe {
  let exists = false;
  let readable = false;
  let empty = true;
  try {
    exists = existsSync(path);
    if (exists) {
      accessSync(path, constants.R_OK);
      readable = true;
      empty = statSync(path).size === 0;
    }
  } catch {
    // exists but unreadable, or a race between the two checks — either way, not usable.
  }
  return { exists, readable, empty };
}

function unreachableDatabaseFix(): string {
  return (
    "Check the database container's logs (`lares logs`, or your own compose command) and " +
    "confirm DATABASE_URL and DATABASE_PASSWORD_FILE are correct, then run `lares doctor` again."
  );
}

async function checkDatabase(db: Queryable | null): Promise<CheckResult> {
  if (db === null) {
    return {
      id: "database",
      state: "fail",
      say: "This installation's database could not be reached, so nothing else here could be checked either.",
      fix: unreachableDatabaseFix(),
    };
  }
  try {
    await db.query("SELECT 1");
    return { id: "database", state: "ok", say: "The database answers.", fix: null };
  } catch (err) {
    return {
      id: "database",
      state: "fail",
      say: `The database could not be reached: ${messageOf(err)}`,
      fix: unreachableDatabaseFix(),
    };
  }
}

function checkSettingsCheck(env: NodeJS.ProcessEnv, probeFile: ProbeFile): CheckResult {
  const problems = DOCTOR_READERS.flatMap((reader) => checkSettings(reader, env, probeFile));
  const lines = problems.map((p) => p.say);
  const names = problems.map((p) => p.name);

  // The one extra rule this check adds on top of `checkSettings`: `CONSOLE_ALLOWED_EMAILS` has a
  // fallback, so `requiredNamesFor` never reports it — but that fallback is one installation's own
  // address (services/console/lib/auth.ts:152), so an installation that left it unset would admit
  // a stranger to the console the moment it forgets to set `NODE_ENV=production`.
  if (isBlank(env.CONSOLE_ALLOWED_EMAILS)) {
    const def = settingByName("CONSOLE_ALLOWED_EMAILS");
    if (def) {
      lines.push(`  - \`CONSOLE_ALLOWED_EMAILS\` is not set. ${def.breaksWithout}`);
      names.push("CONSOLE_ALLOWED_EMAILS");
    }
  }

  if (lines.length === 0) {
    return { id: "settings", state: "ok", say: "Every setting this installation needs is set.", fix: null };
  }
  return {
    id: "settings",
    state: "fail",
    say: `${lines.length} setting${lines.length === 1 ? "" : "s"} ${lines.length === 1 ? "is" : "are"} missing or unusable: ${names.join(", ")}.`,
    fix: lines.join("\n"),
  };
}

async function checkMigrations(db: Queryable, sqlDir: string): Promise<CheckResult> {
  try {
    const files = readMigrations(sqlDir);
    let applied: AppliedMigration[];
    let ledgerMissing = false;
    try {
      applied = await listApplied(db);
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      // No ledger yet — read as "nothing applied", the same way a dry run does (migrate.ts's own
      // `ledgerFor`). Whether that means "fresh install" or "migrated by hand before the runner
      // existed" is exactly what `looksAlreadyMigrated` below is for.
      applied = [];
      ledgerMissing = true;
    }

    if (applied.length === 0 && ledgerMissing && (await looksAlreadyMigrated(db))) {
      return {
        id: "migrations",
        state: "fail",
        say: "This database already has tables but no migration ledger — it looks like it was set up by hand before the runner existed, not by this installer.",
        fix: "pnpm -C services/box migrate --adopt-through <the last filename you know was applied> --dry-run",
      };
    }

    const plan = planMigrations(files, applied);

    if (plan.refusals.length > 0) {
      const first = plan.refusals[0]!;
      return {
        id: "migrations",
        state: "fail",
        say: `A migration cannot be applied safely: ${first.reason}`,
        fix: "Resolve that file by hand, then run `pnpm -C services/box migrate --dry-run` to see the plan again.",
      };
    }

    const toApply = plan.steps.filter((step) => step.action === "apply").length;
    if (toApply === 0) {
      return { id: "migrations", state: "ok", say: "Every migration on disk has already been applied.", fix: null };
    }
    return {
      id: "migrations",
      state: "warn",
      say: `${toApply} migration${toApply === 1 ? "" : "s"} on disk ${toApply === 1 ? "has" : "have"} not been applied yet.`,
      fix: "pnpm -C services/box migrate",
    };
  } catch (err) {
    return {
      id: "migrations",
      state: "unknown",
      say: `The migrations could not be checked: ${messageOf(err)}`,
      fix: "Apply `pnpm -C services/box migrate` first, then run `lares doctor` again.",
    };
  }
}

async function checkOwner(db: Queryable, sqlDir: string): Promise<CheckResult> {
  try {
    const { rows } = await db.query<{ id: string; display_name: string; primary_email: string | null }>(
      "SELECT id, display_name, primary_email FROM users",
    );

    if (rows.length === 0) {
      return {
        id: "owner",
        state: "fail",
        say: "This installation has no owner in the identity register yet.",
        fix: "lares first-owner",
      };
    }

    if (rows.length === 1) {
      const row = rows[0]!;
      const seed = readEngineSeed(sqlDir);
      if (seed && row.id === seed.id && row.primary_email === seed.email) {
        return {
          id: "owner",
          state: "fail",
          say: "The only member in the identity register is left over from the engine's own seed row, not a real person on this installation.",
          fix: "lares first-owner",
        };
      }
      return { id: "owner", state: "ok", say: "This installation has one registered owner.", fix: null };
    }

    return {
      id: "owner",
      state: "warn",
      say: `${rows.length} people are in the identity register; installations with more than one member are not fully supported yet.`,
      fix: null,
    };
  } catch (err) {
    return {
      id: "owner",
      state: "unknown",
      say: isMissingTable(err)
        ? "The identity register has not been created yet."
        : `The identity register could not be checked: ${messageOf(err)}`,
      fix: "pnpm -C services/box migrate",
    };
  }
}

function isStale(checkedAt: string | Date | null, now: Date): boolean {
  if (checkedAt === null) return true;
  const at = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  if (Number.isNaN(at.getTime())) return true;
  return now.getTime() - at.getTime() > BACKUP_STALE_AFTER_MS;
}

async function checkBackup(db: Queryable, now: Date): Promise<CheckResult> {
  try {
    const { rows } = await db.query<{
      check_name: string;
      ok: boolean | null;
      checked_at: string | Date | null;
      last_pass_at: string | Date | null;
      detail: string | null;
      target: string | null;
    }>("SELECT check_name, ok, checked_at, last_pass_at, detail, target FROM backup_status");

    const verify = rows.find((r) => r.check_name === "verify");
    if (!verify || (verify.ok === null && verify.checked_at === null)) {
      return {
        id: "backup",
        state: "warn",
        say: "The nightly backup has never been verified — no successful or failed check has ever been recorded.",
        fix: "Run `services/box/ops/backup-verify.sh` by hand once, then check again after tonight's scheduled run.",
      };
    }
    if (verify.ok === false) {
      return {
        id: "backup",
        state: "fail",
        say: `The last backup verification failed${verify.detail ? `: ${verify.detail}` : "."}`,
        fix: "Run `services/box/ops/backup-verify.sh` by hand and read what it says, then fix the underlying backup before trusting one again.",
      };
    }
    if (isStale(verify.checked_at, now)) {
      return {
        id: "backup",
        state: "warn",
        say: "The last successful backup verification is more than a day old.",
        fix: "Check that the timer is still active: `systemctl status agent-box-backup-verify.timer`.",
      };
    }
    return { id: "backup", state: "ok", say: "The last backup was verified.", fix: null };
  } catch (err) {
    return {
      id: "backup",
      state: "unknown",
      say: isMissingTable(err)
        ? "The backup status table has not been created yet."
        : `The backup status could not be checked: ${messageOf(err)}`,
      fix: "pnpm -C services/box migrate",
    };
  }
}

async function checkRepairs(db: Queryable): Promise<CheckResult> {
  try {
    const { rows } = await db.query<{
      kind: string;
      ref: string;
      severity: "info" | "warn" | "error";
      what: string;
      how_to_fix: string | null;
      breaks_in: string | null;
    }>("SELECT kind, ref, severity, what, how_to_fix, breaks_in FROM repairs WHERE resolved_at IS NULL");

    if (rows.length === 0) {
      return { id: "repairs", state: "ok", say: "No open repairs.", fix: null };
    }
    const state: CheckState = rows.some((r) => r.severity === "error") ? "fail" : "warn";
    const fixes = rows.map((r) => r.how_to_fix).filter((f): f is string => Boolean(f));
    return {
      id: "repairs",
      state,
      say: rows.map((r) => r.what).join(" "),
      fix: fixes.length > 0 ? fixes.join("\n") : null,
    };
  } catch (err) {
    return {
      id: "repairs",
      state: "unknown",
      say: isMissingTable(err)
        ? "The repairs table has not been created yet."
        : `Open repairs could not be checked: ${messageOf(err)}`,
      fix: "pnpm -C services/box migrate",
    };
  }
}

// ── W8A-s7: `lares doctor --test-model` — one real completion ─────────────────────────────
//
// Owner decision A2: `lares doctor` never calls the model gateway unless asked. This is the one
// call this file is allowed to make, and it exists ONLY because `bin/doctor.ts`'s `--test-model`
// flag constructed a `ModelTestDeps` and put it on `DoctorDeps.testModel` — nothing in this
// module has a default gateway URL, alias or key of its own; every one of them is a caller-
// supplied string, matching the installation's own settings (`GATEWAY_URL`, an owner-chosen model
// alias, `GATEWAY_KEY_FILE`'s contents).
//
// FAIL-SAFE BY CONSTRUCTION. `readModelTestResult` is PURE — no fetch, no clock, no I/O — from a
// (status, body) pair to a verdict. Every branch it does not explicitly recognise falls through
// to `unreadable`, "the gateway answered, but not with a completion" — never `ok`. Four response
// shapes. THREE OF THE FOUR WERE MEASURED ON 2026-09-21 by `tests/live/gateway-completion.live.mts`
// against a real LiteLLM v1.99.1, and one of them was WRONG — the run is recorded in that file's
// own LAST RUN note:
//   1. a budget refusal's envelope — `error.type === "budget_exceeded"`, on EITHER HTTP status
//      LiteLLM is known to have used (400 measured 2026-09-01, 429 read from its source
//      2026-09-18) — `packages/agent-kit/src/gateway-budget.ts`. STILL ASSUMED HERE; its own
//      probe (`packages/agent-kit/tests/live/litellm-budget-refusal.live.mts`) owns that shape.
//   2. a wrong key. MEASURED: HTTP **401**, envelope `{error:{message,type,param,code}}`. Correct.
//   3. an unknown model alias. ASSUMED a bare 404 or a 4xx naming "model" + "not found"/"unknown".
//      **WRONG.** MEASURED: HTTP **403**, `error.type = "key_model_access_denied"`,
//      `error.param = "model"` — which the 401/403 branch then read as a WRONG KEY. A mistyped
//      alias at install time therefore told the owner to replace a perfectly good key. The order
//      of the branches below was changed for this reason; do not put the status-only auth check
//      back in front of the model check.
//   4. a completion. MEASURED: HTTP 200, envelope keys
//      `model,id,type,role,content,container,stop_reason,stop_sequence,stop_details,usage` —
//      `content` present, so `looksLikeCompletion` holds. Correct.
// This also settles the question the whole gateway design rested on: a request in ANTHROPIC format
// to `/v1/messages` DOES resolve a LiteLLM `model_group_alias` and come back with a real completion.
// `tests/live/gateway-completion.live.mts` (W8A-s7b) stays the acceptance bar — this file's
// comments are not. Re-run it whenever LiteLLM is upgraded.
//
// NEVER THE KEY, NEVER THE BODY. The key is sent only as the `x-api-key` request header; it is
// never interpolated into a `say`, an error, or a log line. Every `say` below is a FIXED sentence
// per verdict — the gateway's own response text is read only to CLASSIFY it, never echoed back —
// so a body that happens to carry something sensitive (a stack trace, a misrouted secret) can
// never leak through a diagnostic. Same rule `gateway-budget.ts` follows, for the same reason.
export type ModelTestVerdict =
  | "ok"
  | "unauthorised"
  | "no-such-model"
  | "over-budget"
  | "unreachable"
  | "unreadable";

interface ModelTestReading {
  readonly verdict: ModelTestVerdict;
  readonly say: string;
}

const MODEL_TEST_SAY: Record<ModelTestVerdict, string> = {
  ok: "The gateway answered with a real completion.",
  unauthorised:
    "The gateway rejected the key. Fix: check the value in the file named by GATEWAY_KEY_FILE — it may be missing, stale, or issued for a different installation.",
  "no-such-model":
    "The gateway would not use the model alias that was tested \u2014 either it is not registered there, or this gateway key is not allowed to use it. This is NOT a problem with the key itself. Fix: confirm the alias name this installation is configured to use (LARES_MODEL_ALIAS), and that the gateway key is allowed to reach that alias.",
  "over-budget":
    "The gateway refused the call: this key has hit its spending cap. This is a spending limit, not a fault — it resets with the next budget period, or the cap can be raised on the gateway.",
  unreachable:
    "The gateway could not be reached. Fix: confirm GATEWAY_URL is correct and that the gateway is running and reachable from this machine.",
  unreadable: "The gateway answered, but not with a completion.",
};

const MODEL_TEST_TIMEOUT_SAY =
  "The gateway did not answer within the timeout. Fix: confirm GATEWAY_URL is correct and that the gateway is reachable from this machine.";

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads `error.<key>` off a parsed body, as a structural field — never a substring match. */
function errorField(body: unknown, key: string): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const err = body["error"];
  if (!isPlainObject(err)) return undefined;
  const value = err[key];
  return typeof value === "string" ? value : undefined;
}

/** The Anthropic Messages response shape: a `content` array of typed blocks. */
function looksLikeCompletion(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const content = body["content"];
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => isPlainObject(block) && typeof block["type"] === "string");
}

/** PURE. Given what the gateway answered, what does it mean? Never fetches, never throws, never
 *  reads a clock. See this section's header for the four shapes assumed and why each branch not
 *  recognised here falls through to `unreadable` rather than `ok`. */
export function readModelTestResult(status: number, body: string): ModelTestReading {
  const parsed = tryParseJson(body);

  // 1. Budget refusal — checked first, regardless of status: gateway-budget.ts reads the type as
  //    the primary signal and the status only as a plausibility check; this module does the same.
  if (errorField(parsed, "type") === "budget_exceeded") {
    return { verdict: "over-budget", say: MODEL_TEST_SAY["over-budget"] };
  }

  // 2. THE MODEL, NOT THE KEY — and this one is checked BEFORE the wrong-key branch below,
  //    because the gateway answers it with a status that reads like an auth failure.
  //    MEASURED 2026-09-21 against a real LiteLLM (v1.99.1), by
  //    `../tests/live/gateway-completion.live.mts`: asking for an alias the key may not use
  //    answers **HTTP 403** with `error.type = "key_model_access_denied"`, `error.code = "403"`,
  //    `error.param = "model"`. The 404 this module originally assumed never came.
  //    WHY THE ORDER MATTERS: read as a 403 alone, a mistyped LARES_MODEL_ALIAS at install time
  //    told the owner their model key was rejected. They would then replace a perfectly good key
  //    and still fail. The gateway is refusing the MODEL; say so.
  //    Both meanings land here on purpose — an alias that is not registered at all, and one this
  //    key is not allowed to reach — because the owner's next move ("check the alias, and check
  //    the key may use it") is the same for both, and the gateway does not always distinguish
  //    them. Only the second was measured; a gateway whose keys carry no model allow-list may
  //    answer the first differently, which is why the message test below is kept as well.
  const errorType = errorField(parsed, "type");
  const message = errorField(parsed, "message");
  const messageNamesUnknownModel =
    message !== undefined && /model/i.test(message) && /not found|unknown/i.test(message);
  if (
    errorType === "key_model_access_denied" ||
    (status === 403 && errorField(parsed, "param") === "model") ||
    status === 404 ||
    messageNamesUnknownModel
  ) {
    return { verdict: "no-such-model", say: MODEL_TEST_SAY["no-such-model"] };
  }

  // 3. Wrong key. MEASURED 2026-09-21: a key the gateway does not know answers **HTTP 401**
  //    with an `error` envelope of `{message, type, param, code}`.
  if (status === 401 || status === 403) {
    return { verdict: "unauthorised", say: MODEL_TEST_SAY.unauthorised };
  }

  // 4. A real completion — only a 2xx AND a body shaped like one. Anything else (a 5xx, a 2xx
  //    with the wrong shape, a body that fails to parse) falls through below.
  if (status >= 200 && status < 300 && looksLikeCompletion(parsed)) {
    return { verdict: "ok", say: MODEL_TEST_SAY.ok };
  }

  // Fail-safe: an unrecognised shape is a FAIL, never a PASS.
  return { verdict: "unreadable", say: MODEL_TEST_SAY.unreadable };
}

export interface ModelTestDeps {
  readonly gatewayUrl: string;
  readonly key: string; // never logged, never returned
  readonly alias: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** 16 output tokens, one short user message — the smallest request that still proves the key and
 *  alias both work. */
const MODEL_TEST_MAX_TOKENS = 16;
const MODEL_TEST_PROMPT = "Reply with the single word: ok";
const MODEL_TEST_DEFAULT_TIMEOUT_MS = 20_000;
/** Read at most this many characters of the body before classifying — enough to recognise every
 *  shape above, never the whole thing. */
const MODEL_TEST_BODY_READ_LIMIT = 2048;

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * The one real, paid call `lares doctor --test-model` makes (owner decision A2). Smallest
 * possible request, to the gateway's router route (`/v1/messages`, Anthropic request shape —
 * `packages/agent-kit/src/gateway-provider.ts`), with the key sent only as `x-api-key` and never
 * elsewhere. A hard timeout (`AbortSignal.timeout`, injected via `timeoutMs` so tests never wait
 * for a real hang) turns a dead hop into the `unreachable` verdict instead of hanging forever;
 * `redirect: "error"` refuses to silently follow a redirect to somewhere else entirely. Never
 * throws — every failure, network-level or in the response, resolves to a verdict.
 */
export async function testModel(deps: ModelTestDeps): Promise<ModelTestReading> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? MODEL_TEST_DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await doFetch(`${deps.gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.key,
        "anthropic-version": "2023-06-01",
        // packages/agent-kit/src/gateway-provider.ts's IDENTITY_ENCODING_HEADERS: load-bearing
        // history on the router route's predecessor: kept here for the same reason it is kept
        // there, even though the router route does not carry that old defect.
        "Accept-Encoding": "identity",
      },
      body: JSON.stringify({
        model: deps.alias,
        max_tokens: MODEL_TEST_MAX_TOKENS,
        messages: [{ role: "user", content: MODEL_TEST_PROMPT }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    return {
      verdict: "unreachable",
      say: isTimeout(err) ? MODEL_TEST_TIMEOUT_SAY : MODEL_TEST_SAY.unreachable,
    };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { verdict: "unreadable", say: MODEL_TEST_SAY.unreadable };
  }
  const body = raw.length > MODEL_TEST_BODY_READ_LIMIT ? raw.slice(0, MODEL_TEST_BODY_READ_LIMIT) : raw;
  return readModelTestResult(response.status, body);
}

const MODEL_TEST_FIX: Record<ModelTestVerdict, string | null> = {
  ok: null,
  unauthorised: "GATEWAY_KEY_FILE",
  "no-such-model": "Confirm this installation's chosen model alias against the gateway's own configuration.",
  "over-budget": "Wait for the next budget period, or raise this key's spending cap on the gateway.",
  unreachable: "GATEWAY_URL",
  unreadable: "Run `lares doctor --test-model` again in a moment; if it keeps happening, check the gateway's own logs.",
};

const MODEL_TEST_STATE: Record<ModelTestVerdict, CheckState> = {
  ok: "ok",
  unauthorised: "fail",
  "no-such-model": "fail",
  "over-budget": "warn", // a spending cap is not a fault — see MODEL_TEST_SAY["over-budget"].
  unreachable: "fail",
  unreadable: "fail",
};

async function checkGateway(testModelDeps: ModelTestDeps | undefined): Promise<CheckResult> {
  if (testModelDeps === undefined) {
    return {
      id: "gateway",
      state: "unknown",
      say: "The model connection has not been tested — this command makes no outside call unless you ask it to.",
      fix: "lares doctor --test-model",
    };
  }
  const { verdict, say } = await testModel(testModelDeps);
  return { id: "gateway", state: MODEL_TEST_STATE[verdict], say, fix: MODEL_TEST_FIX[verdict] };
}

function unknownBecauseNoDatabase(id: string): CheckResult {
  return {
    id,
    state: "unknown",
    say: "This could not be checked because the database is unreachable.",
    fix: null,
  };
}

/** Runs every check and returns all seven, in a fixed order. Never throws: every check catches
 *  its own failure and reports it as a finding. */
export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const probeFile = deps.probeFile ?? realProbeFile;
  const db = deps.db;

  const settings = checkSettingsCheck(deps.env, probeFile);
  const database = await checkDatabase(db);
  const migrations = db ? await checkMigrations(db, deps.sqlDir) : unknownBecauseNoDatabase("migrations");
  const owner = db ? await checkOwner(db, deps.sqlDir) : unknownBecauseNoDatabase("owner");
  const backup = db ? await checkBackup(db, deps.now) : unknownBecauseNoDatabase("backup");
  const repairs = db ? await checkRepairs(db) : unknownBecauseNoDatabase("repairs");
  const gateway = await checkGateway(deps.testModel);

  return [settings, database, migrations, owner, backup, repairs, gateway];
}

const CHECK_NAME: Record<string, string> = {
  settings: "Settings",
  database: "Database connection",
  migrations: "Database migrations",
  owner: "Installation owner",
  backup: "Backups",
  repairs: "Known issues",
  gateway: "Model connection",
};

const STATE_LABEL: Record<CheckState, string> = {
  fail: "FAIL",
  warn: "WARN",
  unknown: "UNKNOWN",
  ok: "PASS",
};

const STATE_ORDER: Record<CheckState, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };

/** One page, FAILs first. Never a stack trace: every `say`/`fix` above is a fixed or lightly
 *  interpolated sentence, and `messageOf` only ever surfaces an `Error#message`, never `#stack`. */
export function doctorReport(results: readonly CheckResult[]): string {
  const sorted = [...results].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const lines: string[] = [];
  for (const r of sorted) {
    const name = CHECK_NAME[r.id] ?? r.id;
    lines.push(`${STATE_LABEL[r.state]}  ${name} — ${r.say}`);
    if (r.fix) for (const fixLine of r.fix.split("\n")) lines.push(`    ${fixLine}`);
  }
  const fails = results.filter((r) => r.state === "fail").length;
  lines.push("");
  lines.push(
    fails > 0
      ? `${fails} thing${fails === 1 ? "" : "s"} need${fails === 1 ? "s" : ""} fixing before this installation is ready.`
      : "Nothing failed.",
  );
  return lines.join("\n");
}

/** 0 when nothing failed (a WARN alone is still 0) · 1 when at least one check failed. */
export function doctorExitCode(results: readonly CheckResult[]): 0 | 1 {
  return results.some((r) => r.state === "fail") ? 1 : 0;
}
