/**
 * web-chat-approval-proof.mjs — is an approval answered in web chat really answered by a PERSON?
 *
 * W8B-s5 created a new class of approver. The wave-7 lesson is why this file exists: three
 * controls in a row were wrong or dead in ways only a real run showed — `callIdFrom` read a field
 * eve does not set, so the payload check never ran at all. Every claim below therefore depends on
 * what the FRAMEWORK actually puts in `ctx.session.auth`, and none of it is asserted against a
 * hand-built context.
 *
 * WHAT IS REAL IN THIS RUN. A real eve 0.60.1 process (`eve build` + `eve start`), a real
 * Postgres, the REAL console proxy (`forwardChat`, imported — Node 24 strips the types off a `.ts`
 * module on import, so there is no copy to drift), and — the point of this proof — the REAL door
 * and the REAL approver check: `services/chief-of-staff/agent/channels/eve.ts`,
 * `lib/approvals.ts` and `lib/principals.ts` are COPIED BYTE FOR BYTE into the disposable fixture
 * at run time and imported there. Nothing in this file re-implements any of them, and the copy is
 * asserted identical to the source before the run starts. Only the model is scripted (the
 * package's own `mockModel`) — no credential, no gateway, no money.
 *
 * WHAT IS PROVED, each item empirical:
 *   1 the shape       `ctx.session.auth` inside the gated tool's `execute`, recorded verbatim, and
 *                     run through the REAL `approverFrom` in this process
 *   2 an approver     an answer from an ALLOWED signed-in address executes the tool
 *   3 a stranger      an answer from a signed-in address that is NOT an approver is refused and
 *                     the tool does not run
 *   4 a forged header a browser-supplied `x-lares-member` is stripped; the agent sees the real
 *                     signed-in address
 *   5 a forged body   eve answers 403 to a `forwardedPrincipal` body field, because no role's door
 *                     declares `trustedForwarders` — so the body lane is closed too
 *   6 no member       a route-password holder that asserts no member is not an approver
 *
 * Run: `pnpm -C packages/board-evals run proof:web-chat-approval` (Docker running). One eve
 * process at a time; the container, the process group and every temporary directory are disposed
 * in `finally`. Results: `packages/board-evals/proofs/web-chat-approval-2026-09-20.md`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { makeApp, run, source, abort, ensureProbeExtensionBuilt } from './proof-harness.mjs';
// The REAL proxy and the REAL approver check. Not copies, not re-implementations.
import { forwardChat, ROUTE_USERNAME, MEMBER_HEADER } from '../../../services/console/lib/chat-proxy.ts';
// `lib/principals.ts` is imported here as well as run inside the fixture, so item 1 resolves the
// recorded context with the SHIPPED code rather than a paraphrase. `lib/approvals.ts` is NOT
// imported into this process: Node's strip-only TypeScript cannot parse its `constructor(readonly
// approver: string)` parameter property (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). That costs nothing
// here — `approverFrom` and `assertApprover` are what the fixture's gated tool calls for real on
// every item below, compiled by `eve build`, which is the only place their behaviour matters.
// For a context whose `auth.current` is present, `approverFrom` IS `principalFromAuth(auth.current)`.
import { isAllowedPrincipalId, principalFromAuth, CONSOLE_AUTHENTICATOR } from '../../../services/chief-of-staff/lib/principals.ts';

const AGENT = 'board-evals';
const REGISTRY_ADDRESS = '10.0.0.7';
const PASSWORD = 'disposable-fixture-only';
const INCARNATION = '11111111-1111-4111-8111-111111111111';
/** The one address on the agent's console allow-list. */
const OWNER = 'owner@example.invalid';
/** Signed in to the console, and NOT an approver on this agent. The whole of item 3. */
const STRANGER = 'stranger@example.invalid';
/** What a browser would put in the header if it could. It must never reach the agent. */
const FORGED = 'attacker@example.invalid';
const TERMINAL = new Set(['session.completed', 'session.failed', 'session.waiting']);

/** The real files the fixture runs. Copied, never re-written: this proof is worthless if it tests
 *  a paraphrase of the door. */
const REAL = [
  ['services/chief-of-staff/agent/channels/eve.ts', 'agent/channels/eve.ts'],
  ['services/chief-of-staff/lib/approvals.ts', 'lib/approvals.ts'],
  ['services/chief-of-staff/lib/principals.ts', 'lib/principals.ts'],
];

/**
 * The gated tool. Its `execute` does two things that matter: it records `ctx.session.auth`
 * verbatim (item 1 — nobody has seen what the HTTP door really puts there after a resume), and it
 * calls the REAL `assertApprover(approverFrom(...))` before it has any effect at all. "The tool
 * ran" is a line in a file that only appears AFTER that check returns.
 */
const GATED_TOOL_SRC = `
import { appendFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { approverFrom, assertApprover } from "../../lib/approvals.js";

export default defineTool({
  description: "Send mail (proof fixture, shaped like the real tool).",
  inputSchema: z.object({
    from: z.string(),
    to: z.array(z.string()).min(1),
    subject: z.string(),
    bodyText: z.string(),
  }),
  approval: always(),
  execute: async (input: unknown, ctx: { session?: { auth?: unknown } }) => {
    appendFileSync(process.env.BOARD_EVENTS!, JSON.stringify({ at: "execute", auth: ctx?.session?.auth ?? null }) + "\\n");
    // The REAL check, in the REAL order a gated catalogue tool uses it (W7A-s6's assertApproval
    // calls assertApprover first, then the ledger; the ledger half is unchanged by this slice and
    // proved by approval-binding-proof.mjs).
    try {
      assertApprover(approverFrom(ctx?.session?.auth));
    } catch (error) {
      appendFileSync(process.env.BOARD_LOG!, "refused: " + String(error && (error as Error).message) + "\\n");
      throw error;
    }
    appendFileSync(process.env.BOARD_LOG!, "sent\\n");
    return { sent: true };
  },
});
`;

/** One scripted case: the message that makes the model call the gated tool. Four recipients, so
 *  the card's own title abbreviates ("and 3 more") and the browser must show the rest. */
const CHAT_CASES = {
  'ask me first': {
    tool: 'gmail_send',
    input: {
      from: 'agent@example.invalid',
      to: ['first@example.invalid', 'second@example.invalid', 'third@example.invalid', 'fourth@example.invalid'],
      subject: 'The quarterly note',
      bodyText: 'Here is the note you asked for.',
    },
  },
};

const INSTRUMENTATION_SRC = `
import { defineInstrumentation } from "eve/instrumentation";
import { registerApprovalSummary } from "@lares/agent-kit/approval-summary";

export default defineInstrumentation({ setup: () => { registerApprovalSummary(); } });
`;

function patchScriptedModel(root) {
  const file = join(root, 'agent/agent.ts');
  let text = readFileSync(file, 'utf8');
  const anchorTop = 'const acted = new Set<string>();';
  const anchorTool = 'const tool = msg.startsWith("write")';
  assert.ok(text.includes(anchorTop), 'agent/agent.ts no longer declares `acted` — re-anchor the patch');
  assert.ok(text.includes(anchorTool), 'agent/agent.ts no longer dispatches on "write" — re-anchor the patch');
  text = text.replace(
    anchorTop,
    `${anchorTop}\n\n// Added by scripts/web-chat-approval-proof.mjs in a disposable copy of this package.\nconst CHAT_CASES: Record<string, { tool: string; input: Record<string, unknown> }> = ${JSON.stringify(CHAT_CASES, null, 2)};\n`,
  );
  text = text.replace(
    anchorTool,
    `const chat = CHAT_CASES[msg];\n  if (chat) {\n    return toolResults.some((r) => r.name === chat.tool)\n      ? \`DONE:\${msg}\`\n      : { toolCalls: [{ name: chat.tool, input: chat.input }] };\n  }\n\n  ${anchorTool}`,
  );
  writeFileSync(file, text);
}

/** Copy the real door, the real approvals and the real principals into the fixture, and assert
 *  the copy is byte-identical to what the repository ships. */
function installRealFiles(root) {
  const copied = [];
  for (const [from, to] of REAL) {
    const text = readFileSync(resolve(source, '../..', from), 'utf8');
    const target = join(root, to);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
    assert.equal(readFileSync(target, 'utf8'), text, `${to} was not copied verbatim`);
    copied.push({ from, bytes: text.length });
  }
  return copied;
}

function fitOut(root) {
  patchScriptedModel(root);
  mkdirSync(join(root, 'agent/channels'), { recursive: true });
  writeFileSync(join(root, 'agent/instrumentation.ts'), INSTRUMENTATION_SRC);
  writeFileSync(join(root, 'agent/tools/gmail_send.ts'), GATED_TOOL_SRC);
  return installRealFiles(root);
}

async function seed(uri) {
  const pool = new Pool({ connectionString: uri });
  try {
    for (const name of ['039_agent_definitions.sql', '042_agent_resources.sql', '044_agent_door_connections.sql', '045_agent_runtime_control.sql'])
      await pool.query(readFileSync(resolve(source, '../../services/box/sql', name), 'utf8'));
    await pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
      VALUES ('${AGENT}','${REGISTRY_ADDRESS}','synthetic-unused','owned','${INCARNATION}','${INCARNATION}','ready',false)`);
  } finally {
    await pool.end();
  }
}

// ─── instruments ───────────────────────────────────────────────────────────────────────────────

const results = [];
const record = (item, ok, say) => { results.push({ item, ok, say }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${say}`); if (!ok) process.exitCode = 1; };

let calls = [];
let port;

/** The injected fetch: assert the address and the credential the proxy built, RECORD the member
 *  header it set, then re-issue the same request against the loopback port the fixture is on. */
async function boundFetch(url, init) {
  const prefix = `http://${REGISTRY_ADDRESS}:3000/`;
  const text = String(url);
  const headers = new Headers(init?.headers ?? {});
  calls.push({ url: text, method: init?.method, member: headers.get(MEMBER_HEADER) });
  assert.ok(text.startsWith(prefix), `the proxy addressed ${text}, not the registry's ${prefix}`);
  assert.equal(headers.get('authorization'), `Basic ${Buffer.from(`${ROUTE_USERNAME}:${PASSWORD}`).toString('base64')}`, 'the upstream Authorization header is not the door credential');
  return await fetch(`http://127.0.0.1:${port}/${text.slice(prefix.length)}`, init);
}

function deps({ email = OWNER } = {}) {
  return {
    signedInEmail: async () => email,
    routePassword: () => PASSWORD,
    query: async (_sql, values) => ({
      rows: values[0] === AGENT
        ? [{ address: REGISTRY_ADDRESS, state: 'ready', status: 'valid', runtime_control_token: INCARNATION, incarnation: INCARNATION, role: 'chief-of-staff' }]
        : [],
    }),
    fetch: boundFetch,
  };
}

/** One browser request through the real `forwardChat`. `forgeMember` is what a hostile page would
 *  put on the request; the proxy must throw it away. */
async function viaProxy(method, path, { body, query = '', email = OWNER, forgeMember, forgeBody } = {}) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (forgeMember !== undefined) headers[MEMBER_HEADER] = forgeMember;
  const init = { method, headers };
  if (body !== undefined) init.body = forgeBody === undefined ? body : JSON.stringify({ ...JSON.parse(body), forwardedPrincipal: forgeBody });
  const request = new Request(`https://console.example.invalid/api/chat/${AGENT}/${path}${query}`, init);
  return await forwardChat(request, AGENT, path, deps({ email }));
}

async function readStream(response, { timeoutMs = 60000 } = {}) {
  const out = [];
  if (!response.body) return out;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (raw.trim() === '') continue;
        let event;
        try { event = JSON.parse(raw); } catch { event = { type: '<unparsed>', raw }; }
        out.push(event);
        if (TERMINAL.has(event.type)) return out;
      }
    }
  } catch (error) {
    if (!/abort/i.test(String(error))) throw error;
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => {});
  }
  return out;
}

const RETRYABLE = new Set([404, 409, 425, 500, 502, 503, 504]);

async function openStream(sessionId, startIndex) {
  const query = `?streamControlVersion=1${startIndex === 0 ? '' : `&startIndex=${startIndex}`}`;
  let last;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await viaProxy('GET', `eve/v1/session/${sessionId}/stream`, { query });
    if (last.ok) return last;
    if (!RETRYABLE.has(last.status)) break;
    await last.text();
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return last;
}

/** Follow a session's stream from `startIndex` until it goes terminal. */
async function follow(sessionId, startIndex, { deadlineMs = 45000 } = {}) {
  const began = Date.now();
  const events = [];
  let index = startIndex;
  while (Date.now() - began < deadlineMs) {
    const response = await openStream(sessionId, index);
    if (!response.ok) { await response.text(); break; }
    const batch = await readStream(response);
    events.push(...batch);
    index += batch.length;
    if (batch.length > 0 && TERMINAL.has(batch.at(-1).type)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { events, next: index };
}

/** The first pending card in a batch of events. */
function cardIn(events) {
  for (const event of events) {
    if (event.type !== 'input.requested') continue;
    for (const request of event.data?.requests ?? []) if (request.kind === 'tool-approval') return request;
  }
  return null;
}

const readLines = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== ''); } catch { return []; } };

// ─── the run ───────────────────────────────────────────────────────────────────────────────────

let container, db, door, app;
const wire = { sessionAuth: null, card: null };
const startedAt = Date.now();
try {
  await ensureProbeExtensionBuilt();
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  const uriFor = (name) => container.getConnectionUri().replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
  await db.query('CREATE DATABASE webchatapproval');
  await seed(uriFor('webchatapproval'));

  app = makeApp(uriFor('webchatapproval'), '0');
  const { root: cwd, env, eve } = app;
  env.EVE_ROUTE_PASSWORD_FILE = join(cwd, 'route-password');
  writeFileSync(env.EVE_ROUTE_PASSWORD_FILE, `${PASSWORD}\n`);
  // The agent's own console allow-list. `makeApp` sets LARES_AGENT_INCARNATION, so the managed
  // key is the one `allowedPrincipalIds` reads — exactly as on a keeper-run box.
  env.LARES_CONSOLE_PRINCIPAL = OWNER;
  const copied = fitOut(cwd);
  console.log(`real files in the fixture: ${copied.map((c) => `${c.from} (${c.bytes}B)`).join(', ')}`);

  let mark = Date.now();
  await run(eve, ['build'], { cwd, env });
  console.log(`fixture built in ${((Date.now() - mark) / 1000).toFixed(1)}s`);

  port = await new Promise((done) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => done(p)); });
  });
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

  /** Park one card in a fresh session, answer it as `email`, and report what happened. */
  async function parkAndAnswer(label, { email, forgeMember, forgeBody } = {}) {
    const before = readLines(env.BOARD_LOG).length;
    const created = await viaProxy('POST', 'eve/v1/session', { body: JSON.stringify({ message: 'ask me first' }), email, forgeMember });
    await created.text();
    const sessionId = created.headers.get('x-eve-session-id');
    assert.ok(sessionId, `${label}: no session id came back`);
    const parked = await follow(sessionId, 0);
    const card = cardIn(parked.events);
    assert.ok(card, `${label}: no approval card was parked\n${JSON.stringify(parked.events).slice(0, 800)}`);
    if (wire.card === null) wire.card = card;

    // The answer: eve's own `respond` body, for the requestId from the card — NOT the tool call id.
    const answered = await viaProxy('POST', `eve/v1/session/${sessionId}`, {
      body: JSON.stringify({ inputResponses: [{ requestId: card.requestId, optionId: 'approve' }] }),
      email,
      forgeMember,
      forgeBody,
    });
    const answerBody = await answered.text();
    const after = answered.ok ? await follow(sessionId, parked.next) : { events: [] };
    const lines = readLines(env.BOARD_LOG).slice(before);
    return { card, status: answered.status, answerBody, events: after.events, lines, sessionId };
  }

  // ── 2 + 1. an ALLOWED signed-in address answers ───────────────────────────────────────────────
  const allowed = await parkAndAnswer('allowed', {});
  const executes = readLines(env.BOARD_EVENTS).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.at === 'execute');
  wire.sessionAuth = executes.at(-1)?.auth ?? null;
  record('2 an answer from an allowed signed-in address executes the tool',
    allowed.status === 202 && allowed.lines.includes('sent'),
    `answer accepted ${allowed.status} · the tool's own log says ${JSON.stringify(allowed.lines)} · requestId ${allowed.card.requestId} (the tool call id is ${allowed.card.action?.callId})`);

  // ── 1. what `ctx.session.auth` really is, and what the REAL approverFrom makes of it ──────────
  const managedEnv = { LARES_AGENT_INCARNATION: INCARNATION, LARES_CONSOLE_PRINCIPAL: OWNER };
  const resolved = principalFromAuth(wire.sessionAuth?.current);
  record('1 ctx.session.auth inside execute is what approverFrom expects',
    wire.sessionAuth?.current?.authenticator === CONSOLE_AUTHENTICATOR
      && wire.sessionAuth?.current?.attributes?.user_id === OWNER
      && resolved.authenticator === CONSOLE_AUTHENTICATOR
      && resolved.userId === OWNER
      && isAllowedPrincipalId('console', resolved.userId, managedEnv),
    `auth.current.authenticator="${wire.sessionAuth?.current?.authenticator}" · attributes.user_id="${wire.sessionAuth?.current?.attributes?.user_id}" · principalId="${wire.sessionAuth?.current?.principalId}" · the shipped principalFromAuth resolved {authenticator:"${resolved.authenticator}", userId:"${resolved.userId}"} and the allow-list accepts it`);

  // ── 3. a signed-in address that is NOT an approver ────────────────────────────────────────────
  const stranger = await parkAndAnswer('stranger', { email: STRANGER });
  record('3 an answer from a signed-in address that is not an approver is refused, and nothing runs',
    !stranger.lines.includes('sent') && stranger.lines.some((l) => l.startsWith('refused:')),
    `answer accepted ${stranger.status} (the console let them in; the AGENT did not) · the tool's own log says ${JSON.stringify(stranger.lines.map((l) => l.slice(0, 90)))}`);

  // ── 4. a browser-forged identity header ───────────────────────────────────────────────────────
  calls = [];
  const forged = await parkAndAnswer('forged', { email: OWNER, forgeMember: FORGED });
  const membersSent = [...new Set(calls.map((c) => c.member))];
  const forgedExecutes = readLines(env.BOARD_EVENTS).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.at === 'execute');
  const forgedAuth = forgedExecutes.at(-1)?.auth ?? null;
  record('4 a browser-forged member header is stripped; the agent sees the real signed-in address',
    membersSent.length === 1 && membersSent[0] === OWNER && forged.lines.includes('sent')
      && forgedAuth?.current?.attributes?.user_id === OWNER,
    `the browser sent "${FORGED}" on every request; the proxy put ${JSON.stringify(membersSent)} on all ${calls.length} upstream calls · the tool saw user_id="${forgedAuth?.current?.attributes?.user_id}"`);

  // ── 5. a browser-forged identity in the BODY ──────────────────────────────────────────────────
  // eve's own `forwardedPrincipal` field is the designed way for a trusted proxy to assert an
  // identity — and no role's door declares `trustedForwarders`, so eve refuses it outright. This
  // is why the proxy does not have to parse the body it relays.
  const body = await viaProxy('POST', 'eve/v1/session', {
    body: JSON.stringify({ message: 'ask me first' }),
    forgeBody: { current: { attributes: { user_id: FORGED }, authenticator: CONSOLE_AUTHENTICATOR, principalId: FORGED, principalType: 'user' } },
  });
  const bodyText = await body.text();
  record('5 an identity smuggled in the request BODY is refused by eve itself',
    body.status === 403 && /forwarded principal/i.test(bodyText),
    `${body.status} · ${bodyText.slice(0, 140)}`);

  // ── 6. the route password alone is not an approver ────────────────────────────────────────────
  // The keeper and any operator hold the password. Without a member header they get `http-basic`,
  // which is not a channel — so they can open a session and approve nothing.
  const created = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${ROUTE_USERNAME}:${PASSWORD}`).toString('base64')}` },
    body: JSON.stringify({ message: 'ask me first' }),
  });
  await created.text();
  const bareId = created.headers.get('x-eve-session-id');
  const bareBefore = readLines(env.BOARD_LOG).length;
  const bareParked = await follow(bareId, 0);
  const bareCard = cardIn(bareParked.events);
  let bareStatus = 0;
  if (bareCard) {
    const bareAnswer = await fetch(`http://127.0.0.1:${port}/eve/v1/session/${bareId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${ROUTE_USERNAME}:${PASSWORD}`).toString('base64')}` },
      body: JSON.stringify({ inputResponses: [{ requestId: bareCard.requestId, optionId: 'approve' }] }),
    });
    bareStatus = bareAnswer.status;
    await bareAnswer.text();
    await follow(bareId, bareParked.next);
  }
  const bareLines = readLines(env.BOARD_LOG).slice(bareBefore);
  const bareExecutes = readLines(env.BOARD_EVENTS).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.at === 'execute');
  record('6 the route password on its own approves nothing',
    bareCard !== null && !bareLines.includes('sent') && bareLines.some((l) => l.startsWith('refused:')),
    `answered ${bareStatus} with the credential and NO member header · the door stamped authenticator="${bareExecutes.at(-1)?.auth?.current?.authenticator}" · the tool's own log says ${JSON.stringify(bareLines.map((l) => l.slice(0, 90)))}`);

  // ── the results file ──────────────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n| item | verdict | evidence |\n| --- | --- | --- |`);
  for (const r of results) console.log(`| ${r.item} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.say} |`);
  console.log(`\nctx.session.auth inside execute, verbatim:\n${JSON.stringify(wire.sessionAuth, null, 2)}`);

  if (process.env.WEB_CHAT_APPROVAL_PROOF_OUT) {
    writeFileSync(process.env.WEB_CHAT_APPROVAL_PROOF_OUT, [
      '| item | verdict | evidence |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.item} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.say} |`),
      '',
      '`ctx.session.auth` inside the gated tool\'s `execute`, verbatim:',
      '',
      '```json',
      JSON.stringify(wire.sessionAuth, null, 2),
      '```',
      '',
      'The card it answered, verbatim:',
      '',
      '```json',
      JSON.stringify(wire.card, null, 2),
      '```',
      '',
      `run took ${elapsed}s`,
      '',
    ].join('\n'));
  }
  console.log(results.every((r) => r.ok) ? `\nWEB CHAT APPROVAL PROOF: PASS (${elapsed}s)` : `\nWEB CHAT APPROVAL PROOF: FAIL`);
} finally {
  try {
    if (door?.pid) { try { process.kill(-door.pid, 'SIGKILL'); } catch { try { door.kill('SIGKILL'); } catch {} } }
    await new Promise((r) => setTimeout(r, 300));
    if (!process.env.WEB_CHAT_APPROVAL_PROOF_KEEP) app?.dispose();
    else console.log(`kept: ${app?.root}`);
  } finally {
    try { await db?.end(); } finally { await container?.stop(); }
  }
}
