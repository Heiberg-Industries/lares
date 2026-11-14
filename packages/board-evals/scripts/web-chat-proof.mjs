/**
 * web-chat-proof.mjs — does the console's chat proxy really carry a turn?
 *
 * `services/console/lib/chat-proxy.ts` was written against unit tests and against a reading of
 * eve's compiled client, and `useEveAgent` is wired to it. Nobody had seen either carry a
 * real turn. This script does not copy one line of that proxy: it IMPORTS `forwardChat` itself —
 * Node 24 strips the types off a `.ts` module on import, so `../../../services/console/lib/chat-proxy.ts`
 * is a plain import here with no build step and no second implementation to drift.
 *
 * What is real in this run: a real eve 1.0 process (`eve build` + `eve start`), its real HTTP
 * door with the same auth policy every role ships (`localDev()` + `withAuthChallenges(Basic, realm
 * "lares")` reading a real secret FILE), a real Postgres, eve's own browser `Client`, and the real
 * `forwardChat`. Only the model is scripted (the package's own `mockModel`) — no credential, no
 * gateway, no money.
 *
 * HOW THE FIXTURE IS BOUND. `forwardChat` refuses a loopback address on purpose: the agent it will
 * talk to must be a registered, runtime-controlled row on a private IPv4. So the proof injects
 * `deps.fetch`, asserts the URL the proxy WOULD have called is exactly
 * `http://<the registry row's address>:3000/<path>` with the Basic header it should carry, and only
 * then re-issues that same request against the real loopback port the fixture is on. The address in
 * the assertion is the one the console's own registry query returned — never one the request chose.
 *
 * WHAT IS PROVED, each item empirical:
 *   1 the door itself      health without a credential; session without one is 401 + a challenge;
 *                          with `eve:<password>` it succeeds
 *   2 a turn through it    create → send → a full scripted turn, and no response the proof ever
 *                          sees carries `www-authenticate`, `set-cookie` or the password
 *   3 eve's own client     `Client` against a tiny HTTP server whose only job is `forwardChat`
 *   4 a reconnecting stream dropped mid-turn and resumed with `startIndex`/`includeTailIndex`
 *   5 no buffering         the first stream line lands long before the turn ends (timestamps)
 *   6 the refusals         no console session / unknown agent / a path off the allow-list, each
 *                          404-or-401 with ZERO upstream requests
 *   7 the wire shape of an approval, recorded verbatim for the approval proof
 *
 * Run: `pnpm -C packages/board-evals run proof:web-chat` (Docker running). One eve process at a
 * time; the container, the process group and every temporary directory are disposed in `finally`.
 * Results: one dated file per run under `packages/board-evals/proofs/` (`web-chat-2026-09-20.md`
 * is this proof on eve 0.60.1).
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { Client } from 'eve/client';
import { PgMemberStore } from '@lares/agent-kit/member-store';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { loadDefinition } from '@lares/agent-kit/definition';
import { makeApp, run, source, abort, ensureProbeExtensionBuilt } from './proof-harness.mjs';
// The REAL proxy. Not a copy, not a re-implementation — the file the console ships.
import { forwardChat, ROUTE_USERNAME, CHAT_PATHS } from '../../../services/console/lib/chat-proxy.ts';

/** The agent name the console's registry row is under. Role-neutral, like the fixture. */
const AGENT = 'board-evals';
/** The PRIVATE address that registry row carries. `forwardChat` refuses anything else, and this
 *  is the string the injected fetch asserts the proxy built its URL from. */
const REGISTRY_ADDRESS = '10.0.0.7';
/** The throwaway route password, written to a real file the fixture's door reads at request time.
 *  Never printed: every response and every line this script emits is checked for it at the end. */
const PASSWORD = 'disposable-fixture-only';
const INCARNATION = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner@example.invalid';
/** The signed-in console member: an opaque member id, the agent's owner. Since the console's
 *  members-and-grants work the proxy asks the real member store who is signed in and the real
 *  grant store whether they may use the agent, so both are real rows here, not a stub. */
const MEMBER = 'proof-owner';
// eve 1.0's stream (version 27) is one JSON object per line: an EVENT LINE `{ at, facts: [...] }`
// holding every event one state change produced, a PROGRESS record `{ progress: {...} }`, or a
// transport record `{ "$eve": ... }` (a heartbeat, the end of a read) that is not stored and has
// no position. A request is over for this proof when a line says its turn settled, paused for a
// person, or the session ended.
const factsOf = (line) => (Array.isArray(line?.facts) ? line.facts : []);
const typesOf = (line) => (line?.progress ? [`progress:${line.progress.type}`] : line?.$eve ? [`$eve:${line.$eve}`] : factsOf(line).map((f) => f.type));
const isTerminal = (line) => factsOf(line).some((f) => f.type === 'turn.settled' || f.type === 'turn.paused' || f.type === 'session.ended');
const isStored = (line) => line !== undefined && !('$eve' in line) && line.type !== '<unparsed>' && line.type !== '<unterminated>';
const lastTypes = (lines) => JSON.stringify(typesOf(lines.at(-1)?.event));

// ─── the disposable fixture's own door, instrumentation and tools ──────────────────────────────

/** A mirror of every role's `agent/channels/eve.ts`: the same two-step policy, the same
 *  realm, and the password read from a FILE on the first request — never at import, because
 *  `eve build` has no secrets. Written into the COPY only; the source tree keeps no door. */
const CHANNEL_SRC = `
import { readFileSync } from "node:fs";
import { eveChannel } from "eve/channels/eve";
import { localDev, verifyHttpBasic, withAuthChallenges, type AuthFn } from "eve/channels/auth";

export const ROUTE_USERNAME = "eve";

let cached: string | undefined;
function routePassword(): string {
  if (cached !== undefined) return cached;
  const path = process.env.EVE_ROUTE_PASSWORD_FILE;
  if (path === undefined) throw new Error("no route password file is configured");
  cached = readFileSync(path, "utf8").trim();
  if (cached.length === 0) throw new Error(\`secret file is empty: \${path}\`);
  return cached;
}

export const basicFromSecretFile: AuthFn<Request> = (request) => {
  const result = verifyHttpBasic(request.headers.get("authorization"), {
    username: ROUTE_USERNAME,
    password: routePassword(),
  });
  return result.ok ? result.sessionAuth : null;
};

export default eveChannel({
  auth: [localDev(), withAuthChallenges(basicFromSecretFile, [{ scheme: "Basic", parameters: { realm: "lares" } }])],
});
`;

/** The same startup hook the chief of staff runs, so the approval card the browser sees is rendered
 *  by the REAL formatters — the point of item 7 is what those put on the wire, not a fixture's. */
const INSTRUMENTATION_SRC = `
import { installRefusingDefaultProvider } from "@lares/agent-kit/gateway-budget";
import { defineInstrumentation } from "eve/instrumentation";
import { registerApprovalSummary } from "@lares/agent-kit/approval-summary";

// FIRST: no model call from this disposable agent can leave through the AI SDK's default provider.
installRefusingDefaultProvider();

export default defineInstrumentation({ setup: () => { registerApprovalSummary(); } });
`;

/** A tool that takes its time. A turn that ends in microseconds cannot tell a streaming proxy from
 *  a buffering one, so item 5 needs real wall-clock room between the first event and the last. */
const SLOW_TOOL_SRC = `
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Takes a measurable amount of time (proof fixture).",
  inputSchema: z.object({}),
  execute: async () => {
    await new Promise((r) => setTimeout(r, 1500));
    return { waited: true };
  },
});
`;

/** The fixture's `gmail_send`, rewritten in the COPY with the REAL tool's field names and an
 *  unconditional card. The name matters: `summarizeApproval`/`detailsForApproval` key on it, so
 *  the card this parks is the one an installation really gets. */
const GATED_TOOL_SRC = `
import { appendFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { withCardTitle } from "@lares/agent-kit/approval-summary";
import { z } from "zod";

export default defineTool({
  description: "Send mail (proof fixture, shaped like the real tool).",
  inputSchema: z.object({
    from: z.string(),
    to: z.array(z.string()).min(1),
    subject: z.string(),
    bodyText: z.string(),
  }),
  // eve 1.0 takes a card's title from the OBJECT form of \`approval\`; every gated catalogue tool
  // wraps its policy with \`withCardTitle\` (services/chief-of-staff/agent/tools/catalogue.ts), so the
  // fixture does too. A bare \`always()\` gets eve's default title, "Approve Gmail send?".
  approval: withCardTitle(always()),
  execute: async (input: unknown) => {
    appendFileSync(process.env.BOARD_LOG!, "sent\\n");
    return { sent: true };
  },
});
`;

/** What the scripted model does with this proof's three messages. Everything else in `agent.ts`
 *  keeps its behaviour, so no other eval in the package is affected — the patch lands in the copy. */
const CHAT_CASES = {
  'take your time': { tool: 'chat_probe_slow', input: {} },
  'ask me first': {
    tool: 'gmail_send',
    input: {
      from: 'agent@example.invalid',
      to: ['first@example.invalid', 'second@example.invalid'],
      subject: 'The quarterly note',
      bodyText: 'Here is the note you asked for.\nIt is two lines long.',
    },
  },
};

/** Two anchored replacements in the COPY of `agent/agent.ts`; both anchors are asserted, so an
 *  edit to the scripted model fails this script loudly instead of quietly proving nothing. */
function patchScriptedModel(root) {
  const file = join(root, 'agent/agent.ts');
  let text = readFileSync(file, 'utf8');
  const anchorTop = 'const acted = new Set<string>();';
  const anchorTool = 'const tool = msg.startsWith("write")';
  assert.ok(text.includes(anchorTop), 'agent/agent.ts no longer declares `acted` — re-anchor the patch');
  assert.ok(text.includes(anchorTool), 'agent/agent.ts no longer dispatches on "write" — re-anchor the patch');
  text = text.replace(
    anchorTop,
    `${anchorTop}\n\n// Added by scripts/web-chat-proof.mjs in a disposable copy of this package.\nconst CHAT_CASES: Record<string, { tool: string; input: Record<string, unknown> }> = ${JSON.stringify(CHAT_CASES, null, 2)};\n`,
  );
  text = text.replace(
    anchorTool,
    `const chat = CHAT_CASES[msg];\n  if (chat) {\n    return toolResults.some((r) => r.name === chat.tool)\n      ? \`DONE:\${msg}\`\n      : { toolCalls: [{ name: chat.tool, input: chat.input }] };\n  }\n\n  ${anchorTool}`,
  );
  writeFileSync(file, text);
}

function fitOut(root) {
  patchScriptedModel(root);
  mkdirSync(join(root, 'agent/channels'), { recursive: true });
  writeFileSync(join(root, 'agent/channels/eve.ts'), CHANNEL_SRC);
  // eve 1.0 reads instrumentation from a directory, one file per provider; the fixture's own
  // agent/instrumentation/model-guard.ts is already in the copy and stays.
  mkdirSync(join(root, 'agent/instrumentation'), { recursive: true });
  writeFileSync(join(root, 'agent/instrumentation/approval-summary.ts'), INSTRUMENTATION_SRC);
  writeFileSync(join(root, 'agent/tools/chat_probe_slow.ts'), SLOW_TOOL_SRC);
  writeFileSync(join(root, 'agent/tools/gmail_send.ts'), GATED_TOOL_SRC);
}

/** Every box file in number order (as the image probe applies them: the console's member, grant
 *  and conversation-binding tables are not in the baseline), the registry row, and the member and
 *  grant rows the proxy now checks. Returns the signed-in member's session token. */
async function seed(pool, loaded) {
  const sql = resolve(source, '../../services/box/sql');
  for (const name of readdirSync(sql).filter((n) => /^\d{3}.*\.sql$/.test(n)).sort())
    await pool.query(readFileSync(join(sql, name), 'utf8'));
  // The definition row is the one the agent itself records at its first turn (`rememberValid`):
  // the same loader, the same hash. A different hash there is a changed definition, which bumps
  // the agent's access revision and retires every console conversation, as it should.
  const { definition, hash } = loaded;
  await pool.query("INSERT INTO agent_definitions(name,definition,hash,status,duties,voice) VALUES($1,$2,$3,'valid',$4,$5)", [AGENT, definition, hash, loaded.dutiesMd, loaded.voiceMd]);
  await pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition)
    VALUES ('${AGENT}','${REGISTRY_ADDRESS}','synthetic-unused','owned','${INCARNATION}','${INCARNATION}','ready',false,$1)`, [definition]);
  await pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,applied_revision)
    VALUES ('${AGENT}','slack','${INCARNATION}','22222222-2222-4222-8222-222222222222','${OWNER}','U_SYNTHETIC','22222222-2222-4222-8222-222222222222')`);
  await pool.query("INSERT INTO orgs(id,display_name) VALUES('proof-org','Proof')");
  await pool.query("INSERT INTO users(id,display_name,org_id,org_role) VALUES($1,'Owner','proof-org','owner')", [MEMBER]);
  await pool.query('INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES($1,NULL)', [MEMBER]);
  await pool.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,'https://identity.example.invalid',$1,'')", [MEMBER]);
  const session = await new PgMemberStore(pool).createSession({ identity: { issuer: 'https://identity.example.invalid', subject: MEMBER }, verifiedAt: new Date() }, new Date(Date.now() + 3600000));
  await new PgGrantStore(pool).adoptAgent(MEMBER, { agentName: AGENT, expectedDefinitionHash: hash }, { designatedOwnerMemberId: MEMBER });
  return session.token;
}

// ─── the proof's own instruments ───────────────────────────────────────────────────────────────

const results = [];
const record = (item, ok, say) => { results.push({ item, ok, say }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${say}`); if (!ok) process.exitCode = 1; };

/** Every upstream call the proxy made, in order. `length` is the "zero requests" assertion. */
let calls = [];
/** Every response header set and every body the proof read, for the leak check at the end. */
const seenHeaders = [];
const seenBodies = [];
let port;
/** The signed-in member's console session token, the pool the proxy's checks read, and the
 *  browser's cookie jar: path → `name=value` for each conversation cookie the proxy issued. */
let memberToken, authDb, memberStore;
const jar = new Map();
const cookieFor = (urlPath) => [...jar].filter(([path]) => urlPath === path || urlPath.startsWith(`${path}/`)).map(([, pair]) => pair).join('; ');

/**
 * The proxy now sets ONE cookie of its own: on a successful create it issues the conversation's
 * capability cookie (`chatSessionCapabilityCookie` in services/console/lib/chat-session-capability.ts),
 * which a browser must show to continue that conversation. Any other `set-cookie` — on any other
 * response, or of any other name or shape — is still a failure, and so is the password in it.
 * (On eve 0.60 the proxy set no cookie at all, and this check was "no set-cookie anywhere".)
 */
function observe(response, where) {
  const headers = Object.fromEntries(response.headers);
  const entry = { where, headers, capabilityCookie: false };
  seenHeaders.push(entry);
  assert.equal(response.headers.get('www-authenticate'), null, `${where}: the door's challenge reached the browser`);
  const cookie = response.headers.get('set-cookie');
  if (cookie !== null) {
    const sid = response.headers.get('x-eve-session-id');
    assert.ok(/ eve\/v1\/session$/.test(where) && response.ok && sid, `${where}: a cookie was set on a response that is not a successful create`);
    const path = `/api/chat/${AGENT}/eve/v1/session/${sid}`;
    assert.match(cookie, new RegExp(`^lares_chat_${sid}=[A-Za-z0-9_-]{43}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=[0-9]+; Secure$`), `${where}: a cookie that is not the proxy's own conversation cookie: ${cookie}`);
    assert.ok(!cookie.includes(PASSWORD), `${where}: the password is in a cookie`);
    jar.set(path, cookie.split(';')[0]);
    entry.capabilityCookie = true;
  }
  return response;
}

/** The injected fetch: assert the address and the credential the proxy built, then re-issue the
 *  same request against the loopback port the fixture is really on. */
async function boundFetch(url, init) {
  const prefix = `http://${REGISTRY_ADDRESS}:3000/`;
  const text = String(url);
  const headers = new Headers(init?.headers ?? {});
  calls.push({ url: text, method: init?.method, authorization: headers.get('authorization') });
  try {
    assert.ok(text.startsWith(prefix), `the proxy addressed ${text}, not the registry's ${prefix}`);
    assert.equal(headers.get('authorization'), `Basic ${Buffer.from(`${ROUTE_USERNAME}:${PASSWORD}`).toString('base64')}`, 'the upstream Authorization header is not the door credential');
    assert.equal(init?.redirect, 'error', 'the proxy would follow a redirect');
    return await fetch(`http://127.0.0.1:${port}/${text.slice(prefix.length)}`, init);
  } catch (error) {
    // The proxy reports any failure here as its own 502 and keeps the cause to itself, so a
    // failed assertion above would otherwise read as a refusal. This is where it is made loud.
    console.log(`upstream ${init?.method} ${text} failed: ${error?.cause?.message ?? error?.message ?? error}`);
    if (error instanceof assert.AssertionError) process.exitCode = 1;
    throw error;
  }
}

/** The proxy's own collaborators, all real: the member store answers who is signed in (or
 *  nobody, for `signedIn: false`), and the registry and the grant checks read the real tables. */
function deps({ signedIn = true } = {}) {
  return {
    signedInMember: async () => (signedIn ? (await memberStore.sessionMember(memberToken)) ?? null : null),
    routePassword: () => PASSWORD,
    query: (sql, values) => authDb.query(sql, values),
    connect: () => authDb.connect(),
    fetch: boundFetch,
  };
}

/** One browser request, through the real `forwardChat`. The browser's cookie jar goes with it,
 *  as a browser's would. */
async function viaProxy(method, path, { body, query = '', signal, ...options } = {}) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  const cookie = cookieFor(`/api/chat/${AGENT}/${path}`);
  if (cookie) headers.cookie = cookie;
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  if (signal !== undefined) init.signal = signal;
  const request = new Request(`https://console.example.invalid/api/chat/${AGENT}/${path}${query}`, init);
  return observe(await forwardChat(request, AGENT, path, deps(options)), `${method} ${path}`);
}

/** Reads an NDJSON body line by line, stamping each line with the moment it arrived. */
async function readStream(response, { lines: wanted = Infinity, untilTerminal = true, timeoutMs = 60000 } = {}) {
  const started = Date.now();
  const out = [];
  if (!response.body) return out;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs);
  try {
    while (out.length < wanted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (raw.trim() === '') continue;
        seenBodies.push(raw);
        let event;
        try { event = JSON.parse(raw); } catch { event = { type: '<unparsed>', raw }; }
        out.push({ at: Date.now() - started, raw, event });
        if (out.length >= wanted) break;
        if (untilTerminal && isTerminal(event)) return out;
      }
      if (out.length >= wanted) break;
    }
    // A body that does not end in a newline is an ERROR body, not a stream. Keep it: it is the
    // only evidence of why a stream did not open.
    if (buffer.trim() !== '') { seenBodies.push(buffer); out.push({ at: Date.now() - started, raw: buffer.trim(), event: { type: '<unterminated>', raw: buffer.trim() } }); }
  } catch (error) {
    if (!/abort/i.test(String(error))) throw error;
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => {});
  }
  return out;
}

/** eve's own client retries a stream open on these statuses (`open-stream.js`'s
 *  `retryableErrorStatuses`) — a session that has only just been accepted is not streamable yet.
 *  The raw half of this proof has to do the same, or it measures the race and not the proxy. */
const RETRYABLE = new Set([404, 409, 425, 500, 502, 503, 504]);

/**
 * eve's session stream is not one long connection: the server closes it whenever it has nothing
 * more to send, and eve's own client reopens at the next index (`followStreamIterable`'s idle
 * reconnect). A reader that does not do the same measures the race, not the proxy. This is that
 * loop, stamping every line with its arrival time AND the connection it arrived on — which is what
 * item 5 needs, because "the first line arrived before the turn ended" only rules out buffering
 * when both lines came down the SAME connection.
 */
async function followProxiedStream(sessionId, startIndex, { deadlineMs = 60000 } = {}) {
  const began = Date.now();
  const lines = [];
  let index = startIndex;
  for (let connection = 0; Date.now() - began < deadlineMs; connection += 1) {
    // No `includeTailIndex` here, deliberately: asking for the tail index makes eve serve a
    // BOUNDED snapshot that ends at the tail, which is how a live turn came down one event per
    // connection until this was found. eve's own client only asks for it on a bounded read.
    const response = await openProxiedStream(sessionId, { startIndex: index, includeTailIndex: false });
    if (!response.ok) { seenBodies.push(await response.text()); break; }
    const batch = await readStream(response, { timeoutMs: deadlineMs });
    for (const line of batch) lines.push({ ...line, at: Date.now() - began, connection });
    index += batch.filter((l) => isStored(l.event)).length; // the cursor counts stored lines only
    if (batch.some((l) => isTerminal(l.event))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return lines;
}

/** The widest gap between the first and last line of ONE connection: the buffering measurement. */
function widestSingleConnectionSpan(lines) {
  const spans = new Map();
  for (const line of lines) {
    const span = spans.get(line.connection) ?? { first: line.at, last: line.at, count: 0 };
    span.last = line.at;
    span.count += 1;
    spans.set(line.connection, span);
  }
  let best = { first: 0, last: 0, count: 0, connection: -1 };
  for (const [connection, span] of spans) if (span.last - span.first > best.last - best.first) best = { ...span, connection };
  return best;
}

async function openProxiedStream(sessionId, { startIndex = 0, signal, includeTailIndex = true } = {}) {
  // The two query parameters the console's proxy lets through, and nothing else.
  const params = [startIndex === 0 ? null : `startIndex=${startIndex}`, includeTailIndex ? 'includeTailIndex=1' : null].filter(Boolean);
  const query = params.length ? `?${params.join('&')}` : '';
  let last;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await viaProxy('GET', `eve/v1/session/${sessionId}/stream`, { query, signal });
    if (last.ok) return last;
    if (!RETRYABLE.has(last.status)) break;
    if (attempt === 11) break; // the last refusal goes back unread, as evidence for the caller
    const said = await last.text();
    seenBodies.push(said);
    console.log(`stream ${sessionId}${query} → ${last.status} ${said.slice(0, 200)} (retrying)`);
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return last;
}

const freePort = () => new Promise((done) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => done(p)); });
});

const basic = `Basic ${Buffer.from(`${ROUTE_USERNAME}:${PASSWORD}`).toString('base64')}`;

// ─── the run ───────────────────────────────────────────────────────────────────────────────────

let container, db, door, bridge, app;
const wire = { inputRequestEvents: [], terminalEvent: null };
const startedAt = Date.now();
try {
  await ensureProbeExtensionBuilt();
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  const uriFor = (name) => container.getConnectionUri().replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
  await db.query('CREATE DATABASE webchat');

  app = makeApp(uriFor('webchat'), '0'); // schedules off: nothing here needs a tick
  const { root: cwd, env, eve } = app;
  authDb = new Pool({ connectionString: uriFor('webchat') });
  memberStore = new PgMemberStore(authDb);
  memberToken = await seed(authDb, await loadDefinition({ serviceDir: cwd, env }));
  env.EVE_ROUTE_PASSWORD_FILE = join(cwd, 'route-password');
  writeFileSync(env.EVE_ROUTE_PASSWORD_FILE, `${PASSWORD}\n`);
  fitOut(cwd);

  let mark = Date.now();
  await run(eve, ['build'], { cwd, env });
  console.log(`fixture built in ${((Date.now() - mark) / 1000).toFixed(1)}s`);

  port = await freePort();
  abort.signal.throwIfAborted();
  door = spawn(eve, ['start', '--host', '127.0.0.1', '--port', String(port)], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let doorLog = '';
  door.stdout.on('data', (b) => { doorLog += b; });
  door.stderr.on('data', (b) => { doorLog += b; });
  mark = Date.now();
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/eve/v1/health`)).ok) break; } catch {}
    if (i >= 150) throw new Error(`the fixture's door never answered\n${doorLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`door up in ${((Date.now() - mark) / 1000).toFixed(1)}s on 127.0.0.1:${port}`);

  // ── 1. the door itself ───────────────────────────────────────────────────────────────────────
  const health = await fetch(`http://127.0.0.1:${port}/eve/v1/health`);
  const healthBody = await health.json();
  record('1a health without a credential', health.status === 200 && healthBody.ok === true, `${health.status} ${JSON.stringify(healthBody)}`);

  const naked = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"hello"}' });
  const challenge = naked.headers.get('www-authenticate');
  record('1b session without a credential', naked.status === 401 && /Basic/.test(challenge ?? '') && /realm="lares"/.test(challenge ?? ''), `${naked.status} · www-authenticate: ${challenge}`);
  await naked.body?.cancel();

  const credentialled = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic }, body: '{"message":"direct"}' });
  record('1c session with eve:<password>', credentialled.ok, `${credentialled.status} · x-eve-session-id ${credentialled.headers.get('x-eve-session-id')}`);
  await credentialled.body?.cancel();

  // ── 2. a full turn through the REAL forwardChat ──────────────────────────────────────────────
  calls = [];
  const created = await viaProxy('POST', 'eve/v1/session', { body: JSON.stringify({ message: 'greet me' }) });
  const createdText = await created.text();
  seenBodies.push(createdText);
  const sessionId = created.headers.get('x-eve-session-id') ?? JSON.parse(createdText).sessionId;
  record('2a create a session through the proxy', created.ok && typeof sessionId === 'string' && sessionId.length > 0, `${created.status} accepted · session ${sessionId} · ${calls.length} upstream call(s)`);

  const turn = await followProxiedStream(sessionId, 0);
  const turnText = turn.map((l) => l.raw).join('\n');
  record('2b a full scripted turn comes back', turnText.includes('DONE:greet me') && turn.some((l) => isTerminal(l.event)), `${turn.length} lines over ${new Set(turn.map((l) => l.connection)).size} connection(s), last ${lastTypes(turn)}, reply "DONE:greet me" seen`);

  // ── 5. streaming is incremental (measured on a turn that takes real time) ─────────────────────
  // The stream is opened FIRST and held, then the message is sent: a reader that attaches after a
  // batch already exists is served that batch and the connection closes, which measures nothing.
  const slowFrom = turn.filter((l) => isStored(l.event)).length;
  const held = await openProxiedStream(sessionId, { startIndex: slowFrom, includeTailIndex: false });
  const heldOpenedAt = Date.now();
  const reading = readStream(held, { timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 250));
  const sentAt = Date.now();
  const slowAccepted = await viaProxy('POST', `eve/v1/session/${sessionId}`, { body: JSON.stringify({ message: 'take your time' }) });
  seenBodies.push(await slowAccepted.text());
  const live = await reading;
  const rest = live.some((l) => isTerminal(l.event)) ? [] : await followProxiedStream(sessionId, slowFrom + live.filter((l) => isStored(l.event)).length);
  const slow = [...live, ...rest];
  // Measured on STORED lines only. eve 1.0 opens a held stream with a `$eve` heartbeat, a transport
  // record that is sent the moment the connection opens, before any message: it says nothing about
  // whether the turn's own events are buffered, and counting it would make the first line arrive
  // before the message was sent.
  const liveStored = live.filter((l) => isStored(l.event));
  const firstLineAt = liveStored.length > 0 ? heldOpenedAt + liveStored[0].at - sentAt : -1;
  const turnEndedAt = Date.now() - sentAt;
  const span = liveStored.length > 1 ? liveStored.at(-1).at - liveStored[0].at : 0;
  record('5 streaming is incremental, not buffered',
    liveStored.length > 1 && span > 500 && firstLineAt >= 0 && turnEndedAt - firstLineAt > 500,
    `ONE held-open connection delivered ${liveStored.length} stored lines (plus ${live.length - liveStored.length} transport record(s), first ${JSON.stringify(typesOf(live[0]?.event))}) spread over ${span}ms; its first stored line reached the reader +${firstLineAt}ms after the message was sent, the turn ended +${turnEndedAt}ms after it (a 1500ms tool ran in between)`);

  // ── 4. a reconnecting stream ─────────────────────────────────────────────────────────────────
  // The session's stream is a replayable log, so the SAME turn can be read whole and then read in
  // two halves: that is an uninterrupted run to compare against, not a second turn.
  // Only STORED lines have a position and are compared; a transport record (a heartbeat, the note
  // that a bounded read ended) is not part of the log and may differ between two reads.
  const stored = (lines) => lines.filter((l) => isStored(l.event));
  const whole = stored(await readStream(await openProxiedStream(sessionId, { startIndex: slowFrom })));
  const cut = Math.max(1, Math.floor(whole.length / 2));
  const dropped = new AbortController();
  const head = stored(await readStream(
    await openProxiedStream(sessionId, { startIndex: slowFrom, signal: dropped.signal }),
    { lines: cut, untilTerminal: false },
  ));
  dropped.abort();
  const tail = stored(await readStream(await openProxiedStream(sessionId, { startIndex: slowFrom + head.length })));
  const rejoined = [...head, ...tail].map((l) => l.raw);
  const reference = whole.map((l) => l.raw);
  record('4 a dropped stream resumes with nothing lost or repeated',
    head.length >= 1 && head.length <= cut && whole.length > head.length && rejoined.length === reference.length && rejoined.every((line, i) => line === reference[i]),
    `${reference.length} stored lines whole · dropped after ${head.length} · resumed at startIndex=${slowFrom + head.length} · ${tail.length} more · sequences identical`);

  // ── 6. the refusals, each with ZERO upstream requests ─────────────────────────────────────────
  calls = [];
  const noSession = await viaProxy('POST', 'eve/v1/session', { body: JSON.stringify({ message: 'hello' }), signedIn: false });
  seenBodies.push(await noSession.text());
  record('6a no console session', noSession.status === 401 && calls.length === 0, `${noSession.status} · ${calls.length} upstream call(s)`);

  // An agent nobody granted this member is refused by the access check, which now runs BEFORE the
  // registry lookup (`requireConsoleAgentUse`), so a name the console has never heard of answers
  // 403, not 404 as on eve 0.60. The registry's own 404 is the next case: a granted agent whose
  // registry row is not ready.
  calls = [];
  const unknown = await forwardChat(new Request('https://console.example.invalid/api/chat/nobody/eve/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"hello"}' }), 'nobody', 'eve/v1/session', deps());
  observe(unknown, 'POST unknown agent');
  seenBodies.push(await unknown.text());
  const unknownCalls = calls.length;
  calls = [];
  await authDb.query('UPDATE agent_resources SET pending=true WHERE name=$1', [AGENT]);
  const notReady = await viaProxy('POST', 'eve/v1/session', { body: JSON.stringify({ message: 'hello' }) });
  seenBodies.push(await notReady.text());
  await authDb.query('UPDATE agent_resources SET pending=false WHERE name=$1', [AGENT]);
  record('6b an unknown agent name, and a granted agent the registry cannot vouch for',
    unknown.status === 403 && unknownCalls === 0 && notReady.status === 404 && notReady.headers.get('x-lares-agent-state') !== null && calls.length === 0,
    `unknown name → ${unknown.status}/${unknownCalls} call(s) · registered but not ready → ${notReady.status} (${notReady.headers.get('x-lares-agent-state')})/${calls.length} call(s)`);

  const offList = [];
  for (const path of ['eve/v1/mcp', 'eve/v1/dev/runtime-artifacts', 'eve/v1/dev/schedules/probe-tick', `eve/v1/session/${sessionId}/subagents/x/y/stream`]) {
    calls = [];
    const refused = await viaProxy('POST', path, { body: '{}' });
    seenBodies.push(await refused.text());
    offList.push({ path, status: refused.status, calls: calls.length });
  }
  record('6c a path outside the allow-list', offList.every((r) => r.status === 404 && r.calls === 0), offList.map((r) => `${r.path} → ${r.status}/${r.calls} call(s)`).join(' · '));

  // ── 3. eve's OWN browser client, through a server whose only job is forwardChat ───────────────
  const bridgePort = await freePort();
  const PREFIX = `/api/chat/${AGENT}/`;
  bridge = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url, 'https://console.example.invalid');
        if (!url.pathname.startsWith(PREFIX)) { res.writeHead(404).end('Not found'); return; }
        const path = url.pathname.slice(PREFIX.length);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
        headers.delete('host');
        headers.delete('connection');
        // This server stands in for the browser's cookie jar as well as the console route: eve's
        // `Client` runs in Node here and keeps no cookies, where a browser would send the
        // conversation cookie the proxy set on create.
        const cookie = cookieFor(url.pathname);
        if (cookie) headers.set('cookie', cookie);
        const chunks = [];
        if (req.method !== 'GET' && req.method !== 'HEAD') for await (const chunk of req) chunks.push(chunk);
        const request = new Request(url, { method: req.method, headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) });
        const response = observe(await forwardChat(request, AGENT, path, deps()), `client ${req.method} ${path}`);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) for await (const chunk of response.body) res.write(Buffer.from(chunk));
        res.end();
      } catch (error) {
        if (!res.headersSent) res.writeHead(502);
        res.end(String(error));
      }
    })();
  });
  await new Promise((done) => bridge.listen(bridgePort, '127.0.0.1', done));

  calls = [];
  const client = new Client({ baseUrl: `http://127.0.0.1:${bridgePort}${PREFIX.slice(0, -1)}` });
  const opened = await client.sessions.create({ message: 'greet me' });
  const answered = await opened.delivery.result();
  const answeredText = JSON.stringify(answered);
  seenBodies.push(answeredText);
  record('3 eve\'s own Client completes a turn through the proxy', answeredText.includes('DONE:greet me'), `${calls.length} upstream call(s) · reply carried back to the client`);

  // ── 7. what an approval looks like ON THE WIRE ────────────────────────────────────────────────
  const gatedCreated = await viaProxy('POST', 'eve/v1/session', { body: JSON.stringify({ message: 'ask me first' }) });
  seenBodies.push(await gatedCreated.text());
  const gatedId = gatedCreated.headers.get('x-eve-session-id');
  const gated = await followProxiedStream(gatedId, 0);
  for (const line of gated) {
    const found = factsOf(line.event).some((f) => f.type === 'interaction.opened' && f.data?.request?.kind === 'approval');
    if (found) wire.inputRequestEvents.push(line.event);
  }
  wire.terminalEvent = gated.at(-1)?.event ?? null;
  const gatedText = gated.map((l) => l.raw).join('\n');
  const titleOnWire = /Send email to first@example\.invalid and 1 more/.test(gatedText);
  // The DETAILS block is `mailDetails` — `*To:* …` mrkdwn. Tested for the RENDERED text, never for
  // the body string, which also appears verbatim inside the call's `input` and would read as a
  // false positive.
  const detailsOnWire = /\*To:\*/.test(gatedText);
  record('7 an approval reaches the browser as an approval interaction',
    wire.inputRequestEvents.length > 0 && titleOnWire,
    `${wire.inputRequestEvents.length} line(s) carry an opened interaction of kind "approval" · one-line title on the wire: ${titleOnWire} · rendered DETAILS text on the wire: ${detailsOnWire}`);
  wire.detailsOnWire = detailsOnWire;
  wire.titleOnWire = titleOnWire;

  // ── 2c. nothing the browser ever sees carries the credential ──────────────────────────────────
  const leakedHeader = seenHeaders.find((entry) => Object.values(entry.headers).some((value) => String(value).includes(PASSWORD)) || 'www-authenticate' in entry.headers || ('set-cookie' in entry.headers && !entry.capabilityCookie));
  const leakedBody = seenBodies.find((body) => String(body).includes(PASSWORD));
  const issued = seenHeaders.filter((entry) => entry.capabilityCookie);
  record('2c no response carries the challenge, an upstream cookie or the password',
    leakedHeader === undefined && leakedBody === undefined,
    `${seenHeaders.length} response header sets and ${seenBodies.length} body chunks checked · the only set-cookie seen: the proxy's own conversation cookie, on ${issued.length} successful create(s) (${[...new Set(issued.map((e) => e.where))].join(', ')})`);

  // ── the results file ──────────────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n| item | verdict | evidence |\n| --- | --- | --- |`);
  for (const r of results) console.log(`| ${r.item} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.say} |`);
  console.log(`\nallow-listed paths: ${CHAT_PATHS.length} · run took ${elapsed}s`);
  console.log(`\nThe approval, verbatim from the stream:\n${wire.inputRequestEvents.map((e) => JSON.stringify(e, null, 2)).join('\n')}`);

  if (process.env.WEB_CHAT_PROOF_OUT) {
    writeFileSync(process.env.WEB_CHAT_PROOF_OUT, [
      '| item | verdict | evidence |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.item} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.say} |`),
      '',
      '```json',
      wire.inputRequestEvents.map((e) => JSON.stringify(e, null, 2)).join('\n'),
      '```',
      '',
      '```json',
      JSON.stringify(wire.terminalEvent, null, 2),
      '```',
      '',
    ].join('\n'));
  }
  console.log(results.every((r) => r.ok) ? `\nWEB CHAT PROOF: PASS (${elapsed}s)` : `\nWEB CHAT PROOF: FAIL`);
} finally {
  try {
    if (bridge) await new Promise((done) => bridge.close(done));
  } finally {
    try {
      if (door?.pid) { try { process.kill(-door.pid, 'SIGKILL'); } catch { try { door.kill('SIGKILL'); } catch {} } }
      await new Promise((r) => setTimeout(r, 300));
      if (!process.env.WEB_CHAT_PROOF_KEEP) app?.dispose();
      else console.log(`kept: ${app?.root}`);
      // eve 1.0 may leave a session sandbox behind its server. Remove only this run's, by label.
      for (const id of new Set(seenHeaders.map((e) => e.headers['x-eve-session-id']).filter(Boolean))) {
        try {
          const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'label=eve.sandbox=1', '--filter', `label=eve.sandbox.tag.sessionId=${id}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
          if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
        } catch { console.warn(`sandbox cleanup needs attention for ${id}`); }
      }
    } finally {
      try { await authDb?.end(); await db?.end(); } finally { await container?.stop(); }
    }
  }
}
