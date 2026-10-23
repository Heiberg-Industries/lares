/** Hand-run native probe. The image harness also runs this exact contract against its
 * explicitly disposable, digest-pinned fixture. It never targets CI or production
 * implicitly and never runs as part of `pnpm test`.
 *
 * Native LiteLLM member/key contract discovery against an explicitly disposable target.
 * This probe creates random team/user/key records and deletes them in `finally`. It never
 * calls a completion, embedding, model-health, or provider route. Its only model-facing
 * request is GET /v1/models, used to compare native authentication before/after blocking.
 *
 * Required environment:
 *   LARES_DISPOSABLE_GATEWAY=1  explicit confirmation that the target is disposable
 *   GATEWAY_URL                 origin only, for example http://127.0.0.1:4000
 *   GATEWAY_MASTER_KEY_FILE     protected regular file containing the admin key
 *   GATEWAY_PROBE_MODEL         one neutral model alias configured on that fixture
 *
 * Run: pnpm -C services/keeper exec tsx tests/live/litellm-member-credential.live.mts
 * Output contains only fixed case names and outcomes; request bodies, keys, hashes, ids,
 * response bodies and transport errors are never printed.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BudgetNativeCredentialClient, consumeNativeHashAbsenceReceipt } from "../../lib/budget-native-client.js";

const CASES = [
  "fixture-guard",
  "member-create-without-key",
  "client-existing-team-before-membership",
  "client-empty-team-roster",
  "client-first-member-roster",
  "client-user-policy-readback",
  "user-current-identity-global-cap-and-role",
  "user-info-no-auto-key",
  "user-info-absent-is-not-refusal",
  "user-info-refused-is-not-absence",
  "lost-user-create-response-reconciles-original-id",
  "team-membership-and-caps",
  "client-empty-key-inventory",
  "caller-key-exact-and-hash-lookup",
  "client-populated-key-inventory",
  "hash-lookup-absent-is-not-error",
  "client-hash-only-absence-receipt",
  "hash-lookup-refused-is-not-absence",
  "duplicate-key-create-does-not-overwrite",
  "atomic-blocked-create",
  "blocked-key-readback-and-native-auth",
  "client-blocked-key-policy-readback",
  "client-unblock-and-exact-unblocked-readback",
  "unblocked-key-readback-and-native-auth",
  "lost-create-response-reconciles-by-hash",
  "lost-client-blocked-create-response-reconciles-original-key",
  "block-unblock-readback-only",
  "delete-by-hash-and-reconcile-lost-response",
  "already-deleted-remains-absent",
  "client-team-duration-and-membership-policy",
  "client-full-team-roster",
  "fixture-cleanup",
] as const;
type CaseName = typeof CASES[number];
type Outcome = "PASS" | "FAIL" | "UNKNOWN" | "UNSUPPORTED";
const DIAGNOSTIC_NAMES = [
  "normal-key-policy-exact", "normal-key-blocked-false",
  "member-match-unique", "budget-cap-exact", "budget-duration-exact", "models-exact",
  "team-blocked-false", "team-metadata-empty", "member-role-exact",
  "duplicate-inventory-readable", "duplicate-inventory-exact",
] as const;
type DiagnosticName = typeof DIAGNOSTIC_NAMES[number];
const MAX_PROBE_REQUEST_BYTES = 65_536;

const outcomes = new Map<CaseName, Outcome>();
const diagnostics = new Map<DiagnosticName, "false" | "unknown">();
let failed = false;
const mark = (name: CaseName, outcome: Outcome) => {
  outcomes.set(name, outcome);
  if (outcome !== "PASS") failed = true;
};
const mismatch = (name: DiagnosticName, actual: boolean | undefined) => {
  if (DIAGNOSTIC_NAMES.includes(name) && actual !== true) diagnostics.set(name, actual === false ? "false" : "unknown");
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const empty = (value: unknown) => value === undefined || value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (object(value) && Object.keys(value).length === 0);

type RosterObservation = Record<string, unknown>;
let rosterCapture: { state: "empty" | "first" | "full"; teamId: string; expectedIds: readonly string[]; observation?: RosterObservation } | undefined;
const rosterObservations: RosterObservation[] = [];
const MAX_ROSTER_OBSERVATION_BYTES = 65_536;
const rosterIdShape = (rows: unknown[], field: string) => {
  const counts = {missing: 0, null: 0, empty: 0, invalid: 0};
  for (const value of rows) {
    const id = object(value) ? value[field] : undefined;
    if (id === undefined) counts.missing++;
    else if (id === null) counts.null++;
    else if (typeof id !== "string") counts.invalid++;
    else if (id.length === 0) counts.empty++;
    else if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) counts.invalid++;
  }
  return counts;
};
const cappedCount = (value: unknown): number => Array.isArray(value) ? Math.min(value.length, 129) : 0;
async function inspectRosterResponse(response: Response, state: "empty" | "first" | "full", teamId: string,
  expectedIds: readonly string[]): Promise<RosterObservation> {
  const unavailable: RosterObservation = {state, capture: "unavailable"};
  try {
    if (!response.body) return unavailable;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_ROSTER_OBSERVATION_BYTES) { void reader.cancel().catch(() => {}); return unavailable; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const rootValue: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    const root = object(rootValue) ? rootValue : {};
    const team = object(root.team_info) ? root.team_info : undefined;
    const roleRows = team && Array.isArray(team.members_with_roles) ? team.members_with_roles : undefined;
    const membershipRows = Array.isArray(root.team_memberships) ? root.team_memberships : undefined;
    const roles = roleRows ? roleRows.slice(0, 129) : [];
    const memberships = membershipRows ? membershipRows.slice(0, 129) : [];
    const ids = new Set(expectedIds);
    const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9-]{1,80}$/.test(value);
    const roleIds = roles.map(row => object(row) ? row.user_id : undefined);
    const membershipIds = memberships.map(row => object(row) ? row.user_id : undefined);
    const duplicate = (values: unknown[]) => {
      const seen = new Set<string>();
      for (const value of values) if (validId(value)) { if (seen.has(value)) return true; seen.add(value); }
      return false;
    };
    const budgets = memberships.map(row => object(row) ? row.litellm_budget_table : undefined);
    const budgetShape = {missing: 0, null: 0, nonObject: 0, numeric: 0, durationString: 0, modelsArray: 0};
    for (const budget of budgets) {
      if (budget === undefined) budgetShape.missing++;
      else if (budget === null) budgetShape.null++;
      else if (!object(budget)) budgetShape.nonObject++;
      else {
        if (typeof budget.max_budget === "number" && Number.isFinite(budget.max_budget)) budgetShape.numeric++;
        if (typeof budget.budget_duration === "string") budgetShape.durationString++;
        if (Array.isArray(budget.allowed_models)) budgetShape.modelsArray++;
      }
    }
    return {
      state, capture: "ok", teamObject: !!team, roleArray: !!roleRows, membershipArray: !!membershipRows,
      roleCount: cappedCount(roleRows), membershipCount: cappedCount(membershipRows),
      roleOverflow: !!roleRows && roleRows.length > 128, membershipOverflow: !!membershipRows && membershipRows.length > 128,
      teamIdShape: rosterIdShape([team ?? {}], "team_id"), teamIdMatchesExpected: !!team && team.team_id === teamId,
      roleUserIdShape: rosterIdShape(roles, "user_id"), roleDuplicateIds: duplicate(roleIds),
      roleUnexpectedRows: roleIds.filter(id => validId(id) && !ids.has(id)).length,
      membershipUserIdShape: rosterIdShape(memberships, "user_id"), membershipTeamIdShape: rosterIdShape(memberships, "team_id"),
      membershipDuplicateUserIds: duplicate(membershipIds),
      membershipWrongTeamRows: memberships.filter(row => object(row) && validId(row.team_id) && row.team_id !== teamId).length,
      membershipUnexpectedRows: membershipIds.filter(id => validId(id) && !ids.has(id)).length,
      budgetShape,
    };
  } catch { return unavailable; }
}

type Reply = { status: number; body: unknown; parsed: boolean; dropped?: boolean };
type Lookup = { kind: "present"; row: Record<string, unknown> } | { kind: "absent" | "malformed" | "refused" | "unavailable" };
const MAX_PROBE_RESPONSE_BYTES = 65_536;

const urlValue = process.env.GATEWAY_URL;
const keyFile = process.env.GATEWAY_MASTER_KEY_FILE;
const model = process.env.GATEWAY_PROBE_MODEL;
const explicit = process.env.LARES_DISPOSABLE_GATEWAY === "1";
const ciBarrier = process.env.CI === "true" && process.env.LARES_PROBE_CI_BARRIER === "1";
const barrierFile = process.env.GATEWAY_PROBE_CI_BARRIER_FILE;
const expectedFile = process.env.GATEWAY_PROBE_CI_EXPECTED_FILE;
let origin: string | undefined;
let master: string | undefined;
let diagnosticCode: "members-barrier-write-failed" | "members-expected-write-failed" |
  "key-barrier-write-failed" | "key-expected-write-failed" | "barrier-ack-timeout" |
  "fixture-guard-failed" | "unexpected-probe-failure" | undefined;

function writeCiFile(file: string, contents: string, reason: "members-barrier-write-failed" | "members-expected-write-failed" | "key-barrier-write-failed" | "key-expected-write-failed"): void {
  let descriptor: number | undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("unsafe fixture file");
    descriptor = openSync(file, "r+");
    ftruncateSync(descriptor, 0);
    const data = Buffer.from(contents, "utf8");
    if (writeSync(descriptor, data) !== data.byteLength) throw new Error("short fixture write");
  } catch {
    diagnosticCode = reason;
    throw new Error("fixture coordination write failed");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { diagnosticCode = reason; throw new Error("fixture coordination close failed"); }
    }
  }
}

function setup(): boolean {
  try {
    if (!explicit || !urlValue || !keyFile || !model || !/^[A-Za-z0-9_.:-]{1,160}$/.test(model)) {
      diagnosticCode = "fixture-guard-failed";
      return false;
    }
    if ((process.env.LARES_PROBE_CI_BARRIER === "1" || barrierFile || expectedFile) &&
        (!ciBarrier || barrierFile !== "/run/lares-native-probe-barrier" || expectedFile !== "/run/lares-native-probe-expected")) {
      diagnosticCode = "fixture-guard-failed";
      return false;
    }
    const url = new URL(urlValue);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      diagnosticCode = "fixture-guard-failed";
      return false;
    }
    const stat = lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      diagnosticCode = "fixture-guard-failed";
      return false;
    }
    const candidate = readFileSync(keyFile, "utf8").trimEnd();
    if (!candidate.startsWith("sk-") || candidate.length < 16) {
      diagnosticCode = "fixture-guard-failed";
      return false;
    }
    origin = url.origin;
    master = candidate;
    return true;
  } catch {
    diagnosticCode = "fixture-guard-failed";
    return false;
  }
}

async function waitForCiAcknowledgement(phase: "members-checked" | "key-checked"): Promise<void> {
  if (!ciBarrier || !barrierFile) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if (readFileSync(barrierFile, "utf8") === phase) return; } catch { /* fixed timeout below */ }
    await delay(50);
  }
  diagnosticCode = "barrier-ack-timeout";
  throw new Error("fixture barrier timeout");
}

const allowedRoutes = new Map<string, "GET" | "POST">([
  ["/team/new", "POST"], ["/team/delete", "POST"],
  ["/team/info", "GET"], ["/key/list", "GET"], ["/user/info", "GET"],
  ["/user/new", "POST"], ["/user/delete", "POST"],
  ["/team/member_add", "POST"], ["/key/generate", "POST"],
  ["/v2/key/info", "POST"], ["/key/block", "POST"], ["/key/unblock", "POST"],
  ["/key/delete", "POST"], ["/v1/models", "GET"],
]);

async function call(method: "GET" | "POST", path: string, body?: unknown, auth = master, dropReply = false): Promise<Reply | undefined> {
  const route = path.split("?", 1)[0];
  if (!origin || !auth || allowedRoutes.get(route) !== method) return undefined;
  const queryText = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  if (queryText) {
    const params = new URLSearchParams(queryText);
    const expectedName = route === "/team/info" ? "team_id" : ["/key/list", "/user/info"].includes(route ?? "") ? "user_id" : "";
    if (!expectedName || [...params.keys()].length !== 1 || !params.has(expectedName) ||
        !/^[A-Za-z0-9-]{1,80}$/.test(params.get(expectedName) ?? "")) return undefined;
  } else if (path.includes("?")) return undefined;
  const requestBody = method === "POST" ? JSON.stringify(body) : undefined;
  if (requestBody !== undefined && Buffer.byteLength(requestBody) > MAX_PROBE_REQUEST_BYTES) return undefined;
  try {
    const response = await fetch(new URL(path, origin), {
      method, redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${auth}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(requestBody === undefined ? {} : { body: requestBody }),
    });
    if (dropReply) {
      await response.body?.cancel();
      return { status: response.status, body: undefined, parsed: false, dropped: true };
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, body: undefined, parsed: false };
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_PROBE_RESPONSE_BYTES) {
        await reader.cancel();
        return { status: response.status, body: undefined, parsed: false };
      }
      chunks.push(next.value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    try { return { status: response.status, body: JSON.parse(raw), parsed: true }; }
    catch { return { status: response.status, body: undefined, parsed: false }; }
  } catch {
    return undefined;
  }
}

async function drainBoundedBody(response: Response, retainBody = true): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_PROBE_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      if (retainBody) chunks.push(next.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* stream may already be canceled */ }
  }
  if (!retainBody) return new Uint8Array();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function observeResponse(response: Response): Promise<{ reply: Reply; replay: Response }> {
  let bytes: Uint8Array | undefined;
  try { bytes = await drainBoundedBody(response); }
  catch { bytes = undefined; }
  const raw = bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
  let reply: Reply = { status: response.status, body: undefined, parsed: false };
  if (raw !== undefined) {
    try { reply = { status: response.status, body: JSON.parse(raw), parsed: true }; }
    catch { /* retain fixed malformed result */ }
  }
  // Give the actual client the bounded bytes from this same response. An oversized or
  // unreadable body becomes empty so its normal response validation returns uncertain.
  let replayBody: ArrayBuffer | null = null;
  if (bytes !== undefined && bytes.byteLength > 0) {
    replayBody = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(replayBody).set(bytes);
  }
  const replay = new Response(replayBody, { status: response.status, statusText: response.statusText, headers: response.headers });
  return { reply, replay };
}

function classifyLookup(reply: Reply | undefined, hash: string): Lookup {
  if (!reply) return { kind: "unavailable" };
  if (reply.status === 401 || reply.status === 403) return { kind: "refused" };
  if (reply.status !== 200) return { kind: "unavailable" };
  if (!reply.parsed || !object(reply.body) || !Array.isArray(reply.body.key) ||
      reply.body.key.length !== 1 || reply.body.key[0] !== hash || !Array.isArray(reply.body.info))
    return { kind: "malformed" };
  if (reply.body.info.length === 0) return { kind: "absent" };
  if (reply.body.info.length !== 1 || !object(reply.body.info[0])) return { kind: "malformed" };
  const row = reply.body.info[0];
  if ("token" in row) return { kind: "malformed" };
  return { kind: "present", row };
}

/** Pinned source: https://github.com/BerriAI/litellm/blob/v1.101.6/litellm/proxy/management_endpoints/internal_user_endpoints.py
 * user_info returns the current user row. Only its exact structured missing-user error is absence. */
export function classifyUserLookup(reply: Reply | undefined, userId: string): Lookup {
  if (!reply) return { kind: "unavailable" };
  if (reply.status === 401 || reply.status === 403) return { kind: "refused" };
  if (reply.status === 404) {
    return reply.parsed && object(reply.body) && object(reply.body.error) &&
      reply.body.error.message === `User ${userId} not found` &&
      (reply.body.error.code === 404 || reply.body.error.code === "404")
      ? { kind: "absent" } : { kind: "malformed" };
  }
  if (reply.status !== 200) return { kind: "unavailable" };
  if (!reply.parsed || !object(reply.body) || reply.body.user_id !== userId ||
      !object(reply.body.user_info) || reply.body.user_info.user_id !== userId ||
      !Array.isArray(reply.body.keys) || !Array.isArray(reply.body.teams)) return { kind: "malformed" };
  return { kind: "present", row: reply.body.user_info };
}
const userLookup = (userId: string, auth = master) => call("GET", `/user/info?user_id=${userId}`, undefined, auth);
export function exactUserPolicy(lookup: Lookup, userId: string, budget: number): boolean {
  return lookup.kind === "present" && lookup.row.user_id === userId && lookup.row.max_budget === budget &&
    lookup.row.user_role === "internal_user";
}

/** Disposable probe evidence only: preserve the chosen identity before the lost-reply
 * experiment. No production custody or retry/adoption behaviour is implemented here. */
function persistProbeUserId(directory: string): string {
  const fd = openSync(join(directory, "original-user-id"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(`probe-${randomUUID()}`);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error("fixture identity write failed");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return readProbeUserId(directory);
}
function readProbeUserId(directory: string): string {
  const fd = openSync(join(directory, "original-user-id"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size !== 42) throw new Error("fixture identity unavailable");
    const userId = readFileSync(fd, "utf8");
    if (!/^probe-[a-f0-9-]{36}$/.test(userId)) throw new Error("fixture identity unavailable");
    return userId;
  } finally { closeSync(fd); }
}

function persistProbeKey(directory: string, key: string): string {
  const fd = openSync(join(directory, "original-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(key);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error("fixture key write failed");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return readProbeKey(directory);
}
function readProbeKey(directory: string): string {
  const fd = openSync(join(directory, "original-key"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size < 19 || stat.size > 259)
      throw new Error("fixture key unavailable");
    const key = readFileSync(fd, "utf8");
    if (!/^sk-[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error("fixture key unavailable");
    return key;
  } finally { closeSync(fd); }
}

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
const randomKey = () => `sk-${randomBytes(32).toString("base64url")}`;
const hashLookup = (hash: string, auth = master) => call("POST", "/v2/key/info", { keys: [hash] }, auth);

function exactKeyPolicy(row: Record<string, unknown>, expected: { keyAlias: string; teamId: string; userId: string; budget: number }): boolean {
  return row.key_alias === expected.keyAlias && row.key_type === "llm_api" &&
    row.user_id === expected.userId && row.team_id === expected.teamId &&
    row.max_budget === expected.budget && row.budget_duration === "1d" &&
    Array.isArray(row.models) && row.models.length === 1 && row.models[0] === model &&
    empty(row.metadata) && empty(row.config) &&
    empty(row.permissions) && empty(row.aliases) && empty(row.router_settings) &&
    empty(row.budget_fallbacks) && empty(row.model_max_budget) && empty(row.budget_limits) &&
    row.budget_id == null && row.project_id == null && row.organization_id == null && row.agent_id == null;
}

function exactKey(row: Record<string, unknown>, expected: { keyAlias: string; teamId: string; userId: string; blocked: boolean; budget: number }): boolean {
  return exactKeyPolicy(row, expected) && row.blocked === expected.blocked;
}

function listedKeyHashes(reply: Reply | undefined): string[] | undefined {
  if (reply?.status !== 200 || !reply.parsed || !object(reply.body) || !Array.isArray(reply.body.keys)) return undefined;
  const hashes: string[] = [];
  for (const item of reply.body.keys) {
    if (typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) return undefined;
    hashes.push(item);
  }
  return hashes;
}

function explicitBlockedUnsupported(reply: Reply | undefined): boolean {
  if (!reply?.parsed || (reply.status !== 400 && reply.status !== 404 && reply.status !== 422)) return false;
  const text = (JSON.stringify(reply.body) ?? "").toLowerCase();
  return text.includes("blocked") && ["unsupported", "not supported", "unknown field", "not allowed"].some((part) => text.includes(part));
}

async function authStatus(key: string): Promise<number | undefined> {
  return (await call("GET", "/v1/models", undefined, key))?.status;
}

const run = async () => {
  if (!setup()) {
    mark("fixture-guard", "UNKNOWN");
    for (const name of CASES.slice(1)) mark(name, "UNKNOWN");
    return;
  }
  mark("fixture-guard", "PASS");
  const observedRequest: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const active = rosterCapture;
    if (active) {
      try {
        const requestUrl = input instanceof Request ? input.url : String(input);
        if (new URL(requestUrl).pathname === "/team/info")
          active.observation = await inspectRosterResponse(response.clone(), active.state, active.teamId, active.expectedIds);
      } catch { active.observation = {state: active.state, capture: "unavailable"}; }
    }
    return response;
  };
  const nativeClient = new BudgetNativeCredentialClient(origin!, master!, observedRequest);
  const readRoster = async (state: "empty" | "first" | "full", members: {userId: string; maxBudget: number; budgetDuration: string; models: readonly string[]; role: "user"}[]) => {
    const capture: NonNullable<typeof rosterCapture> = {state, teamId, expectedIds: members.map(member => member.userId)};
    rosterCapture = capture;
    let result: Awaited<ReturnType<typeof nativeClient.readTeamRoster>>;
    try {
      result = await nativeClient.readTeamRoster({teamId,teamMaxBudget:4,teamBudgetDuration:"1d",teamModels:[model!],members});
    } finally { rosterCapture = undefined; }
    const observation = capture.observation ?? {state, capture: "unavailable"};
    observation.clientResultKind = result.kind;
    rosterObservations.push(observation);
    return result;
  };
  const suffix = randomUUID();
  const teamId = suffix;
  const userId = `probe-${randomUUID()}`;
  const secondUserId = `probe-${randomUUID()}`;
  const alias = `probe-${randomUUID()}`;
  const normalKey = randomKey();
  const blockedKey = randomKey();
  const lostKey = randomKey();
  const normalHash = fingerprint(normalKey);
  const blockedHash = fingerprint(blockedKey);
  const lostHash = fingerprint(lostKey);
  const expected = { keyAlias: alias, teamId, userId, blocked: false, budget: 1 };
  let teamAttempted = false, userAttempted = false, secondUserAttempted = false;
  let lostUserDirectory: string | undefined, lostUserAttempted = false;
  let lostClientKeyDirectory: string | undefined;
  const createdHashes = new Set<string>();
  let cleanupOk = true;

  try {
    teamAttempted = true;
    const createTeam = await nativeClient.createTeam({teamId,maxBudget:4,budgetDuration:"1d",models:[model!]});
    const existingTeamPolicy = await nativeClient.readTeamPolicy({teamId,teamMaxBudget:4,teamBudgetDuration:"1d",teamModels:[model!]});
    mark("client-existing-team-before-membership", createTeam.kind === "acknowledged" && existingTeamPolicy.kind === "match" ? "PASS" :
      existingTeamPolicy.kind === "mismatch" ? "FAIL" : "UNKNOWN");
    userAttempted = true;
    const createUser = await nativeClient.createUser({userId,maxBudget:3,userRole:"internal_user"});
    const currentUserPolicy = await nativeClient.readUser({userId,maxBudget:3,userRole:"internal_user"});
    const initialUserKeys = await nativeClient.listOwnedKeys(userId);
    const absentUserId = `probe-${randomUUID()}`;
    const clientAbsentUser = await nativeClient.readUser({userId:absentUserId,maxBudget:3,userRole:"internal_user"});
    const wrongAuthClient = new BudgetNativeCredentialClient(origin!, "sk-probe-deliberately-wrong-key-000000");
    const clientRefusedUser = await wrongAuthClient.readUser({userId,maxBudget:3,userRole:"internal_user"});
    mark("client-user-policy-readback", createUser.kind === "acknowledged" && currentUserPolicy.kind === "match" && initialUserKeys.kind === "match" && initialUserKeys.value.length === 0 &&
      clientAbsentUser.kind === "absent" && clientRefusedUser.kind === "refused" ? "PASS" :
      [currentUserPolicy,initialUserKeys,clientAbsentUser,clientRefusedUser].some(result => result.kind === "mismatch" || result.kind === "malformed") ? "FAIL" : "UNKNOWN");
    const emptyTeamRoster = await readRoster("empty", []);
    mark("client-empty-team-roster", emptyTeamRoster.kind === "match" ? "PASS" : emptyTeamRoster.kind === "mismatch" ? "FAIL" : "UNKNOWN");
    const membership = await nativeClient.addMember({teamId,userId,maxBudget:2,budgetDuration:"1d",models:[model!],role:"user"});
    const firstMemberRoster = await readRoster("first", [
      {userId,maxBudget:2,budgetDuration:"1d",models:[model!],role:"user"},
    ]);
    mark("client-first-member-roster", membership.kind === "acknowledged" && firstMemberRoster.kind === "match" ? "PASS" :
      firstMemberRoster.kind === "mismatch" ? "FAIL" : "UNKNOWN");
    const noAutoKey = await call("GET", `/key/list?user_id=${encodeURIComponent(userId)}`);
    const noAutoKeyBody = noAutoKey?.body;
    mark("member-create-without-key", createUser.kind === "acknowledged" && noAutoKey?.status === 200 &&
      object(noAutoKeyBody) && Array.isArray(noAutoKeyBody.keys) && noAutoKeyBody.keys.length === 0 ? "PASS" : "FAIL");
    const emptyInventory = await nativeClient.listOwnedKeys(userId);
    mark("client-empty-key-inventory", emptyInventory.kind === "match" && emptyInventory.value.length === 0 ? "PASS" :
      emptyInventory.kind === "mismatch" ? "FAIL" : "UNKNOWN");
    const userReadback = await userLookup(userId);
    const currentUser = classifyUserLookup(userReadback, userId);
    mark("user-current-identity-global-cap-and-role", exactUserPolicy(currentUser, userId, 3) ? "PASS" : currentUser.kind === "present" ? "FAIL" : "UNKNOWN");
    mark("user-info-no-auto-key", currentUser.kind === "present" && object(userReadback?.body) &&
      Array.isArray(userReadback.body.keys) && userReadback.body.keys.length === 0 && listedKeyHashes(noAutoKey)?.length === 0 ? "PASS" : "UNKNOWN");
    mark("user-info-absent-is-not-refusal", classifyUserLookup(await userLookup(absentUserId), absentUserId).kind === "absent" ? "PASS" : "UNKNOWN");
    mark("user-info-refused-is-not-absence", classifyUserLookup(await userLookup(userId, "sk-probe-deliberately-wrong-key-000000"), userId).kind === "refused" ? "PASS" : "UNKNOWN");

    lostUserDirectory = mkdtempSync(join(tmpdir(), "lares-native-user-probe-"));
    const originalUserId = persistProbeUserId(lostUserDirectory);
    if (classifyUserLookup(await userLookup(originalUserId), originalUserId).kind !== "absent") throw new Error("fixture original identity was not absent");
    // Exactly one create: after its response body is discarded, re-read the original
    // persisted identity. Never generate a replacement or retry the create.
    lostUserAttempted = true;
    let lostUserWriteRequests = 0;
    const lostUserClient = new BudgetNativeCredentialClient(origin!, master!, async (input, init) => {
      lostUserWriteRequests++;
      const response = await fetch(input, init);
      await drainBoundedBody(response, false);
      throw new Error("probe suppressed the completed user-create reply");
    });
    const lostUserCreate = await lostUserClient.createUser({userId:originalUserId,maxBudget:7,userRole:"internal_user"});
    const retainedUserId = readProbeUserId(lostUserDirectory);
    const reconciledUser = await userLookup(retainedUserId);
    const reconciledUserPolicy = classifyUserLookup(reconciledUser, retainedUserId);
    const lostUserKeys = listedKeyHashes(await call("GET", `/key/list?user_id=${retainedUserId}`));
    mark("lost-user-create-response-reconciles-original-id", lostUserCreate.kind === "uncertain" && lostUserWriteRequests === 1 && originalUserId === retainedUserId &&
      exactUserPolicy(reconciledUserPolicy, retainedUserId, 7) && object(reconciledUser?.body) &&
      Array.isArray(reconciledUser.body.keys) && reconciledUser.body.keys.length === 0 && lostUserKeys?.length === 0 ? "PASS" : "UNKNOWN");
    if (ciBarrier && barrierFile) {
      writeCiFile(expectedFile!, `${teamId}\n${userId}\n`, "members-expected-write-failed");
      writeCiFile(barrierFile, "members-ready", "members-barrier-write-failed");
      await waitForCiAcknowledgement("members-checked");
    }

    createdHashes.add(normalHash);
    const generated = await call("POST", "/key/generate", {
      key: normalKey, key_alias: alias, key_type: "llm_api", team_id: teamId, user_id: userId,
      max_budget: 1, budget_duration: "1d", models: [model], blocked: false,
    });
    const lookup = classifyLookup(await hashLookup(normalHash), normalHash);
    const row = lookup.kind === "present" ? lookup.row : undefined;
    const policyExact = row !== undefined && exactKeyPolicy(row, expected);
    mismatch("normal-key-policy-exact", row ? policyExact : undefined);
    mismatch("normal-key-blocked-false", row ? row.blocked === false : undefined);
    const createdExactly = generated?.status === 200 && generated.parsed && object(generated.body) && generated.body.key === normalKey &&
      row !== undefined && exactKey(row, expected);
    mark("caller-key-exact-and-hash-lookup", createdExactly ? "PASS" : lookup.kind === "malformed" ? "UNKNOWN" : "FAIL");
    const populatedInventory = await nativeClient.listOwnedKeys(userId);
    mark("client-populated-key-inventory", populatedInventory.kind === "match" && populatedInventory.value.length === 1 &&
      populatedInventory.value[0] === normalHash ? "PASS" : populatedInventory.kind === "mismatch" ? "FAIL" : "UNKNOWN");
    if (ciBarrier && barrierFile) {
      writeCiFile(expectedFile!, `${normalHash}\n${teamId}\n${userId}\n`, "key-expected-write-failed");
      writeCiFile(barrierFile, "key-ready", "key-barrier-write-failed");
      await waitForCiAcknowledgement("key-checked");
    }

    const teamReadback = await call("GET", `/team/info?team_id=${encodeURIComponent(teamId)}`, undefined, master);
    const teamRecord = object(teamReadback?.body) && object(teamReadback.body.team_info) ? teamReadback.body.team_info : undefined;
    const memberships = object(teamReadback?.body) && Array.isArray(teamReadback.body.team_memberships)
      ? teamReadback.body.team_memberships.filter((entry): entry is Record<string, unknown> => object(entry) && entry.team_id === teamId && entry.user_id === userId)
      : undefined;
    const memberRecord = memberships?.length === 1 ? memberships[0] : undefined;
    const memberBudget = memberRecord && object(memberRecord.litellm_budget_table) ? memberRecord.litellm_budget_table : undefined;
    const roleRecords = teamRecord && Array.isArray(teamRecord.members_with_roles)
      ? teamRecord.members_with_roles.filter((entry): entry is Record<string, unknown> => object(entry) && entry.user_id === userId)
      : undefined;
    const teamReadbackAvailable = teamReadback?.status === 200 && teamRecord !== undefined;
    const clientTeamPolicy = await nativeClient.readTeam({teamId, teamMaxBudget:4, teamBudgetDuration:"1d", teamModels:[model!],
      memberUserId:userId, memberMaxBudget:2, memberBudgetDuration:"1d", memberModels:[model!], memberRole:"user"});
    mark("client-team-duration-and-membership-policy", clientTeamPolicy.kind === "match" ? "PASS" :
      clientTeamPolicy.kind === "mismatch" ? "FAIL" : "UNKNOWN");
    mismatch("member-match-unique", memberships === undefined ? undefined : memberships.length === 1);
    mismatch("budget-cap-exact", memberBudget ? memberBudget.max_budget === 2 : memberRecord ? undefined : memberships ? false : undefined);
    mismatch("budget-duration-exact", memberBudget ? memberBudget.budget_duration === "1d" : memberRecord ? undefined : memberships ? false : undefined);
    mismatch("models-exact", memberBudget ? Array.isArray(memberBudget.allowed_models) && memberBudget.allowed_models.length === 1 && memberBudget.allowed_models[0] === model : memberRecord ? undefined : memberships ? false : undefined);
    mismatch("team-blocked-false", teamRecord ? teamRecord.blocked === false : undefined);
    mismatch("team-metadata-empty", teamRecord ? empty(teamRecord.metadata) : undefined);
    mismatch("member-role-exact", roleRecords === undefined ? undefined : roleRecords.length === 1 && roleRecords[0].role === "user");
    mark("team-membership-and-caps", createTeam.kind === "acknowledged" && membership.kind === "acknowledged" && teamReadbackAvailable &&
      teamRecord?.max_budget === 4 && Array.isArray(teamRecord.models) && teamRecord.models.length === 1 && teamRecord.models[0] === model &&
      empty(teamRecord.metadata) && teamRecord.blocked === false && memberships?.length === 1 &&
      memberBudget?.max_budget === 2 && memberBudget.budget_duration === "1d" &&
      Array.isArray(memberBudget.allowed_models) && memberBudget.allowed_models.length === 1 && memberBudget.allowed_models[0] === model &&
      roleRecords?.length === 1 && roleRecords[0].role === "user" ? "PASS" : "FAIL");

    secondUserAttempted = true;
    const secondUserCreate = await nativeClient.createUser({userId:secondUserId,maxBudget:3,userRole:"internal_user"});
    const secondMembership = await nativeClient.addMember({teamId,userId:secondUserId,maxBudget:3,budgetDuration:"1d",models:[model!],role:"user"});
    const fullTeamRoster = await readRoster("full", [
      {userId,maxBudget:2,budgetDuration:"1d",models:[model!],role:"user"},
      {userId:secondUserId,maxBudget:3,budgetDuration:"1d",models:[model!],role:"user"},
    ]);
    mark("client-full-team-roster", secondUserCreate.kind === "acknowledged" && secondMembership.kind === "acknowledged" && fullTeamRoster.kind === "match" ? "PASS" :
      fullTeamRoster.kind === "mismatch" ? "FAIL" : "UNKNOWN");

    const absentHash = fingerprint(randomKey());
    mark("hash-lookup-absent-is-not-error", classifyLookup(await hashLookup(absentHash), absentHash).kind === "absent" ? "PASS" : "UNKNOWN");
    const fixtureChallenge = randomBytes(32).toString("hex");
    const clientAbsent = await nativeClient.lookupKeyHashOnly(absentHash, fixtureChallenge);
    mark("client-hash-only-absence-receipt", clientAbsent.kind === "absent" &&
      consumeNativeHashAbsenceReceipt(clientAbsent.receipt, origin!, absentHash, fixtureChallenge) ? "PASS" :
      clientAbsent.kind === "malformed" || clientAbsent.kind === "present" ? "FAIL" : "UNKNOWN");
    const refused = classifyLookup(await hashLookup(normalHash, "sk-probe-deliberately-wrong-key-000000"), normalHash);
    mark("hash-lookup-refused-is-not-absence", refused.kind === "refused" ? "PASS" : refused.kind === "malformed" ? "UNKNOWN" : "FAIL");

    const duplicate = await call("POST", "/key/generate", {
      key: normalKey, key_alias: alias, key_type: "llm_api", team_id: teamId, user_id: userId,
      max_budget: 2, budget_duration: "1d", models: [model, "probe-unexpected"], blocked: false,
    });
    const duplicateBody = duplicate && object(duplicate.body) ? duplicate.body : undefined;
    if (typeof duplicateBody?.key === "string") {
      if (duplicateBody.key.startsWith("sk-") && duplicateBody.key.length >= 16) createdHashes.add(fingerprint(duplicateBody.key));
      else if (/^[a-f0-9]{64}$/.test(duplicateBody.key)) createdHashes.add(duplicateBody.key);
    }
    const afterDuplicate = classifyLookup(await hashLookup(normalHash), normalHash);
    const inventory = listedKeyHashes(await call("GET", `/key/list?user_id=${encodeURIComponent(userId)}`));
    if (inventory) for (const hash of inventory) if (!createdHashes.has(hash)) createdHashes.add(hash);
    const duplicatePolicyExact = afterDuplicate.kind === "present" ? exactKey(afterDuplicate.row, expected) : afterDuplicate.kind === "absent" ? false : undefined;
    mismatch("normal-key-policy-exact", duplicatePolicyExact === undefined ? undefined : duplicatePolicyExact);
    const duplicateInventoryExact = inventory ? inventory.length === 1 && inventory[0] === normalHash : undefined;
    mismatch("duplicate-inventory-readable", inventory !== undefined);
    mismatch("duplicate-inventory-exact", duplicateInventoryExact);
    const duplicateStateKnown = (afterDuplicate.kind === "present" || afterDuplicate.kind === "absent") && inventory !== undefined;
    mark("duplicate-key-create-does-not-overwrite", duplicateStateKnown
      ? duplicatePolicyExact && duplicateInventoryExact ? "PASS" : "FAIL"
      : "UNKNOWN");

    const blockedAlias = `probe-${randomUUID()}`;
    createdHashes.add(blockedHash);
    let blockedGenerateReply: Reply | undefined;
    let blockedWriteRequests = 0;
    const blockedCreateClient = new BudgetNativeCredentialClient(origin!, master!, async (input, init) => {
      blockedWriteRequests++;
      const response = await fetch(input, init);
      const observed = await observeResponse(response);
      blockedGenerateReply = observed.reply;
      return observed.replay;
    });
    const blockedGenerate = await blockedCreateClient.createBlockedKey({key:blockedKey,keyAlias:blockedAlias,teamId,userId,
      maxBudget:1,budgetDuration:"1d",models:[model!]});
    const blockedLookup = classifyLookup(await hashLookup(blockedHash), blockedHash);
    const blockedExact = blockedLookup.kind === "present" && exactKey(blockedLookup.row, {
      keyAlias: blockedAlias, teamId, userId, blocked: true, budget: 1,
    });
    const clientBlockedLookup = await nativeClient.lookupKey(blockedHash, {
      keyAlias: blockedAlias, teamId, userId, maxBudget: 1, budgetDuration: "1d", models: [model!],
    });
    mark("client-blocked-key-policy-readback", clientBlockedLookup.kind === "match" ? "PASS" :
      clientBlockedLookup.kind === "mismatch" ? "FAIL" : "UNKNOWN");
    if (blockedGenerate.kind === "acknowledged" && blockedWriteRequests === 1 && blockedGenerateReply?.status === 200 && blockedExact) {
      const status = await authStatus(blockedKey);
      mark("atomic-blocked-create", status === 401 || status === 403 ? "PASS" : status === 200 ? "FAIL" : "UNKNOWN");
      mark("blocked-key-readback-and-native-auth", status === 401 || status === 403 ? "PASS" : "UNKNOWN");
    } else if (explicitBlockedUnsupported(blockedGenerateReply) && blockedLookup.kind === "absent") {
      mark("atomic-blocked-create", "UNSUPPORTED");
      mark("blocked-key-readback-and-native-auth", "UNKNOWN");
    } else if (blockedGenerateReply?.status === 200 && blockedLookup.kind === "present" && blockedLookup.row.blocked === false) {
      // The native endpoint accepted but ignored atomic blocking; never authenticate this key.
      await call("POST", "/key/delete", { keys: [blockedHash] });
      if (classifyLookup(await hashLookup(blockedHash), blockedHash).kind === "absent") createdHashes.delete(blockedHash);
      mark("atomic-blocked-create", "UNSUPPORTED");
      mark("blocked-key-readback-and-native-auth", "UNKNOWN");
    } else {
      if (blockedLookup.kind === "present") {
        await call("POST", "/key/delete", { keys: [blockedHash] });
        if (classifyLookup(await hashLookup(blockedHash), blockedHash).kind === "absent") createdHashes.delete(blockedHash);
      }
      mark("atomic-blocked-create", "UNKNOWN");
      mark("blocked-key-readback-and-native-auth", "UNKNOWN");
    }

    const validBeforeBlock = await authStatus(normalKey);
    await call("POST", "/key/block", { key: normalHash });
    const blockedReadback = classifyLookup(await hashLookup(normalHash), normalHash);
    const blockedStatus = await authStatus(normalKey);
    mark("block-unblock-readback-only", blockedReadback.kind === "present" && blockedReadback.row.blocked === true &&
      (validBeforeBlock === 200 || validBeforeBlock === 204) && (blockedStatus === 401 || blockedStatus === 403) ? "PASS" : "UNKNOWN");
    const unblock = await nativeClient.unblockKey(normalHash);
    const clientUnblockedReadback = await nativeClient.lookupUnblockedKey(normalHash, {
      keyAlias: alias, teamId, userId, maxBudget: 1, budgetDuration: "1d", models: [model!],
    });
    mark("client-unblock-and-exact-unblocked-readback", unblock.kind === "acknowledged" && clientUnblockedReadback.kind === "match" ? "PASS" :
      clientUnblockedReadback.kind === "mismatch" || clientUnblockedReadback.kind === "malformed" ? "FAIL" : "UNKNOWN");
    const unblockedReadback = classifyLookup(await hashLookup(normalHash), normalHash);
    const unblockedStatus = await authStatus(normalKey);
    mark("unblocked-key-readback-and-native-auth", unblockedReadback.kind === "present" && unblockedReadback.row.blocked === false &&
      (unblockedStatus === 200 || unblockedStatus === 204) ? "PASS" : "UNKNOWN");

    createdHashes.add(lostHash);
    const lostCreate = await call("POST", "/key/generate", {
      key: lostKey, key_alias: `probe-${randomUUID()}`, key_type: "llm_api", team_id: teamId, user_id: userId,
      max_budget: 1, budget_duration: "1d", models: [model], blocked: false,
    }, master, true);
    const recovered = classifyLookup(await hashLookup(lostHash), lostHash);
    mark("lost-create-response-reconciles-by-hash", lostCreate?.dropped === true && recovered.kind === "present" &&
      recovered.row.user_id === userId && recovered.row.team_id === teamId ? "PASS" : "UNKNOWN");

    lostClientKeyDirectory = mkdtempSync(join(tmpdir(), "lares-native-key-probe-"));
    const lostClientKey = persistProbeKey(lostClientKeyDirectory, randomKey());
    const lostClientHash = fingerprint(lostClientKey);
    const lostClientAlias = `probe-${randomUUID()}`;
    createdHashes.add(lostClientHash);
    let lostClientWriteRequests = 0;
    const lostClient = new BudgetNativeCredentialClient(origin!, master!, async (input, init) => {
      lostClientWriteRequests++;
      const response = await fetch(input, init);
      await drainBoundedBody(response, false);
      throw new Error("probe suppressed the completed client key-create reply");
    });
    const lostClientWrite = await lostClient.createBlockedKey({key:lostClientKey,keyAlias:lostClientAlias,teamId,userId,
      maxBudget:1,budgetDuration:"1d",models:[model!]});
    const retainedLostClientKey = readProbeKey(lostClientKeyDirectory);
    const lostClientReadback = await nativeClient.lookupKey(lostClientHash,{keyAlias:lostClientAlias,teamId,userId,
      maxBudget:1,budgetDuration:"1d",models:[model!]});
    mark("lost-client-blocked-create-response-reconciles-original-key", lostClientWrite.kind === "uncertain" &&
      lostClientWriteRequests === 1 && fingerprint(retainedLostClientKey) === lostClientHash && lostClientReadback.kind === "match" ? "PASS" : "UNKNOWN");

    const lostDelete = await call("POST", "/key/delete", { keys: [lostHash] }, master, true);
    const deletedAfterLostReply = classifyLookup(await hashLookup(lostHash), lostHash);
    mark("delete-by-hash-and-reconcile-lost-response", lostDelete?.dropped === true && deletedAfterLostReply.kind === "absent" ? "PASS" : "UNKNOWN");
    if (deletedAfterLostReply.kind === "absent") createdHashes.delete(lostHash);

    await call("POST", "/key/delete", { keys: [normalHash] });
    const deleted = classifyLookup(await hashLookup(normalHash), normalHash);
    await call("POST", "/key/delete", { keys: [normalHash] });
    const deletedAgain = classifyLookup(await hashLookup(normalHash), normalHash);
    mark("already-deleted-remains-absent", deleted.kind === "absent" && deletedAgain.kind === "absent" ? "PASS" : "UNKNOWN");
    if (deletedAgain.kind === "absent") createdHashes.delete(normalHash);
  } finally {
    if (lostUserDirectory) {
      try {
        if (lostUserAttempted) {
          const retainedUserId = readProbeUserId(lostUserDirectory);
          const reply = await call("POST", "/user/delete", { user_ids: [retainedUserId] });
          if (reply?.status !== 200 || classifyUserLookup(await userLookup(retainedUserId), retainedUserId).kind !== "absent") cleanupOk = false;
        }
      } catch { cleanupOk = false; }
      try { unlinkSync(join(lostUserDirectory, "original-user-id")); rmdirSync(lostUserDirectory); } catch { cleanupOk = false; }
    }
    for (const hash of createdHashes) {
      const reply = await call("POST", "/key/delete", { keys: [hash] });
      const lookup = classifyLookup(await hashLookup(hash), hash);
      if (lookup.kind === "absent") createdHashes.delete(hash);
      else cleanupOk = false;
      if (!reply || reply.status < 200 || reply.status >= 300) cleanupOk = false;
    }
    if (teamAttempted) {
      const reply = await call("POST", "/team/delete", { team_ids: [teamId] });
      if (!reply || reply.status < 200 || reply.status >= 300) cleanupOk = false;
    }
    if (userAttempted) {
      const reply = await call("POST", "/user/delete", { user_ids: [userId] });
      if (!reply || reply.status < 200 || reply.status >= 300) cleanupOk = false;
    }
    if (secondUserAttempted) {
      const reply = await call("POST", "/user/delete", { user_ids: [secondUserId] });
      if (!reply || reply.status < 200 || reply.status >= 300) cleanupOk = false;
    }
    if (lostClientKeyDirectory) {
      try { unlinkSync(join(lostClientKeyDirectory, "original-key")); rmdirSync(lostClientKeyDirectory); }
      catch { cleanupOk = false; }
    }
    mark("fixture-cleanup", cleanupOk ? "PASS" : "UNKNOWN");
  }
};

async function main(): Promise<void> {
  try {
    await run();
  } catch {
    failed = true;
    if (!diagnosticCode) diagnosticCode = "unexpected-probe-failure";
    for (const name of CASES) if (!outcomes.has(name)) mark(name, "UNKNOWN");
  } finally {
    for (const name of CASES) console.log(`${outcomes.get(name) ?? "UNKNOWN"} ${name}`);
    for (const [name, outcome] of diagnostics) console.log(`DIAGNOSTIC ${name} ${outcome}`);
    if (diagnosticCode) console.log(`DIAGNOSTIC ${diagnosticCode}`);
    for (const observation of rosterObservations) console.log(`ROSTER-OBS ${JSON.stringify(observation)}`);
  }
  process.exitCode = failed ? 1 : 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
