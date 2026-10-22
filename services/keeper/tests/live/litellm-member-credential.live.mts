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
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CASES = [
  "fixture-guard",
  "member-create-without-key",
  "team-membership-and-caps",
  "caller-key-exact-and-hash-lookup",
  "hash-lookup-absent-is-not-error",
  "hash-lookup-refused-is-not-absence",
  "duplicate-key-create-does-not-overwrite",
  "atomic-blocked-create",
  "blocked-key-readback-and-native-auth",
  "unblocked-key-readback-and-native-auth",
  "lost-create-response-reconciles-by-hash",
  "block-unblock-readback-only",
  "delete-by-hash-and-reconcile-lost-response",
  "already-deleted-remains-absent",
  "fixture-cleanup",
] as const;
type CaseName = typeof CASES[number];
type Outcome = "PASS" | "FAIL" | "UNKNOWN" | "UNSUPPORTED";

const outcomes = new Map<CaseName, Outcome>();
let failed = false;
const mark = (name: CaseName, outcome: Outcome) => {
  outcomes.set(name, outcome);
  if (outcome !== "PASS") failed = true;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const empty = (value: unknown) => value === undefined || value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (object(value) && Object.keys(value).length === 0);

type Reply = { status: number; body: unknown; parsed: boolean; dropped?: boolean };
type Lookup = { kind: "present"; row: Record<string, unknown> } | { kind: "absent" | "malformed" | "refused" | "unavailable" };

const urlValue = process.env.GATEWAY_URL;
const keyFile = process.env.GATEWAY_MASTER_KEY_FILE;
const model = process.env.GATEWAY_PROBE_MODEL;
const explicit = process.env.LARES_DISPOSABLE_GATEWAY === "1";
const ciBarrier = process.env.CI === "true" && process.env.LARES_PROBE_CI_BARRIER === "1";
const barrierFile = process.env.GATEWAY_PROBE_CI_BARRIER_FILE;
const expectedFile = process.env.GATEWAY_PROBE_CI_EXPECTED_FILE;
let origin: string | undefined;
let master: string | undefined;

function setup(): boolean {
  try {
    if (!explicit || !urlValue || !keyFile || !model || !/^[A-Za-z0-9_.:-]{1,160}$/.test(model)) return false;
    if ((process.env.LARES_PROBE_CI_BARRIER === "1" || barrierFile || expectedFile) && (!ciBarrier || !barrierFile || !expectedFile)) return false;
    const url = new URL(urlValue);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    const stat = lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    const candidate = readFileSync(keyFile, "utf8").trimEnd();
    if (!candidate.startsWith("sk-") || candidate.length < 16) return false;
    origin = url.origin;
    master = candidate;
    return true;
  } catch {
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
  throw new Error("fixture barrier timeout");
}

const allowedRoutes = new Map<string, "GET" | "POST">([
  ["/team/new", "POST"], ["/team/delete", "POST"],
  ["/team/info", "GET"], ["/key/list", "GET"],
  ["/user/new", "POST"], ["/user/delete", "POST"],
  ["/team/member_add", "POST"], ["/key/generate", "POST"],
  ["/v2/key/info", "POST"], ["/key/block", "POST"], ["/key/unblock", "POST"],
  ["/key/delete", "POST"], ["/v1/models", "GET"],
]);

async function call(method: "GET" | "POST", path: string, body?: unknown, auth = master, dropReply = false): Promise<Reply | undefined> {
  const route = path.split("?", 1)[0];
  if (!origin || !auth || (allowedRoutes.get(route) !== method && !/^\/team\/[0-9a-f-]{36}\/members\/me$/.test(route))) return undefined;
  const queryText = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  if (queryText) {
    const params = new URLSearchParams(queryText);
    const expectedName = route === "/team/info" ? "team_id" : route === "/key/list" ? "user_id" : "";
    if (!expectedName || [...params.keys()].length !== 1 || !params.has(expectedName) ||
        !/^[A-Za-z0-9-]{1,80}$/.test(params.get(expectedName) ?? "")) return undefined;
  } else if (path.includes("?")) return undefined;
  const requestBody = method === "POST" ? JSON.stringify(body) : undefined;
  if (requestBody !== undefined && Buffer.byteLength(requestBody) > 65_536) return undefined;
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
      if (length > 65_536) {
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

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
const randomKey = () => `sk-${randomBytes(32).toString("base64url")}`;
const hashLookup = (hash: string, auth = master) => call("POST", "/v2/key/info", { keys: [hash] }, auth);

function exactKey(row: Record<string, unknown>, expected: { keyAlias: string; teamId: string; userId: string; blocked: boolean; budget: number }): boolean {
  return row.key_alias === expected.keyAlias && row.key_type === "llm_api" &&
    row.user_id === expected.userId && row.team_id === expected.teamId &&
    row.max_budget === expected.budget && row.budget_duration === "1d" &&
    Array.isArray(row.models) && row.models.length === 1 && row.models[0] === model &&
    row.blocked === expected.blocked && empty(row.metadata) && empty(row.config) &&
    empty(row.permissions) && empty(row.aliases) && empty(row.router_settings) &&
    empty(row.budget_fallbacks) && empty(row.model_max_budget) && empty(row.budget_limits) &&
    row.budget_id == null && row.project_id == null && row.organization_id == null && row.agent_id == null;
}

function listedKeyHashes(reply: Reply | undefined): string[] | undefined {
  if (reply?.status !== 200 || !reply.parsed || !object(reply.body) || !Array.isArray(reply.body.keys)) return undefined;
  const hashes: string[] = [];
  for (const item of reply.body.keys) {
    if (!object(item) || typeof item.token !== "string" || !/^[a-f0-9]{64}$/.test(item.token)) return undefined;
    hashes.push(item.token);
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
  const suffix = randomUUID();
  const teamId = suffix;
  const userId = `probe-${randomUUID()}`;
  const alias = `probe-${randomUUID()}`;
  const normalKey = randomKey();
  const blockedKey = randomKey();
  const lostKey = randomKey();
  const normalHash = fingerprint(normalKey);
  const blockedHash = fingerprint(blockedKey);
  const lostHash = fingerprint(lostKey);
  const expected = { keyAlias: alias, teamId, userId, blocked: false, budget: 1 };
  let teamAttempted = false, userAttempted = false;
  const createdHashes = new Set<string>();
  let cleanupOk = true;

  try {
    teamAttempted = true;
    const createTeam = await call("POST", "/team/new", { team_id: teamId, max_budget: 4, models: [model], budget_duration: "1d" });
    userAttempted = true;
    const createUser = await call("POST", "/user/new", { user_id: userId, max_budget: 3, auto_create_key: false });
    const membership = await call("POST", "/team/member_add", {
      team_id: teamId, max_budget_in_team: 2, budget_duration: "1d", allowed_models: [model],
      member: { role: "user", user_id: userId },
    });
    const noAutoKey = await call("GET", `/key/list?user_id=${encodeURIComponent(userId)}`);
    const noAutoKeyBody = noAutoKey?.body;
    mark("member-create-without-key", createUser?.status === 200 && createUser.parsed && object(createUser.body) &&
      createUser.body.user_id === userId && createUser.body.max_budget === 3 && noAutoKey?.status === 200 &&
      object(noAutoKeyBody) && Array.isArray(noAutoKeyBody.keys) && noAutoKeyBody.keys.length === 0 ? "PASS" : "FAIL");
    if (ciBarrier && barrierFile) {
      writeFileSync(expectedFile!, `${teamId}\n${userId}\n`, { mode: 0o600 });
      writeFileSync(barrierFile, "members-ready");
      await waitForCiAcknowledgement("members-checked");
    }

    createdHashes.add(normalHash);
    const generated = await call("POST", "/key/generate", {
      key: normalKey, key_alias: alias, key_type: "llm_api", team_id: teamId, user_id: userId,
      max_budget: 1, budget_duration: "1d", models: [model],
    });
    const lookup = classifyLookup(await hashLookup(normalHash), normalHash);
    const row = lookup.kind === "present" ? lookup.row : undefined;
    const createdExactly = generated?.status === 200 && generated.parsed && object(generated.body) && generated.body.key === normalKey &&
      row !== undefined && exactKey(row, expected);
    mark("caller-key-exact-and-hash-lookup", createdExactly ? "PASS" : lookup.kind === "malformed" ? "UNKNOWN" : "FAIL");
    if (ciBarrier && barrierFile) {
      writeFileSync(expectedFile!, `${normalHash}\n${teamId}\n${userId}\n`, { mode: 0o600 });
      writeFileSync(barrierFile, "key-ready");
      await waitForCiAcknowledgement("key-checked");
    }

    const teamReadback = await call("GET", `/team/info?team_id=${encodeURIComponent(teamId)}`);
    const memberReadback = await call("GET", `/team/${teamId}/members/me`, undefined, normalKey);
    const teamRecord = object(teamReadback?.body) && object(teamReadback.body.team_info) ? teamReadback.body.team_info : undefined;
    const memberRecord = object(memberReadback?.body) ? memberReadback.body : undefined;
    const memberBudget = memberRecord && object(memberRecord.litellm_budget_table) ? memberRecord.litellm_budget_table : undefined;
    mark("team-membership-and-caps", createTeam?.status === 200 && membership?.status === 200 &&
      teamReadback?.status === 200 && teamRecord?.max_budget === 4 && Array.isArray(teamRecord.models) &&
      teamRecord.models.length === 1 && teamRecord.models[0] === model && empty(teamRecord.metadata) &&
      memberReadback?.status === 200 && memberRecord?.user_id === userId && memberRecord.team_id === teamId &&
      memberRecord.role === "user" && memberBudget?.max_budget === 2 && memberBudget.budget_duration === "1d" ? "PASS" : "FAIL");

    const absentHash = fingerprint(randomKey());
    mark("hash-lookup-absent-is-not-error", classifyLookup(await hashLookup(absentHash), absentHash).kind === "absent" ? "PASS" : "UNKNOWN");
    const refused = classifyLookup(await hashLookup(normalHash, "sk-probe-deliberately-wrong-key-000000"), normalHash);
    mark("hash-lookup-refused-is-not-absence", refused.kind === "refused" ? "PASS" : refused.kind === "malformed" ? "UNKNOWN" : "FAIL");

    const duplicate = await call("POST", "/key/generate", {
      key: normalKey, key_alias: alias, key_type: "llm_api", team_id: teamId, user_id: userId,
      max_budget: 2, budget_duration: "1d", models: [model, "probe-unexpected"],
    });
    const duplicateBody = duplicate && object(duplicate.body) ? duplicate.body : undefined;
    if (typeof duplicateBody?.key === "string") {
      if (duplicateBody.key.startsWith("sk-") && duplicateBody.key.length >= 16) createdHashes.add(fingerprint(duplicateBody.key));
      else if (/^[a-f0-9]{64}$/.test(duplicateBody.key)) createdHashes.add(duplicateBody.key);
    }
    const afterDuplicate = classifyLookup(await hashLookup(normalHash), normalHash);
    const inventory = listedKeyHashes(await call("GET", `/key/list?user_id=${encodeURIComponent(userId)}`));
    if (inventory) for (const hash of inventory) if (!createdHashes.has(hash)) createdHashes.add(hash);
    mark("duplicate-key-create-does-not-overwrite", afterDuplicate.kind === "present" && exactKey(afterDuplicate.row, expected) &&
      inventory !== undefined && inventory.length === 1 && inventory[0] === normalHash ? "PASS" : "UNKNOWN");

    const blockedAlias = `probe-${randomUUID()}`;
    createdHashes.add(blockedHash);
    const blockedGenerate = await call("POST", "/key/generate", {
      key: blockedKey, key_alias: blockedAlias, key_type: "llm_api", team_id: teamId, user_id: userId,
      max_budget: 1, budget_duration: "1d", models: [model], blocked: true,
    });
    const blockedLookup = classifyLookup(await hashLookup(blockedHash), blockedHash);
    const blockedExact = blockedLookup.kind === "present" && exactKey(blockedLookup.row, {
      keyAlias: blockedAlias, teamId, userId, blocked: true, budget: 1,
    });
    if (blockedGenerate?.status === 200 && blockedExact) {
      const status = await authStatus(blockedKey);
      mark("atomic-blocked-create", status === 401 || status === 403 ? "PASS" : status === 200 ? "FAIL" : "UNKNOWN");
      mark("blocked-key-readback-and-native-auth", status === 401 || status === 403 ? "PASS" : "UNKNOWN");
    } else if (explicitBlockedUnsupported(blockedGenerate) && blockedLookup.kind === "absent") {
      mark("atomic-blocked-create", "UNSUPPORTED");
      mark("blocked-key-readback-and-native-auth", "UNKNOWN");
    } else if (blockedGenerate?.status === 200 && blockedLookup.kind === "present" && blockedLookup.row.blocked === false) {
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
    await call("POST", "/key/unblock", { key: normalHash });
    const unblockedReadback = classifyLookup(await hashLookup(normalHash), normalHash);
    const unblockedStatus = await authStatus(normalKey);
    mark("unblocked-key-readback-and-native-auth", unblockedReadback.kind === "present" && unblockedReadback.row.blocked === false &&
      (unblockedStatus === 200 || unblockedStatus === 204) ? "PASS" : "UNKNOWN");

    createdHashes.add(lostHash);
    const lostCreate = await call("POST", "/key/generate", {
      key: lostKey, key_alias: `probe-${randomUUID()}`, key_type: "llm_api", team_id: teamId, user_id: userId,
      max_budget: 1, budget_duration: "1d", models: [model],
    }, master, true);
    const recovered = classifyLookup(await hashLookup(lostHash), lostHash);
    mark("lost-create-response-reconciles-by-hash", lostCreate?.dropped === true && recovered.kind === "present" &&
      recovered.row.user_id === userId && recovered.row.team_id === teamId ? "PASS" : "UNKNOWN");

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
    mark("fixture-cleanup", cleanupOk ? "PASS" : "UNKNOWN");
  }
};

try {
  await run();
} catch {
  failed = true;
  for (const name of CASES) if (!outcomes.has(name)) mark(name, "UNKNOWN");
} finally {
  for (const name of CASES) console.log(`${outcomes.get(name) ?? "UNKNOWN"} ${name}`);
}
process.exitCode = failed ? 1 : 0;
