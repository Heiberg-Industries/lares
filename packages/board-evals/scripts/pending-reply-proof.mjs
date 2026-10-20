/**
 * pending-reply-proof.mjs — what does eve 0.60.1 do when a person types while an approval card is
 * still waiting?
 *
 * Five questions, each answered by watching a real run, none by reading a doc:
 *   (a) a plain text reply during a pending card: does it run a turn, and what does the model see?
 *   (b) typed "approve" / "1" / "Approve" on the HTTP route (the route web chat uses): must NOT approve (asserted)
 *   (c) can our own code cancel a pending request with an `inputResponses` cancel, so the tool never runs?
 *   (d) a second card for the same tool while the first waits: does approving the first still run it?
 *   (e) with the REAL approval-record and approval-supersede hooks loaded: a revised proposal in a
 *       later turn raises a new card; is the older card cancelled by our hook (sent while that turn is
 *       still running), never executed, recorded cancelled/revised, with the new card live?
 *
 * REAL: an eve 0.60.1 process (`eve build` + `eve start`), a disposable Postgres, eve's own session
 * routes. SCRIPTED: the model (the package's `mockModel`, patched in a disposable copy). No
 * credential, no gateway, no network beyond loopback, no money. The Slack card repaint is NOT
 * observed here (no Slack in the fixture); that part can only be described from eve's docs/code.
 *
 * Run: `pnpm -C packages/board-evals run proof:pending-reply` (Docker running). Set
 * PENDING_REPLY_PROOF_OUT=<file> to write the raw evidence as JSON.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { makeApp, run, source } from './proof-harness.mjs';

const AGENT = 'board-evals';
const INCARNATION = '11111111-1111-4111-8111-111111111111';
const TERMINAL = new Set(['session.completed', 'session.failed', 'session.waiting']);

const GATED_TOOL_SRC = `
import { appendFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Send mail (proof fixture).",
  inputSchema: z.object({ tag: z.string() }),
  approval: always(),
  execute: async ({ tag }: { tag: string }) => {
    appendFileSync(process.env.BOARD_LOG!, "sent:" + tag + "\\n");
    return { sent: tag };
  },
});
`;

// "pr:send X" calls pr_send({tag:X}) once per distinct text; every other text just gets a plain
// answer. Every model call is logged with everything the model was handed.
const MODEL_PATCH = `
{
  const view = {
    at: "model-call",
    lastUserMessage: msg,
    userMessageCount,
    messages: messages.map((m: any) => ({ ...m, text: typeof m.text === "string" ? m.text.slice(0, 1500) : m.text })),
    toolResults,
    tools: tools.map((t) => t.name),
  };
  appendFileSync(process.env.PROOF_MODEL_LOG!, JSON.stringify(view) + "\\n");
}
if (msg.startsWith("pr:send ")) {
  if (!acted.has(msg)) {
    acted.add(msg);
    return { toolCalls: [{ name: "pr_send", input: { tag: msg.slice("pr:send ".length) } }] };
  }
  return \`DONE:\${msg}\`;
}
`;

// The two real hooks, registered as the roles register them. The one difference: the cancel is
// aimed at this run's loopback port (a role's eve listens on 3000 in its container).
const hookSrc = (port) => ({
  record: `import { defineHook } from "eve/hooks";
import { makeApprovalRecord } from "@lares/agent-kit/approval-record-hook";
const live = makeApprovalRecord();
export default defineHook({ events: { "input.requested": live["input.requested"] as any, "input.resolved": live["input.resolved"] as any } });
`,
  supersede: `import { defineHook } from "eve/hooks";
import { makeApprovalSupersede, cancelApprovalRequest } from "@lares/agent-kit/approval-supersede-hook";
const live = makeApprovalSupersede({ cancel: (s, r) => cancelApprovalRequest(s, r, { baseUrl: "http://127.0.0.1:${port}" }) });
export default defineHook({ events: { "input.requested": live["input.requested"] as any } });
`,
});

function fitOut(root, port) {
  const file = join(root, 'agent/agent.ts');
  let text = readFileSync(file, 'utf8');
  const anchor = 'const tool = msg.startsWith("write")';
  assert.ok(text.includes(anchor), 'agent/agent.ts no longer dispatches on "write" — re-anchor the patch');
  text = text.replace(anchor, `${MODEL_PATCH}\n  ${anchor}`);
  writeFileSync(file, text);
  // This proof does not use the probe extension, and building it needs `eve extension build`, which
  // the pinned TypeScript 7 rejects (TS5112). Leave it out of the disposable copy.
  rmSync(join(root, 'agent/extensions/probe'), { recursive: true, force: true });
  // The REAL web-chat door (route password), copied byte for byte, so requests are authenticated
  // exactly as the console's proxy authenticates them. Only the password-holder identity is used.
  for (const [from, to] of [['services/chief-of-staff/agent/channels/eve.ts', 'agent/channels/eve.ts'], ['services/chief-of-staff/lib/approvals.ts', 'lib/approvals.ts'], ['services/chief-of-staff/lib/principals.ts', 'lib/principals.ts']]) {
    const target = join(root, to);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(resolve(source, '../..', from), 'utf8'));
  }
  mkdirSync(join(root, 'agent/tools'), { recursive: true });
  writeFileSync(join(root, 'agent/tools/pr_send.ts'), GATED_TOOL_SRC);
  mkdirSync(join(root, 'agent/hooks'), { recursive: true });
  const hooks = hookSrc(port);
  writeFileSync(join(root, 'agent/hooks/approval-record.ts'), hooks.record);
  writeFileSync(join(root, 'agent/hooks/approval-supersede.ts'), hooks.supersede);
}

async function seed(uri) {
  const pool = new Pool({ connectionString: uri });
  try {
    await pool.query(readFileSync(resolve(source, '../../services/box/sql/001_baseline.sql'), 'utf8'));
    await pool.query(readFileSync(resolve(source, '../../services/box/sql/006_approval_session.sql'), 'utf8'));
    await pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
      VALUES ('${AGENT}','10.0.0.7','synthetic-unused','owned','${INCARNATION}','${INCARNATION}','ready',false)`);
  } finally { await pool.end(); }
}

const readLines = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== ''); } catch { return []; } };
let port;
const AUTH = `Basic ${Buffer.from('eve:disposable-fixture-only').toString('base64')}`;
const base = () => `http://127.0.0.1:${port}/eve/v1`;

async function readStream(response, timeoutMs = 30000) {
  const out = [];
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
        const raw = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        if (raw.trim() === '') continue;
        let event; try { event = JSON.parse(raw); } catch { event = { type: '<unparsed>', raw }; }
        out.push(event);
        if (TERMINAL.has(event.type)) return out;
      }
    }
  } catch (error) { if (!/abort/i.test(String(error))) throw error; }
  finally { clearTimeout(deadline); await reader.cancel().catch(() => {}); }
  return out;
}

async function follow(sessionId, startIndex, deadlineMs = 30000) {
  const began = Date.now(); const events = []; let index = startIndex;
  while (Date.now() - began < deadlineMs) {
    const query = `?streamControlVersion=1${index === 0 ? '' : `&startIndex=${index}`}`;
    let response;
    for (let a = 0; a < 12; a += 1) {
      response = await fetch(`${base()}/session/${sessionId}/stream${query}`, { headers: { authorization: AUTH } });
      if (response.ok) break;
      await response.text(); await new Promise((r) => setTimeout(r, 250 * (a + 1)));
    }
    if (!response.ok) break;
    const batch = await readStream(response);
    events.push(...batch); index += batch.length;
    if (batch.length > 0 && TERMINAL.has(batch.at(-1).type)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { events, next: index };
}

const cardsIn = (events) => events.flatMap((e) => e.type === 'input.requested' ? (e.data?.requests ?? []).filter((r) => r.kind === 'tool-approval') : []);
const types = (events) => events.map((e) => e.type);
const post = async (sessionId, body) => {
  const r = await fetch(`${base()}/session/${sessionId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: AUTH }, body: JSON.stringify(body) });
  return { status: r.status, text: (await r.text()).slice(0, 400) };
};

const evidence = {};
const say = (item, text) => console.log(`OBSERVED  ${item}  ${text}`);

let container, db, door, app;
const startedAt = Date.now();
try {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  const uriFor = (name) => container.getConnectionUri().replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
  await db.query('CREATE DATABASE pendingreply');
  await seed(uriFor('pendingreply'));

  app = makeApp(uriFor('pendingreply'), '0');
  const { root: cwd, env, eve } = app;
  env.EVE_ROUTE_PASSWORD_FILE = join(cwd, 'route-password');
  writeFileSync(env.EVE_ROUTE_PASSWORD_FILE, 'disposable-fixture-only\n');
  port = await new Promise((done) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => done(p)); });
  });
  fitOut(cwd, port);
  await run(eve, ['build'], { cwd, env });
  door = spawn(eve, ['start', '--host', '127.0.0.1', '--port', String(port)], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let doorLog = '';
  door.stdout.on('data', (b) => { doorLog += b; }); door.stderr.on('data', (b) => { doorLog += b; });
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${base()}/health`)).ok) break; } catch {}
    if (i >= 150) throw new Error(`the door never answered\n${doorLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const sent = () => readLines(env.BOARD_LOG).filter((l) => l.startsWith('sent:'));
  const modelCalls = () => readLines(env.PROOF_MODEL_LOG).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

  async function park(message) {
    const created = await fetch(`${base()}/session`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: AUTH }, body: JSON.stringify({ message }) });
    const createdText = await created.text();
    const sessionId = created.headers.get('x-eve-session-id');
    assert.ok(sessionId, `no session id (${created.status}: ${createdText.slice(0, 300)})`);
    const parked = await follow(sessionId, 0);
    const cards = cardsIn(parked.events);
    assert.ok(cards.length > 0, `no card parked\n${JSON.stringify(types(parked.events))}`);
    return { sessionId, parked, card: cards[0] };
  }

  // (a) a plain text reply while the card waits
  {
    const s = await park('pr:send A');
    evidence.cardShape = s.card;
    const callsBefore = modelCalls().length;
    const sentBefore = sent().length;
    const reply = await post(s.sessionId, { message: 'pr:please change the subject line' });
    const after = await follow(s.sessionId, s.parked.next);
    const newCalls = modelCalls().slice(callsBefore);
    const executedByReply = sent().length - sentBefore;
    const approve = await post(s.sessionId, { inputResponses: [{ requestId: s.card.requestId, optionId: 'approve' }] });
    const post2 = await follow(s.sessionId, after.next);
    evidence.a = { sessionId: s.sessionId, replyStatus: reply.status, replyTypes: types(after.events), replyEvents: after.events, modelCallsForReply: newCalls.length, modelView: newCalls.at(-1), executedByReply, newCardsInReplyTurn: cardsIn(after.events).length, laterApproveStatus: approve.status, laterApproveTypes: types(post2.events), sentAfterApprove: sent() };
    say('a', `reply POST ${reply.status}; stream after reply: ${JSON.stringify(types(after.events))}; model calls for the reply: ${newCalls.length}; executions caused by the reply: ${executedByReply}; original card then approved ${approve.status} -> log ${JSON.stringify(sent())}; session ${s.sessionId}`);
  }

  // (b) typed answers must NOT answer a tool-approval card (patched eve: resolveTextToResponse skips them)
  evidence.b = {};
  for (const typed of ['approve', '1', 'Approve']) {
    const s = await park(`pr:send typed-${typed}`);
    const callsBefore = modelCalls().length;
    const sentBefore = sent().length;
    const reply = await post(s.sessionId, { message: typed });
    const after = await follow(s.sessionId, s.parked.next);
    const ranByText = sent().slice(sentBefore);
    const newCalls = modelCalls().slice(callsBefore);
    // the card is still live: a button/console answer (inputResponses) approves it, exactly once
    const approve = await post(s.sessionId, { inputResponses: [{ requestId: s.card.requestId, optionId: 'approve' }] });
    const later = await follow(s.sessionId, after.next);
    const ranTotal = sent().slice(sentBefore);
    evidence.b[typed] = { sessionId: s.sessionId, options: s.card.options, replyStatus: reply.status, types: types(after.events), modelCalls: newCalls.length, modelSawText: newCalls.some((c) => c.lastUserMessage === typed), executedByText: ranByText, approveStatus: approve.status, laterTypes: types(later.events), executedTotal: ranTotal };
    say(`b "${typed}"`, `POST ${reply.status}; stream ${JSON.stringify(types(after.events))}; model calls: ${newCalls.length}; tool log after text ${JSON.stringify(ranByText)}; button approve ${approve.status} -> total ${JSON.stringify(ranTotal)}; session ${s.sessionId}`);
    assert.equal(ranByText.length, 0, `typed "${typed}" ran the tool`);
    assert.ok(types(after.events).includes('message.received'), `typed "${typed}" was consumed instead of arriving as a message: ${JSON.stringify(types(after.events))}`);
    assert.ok(newCalls.some((c) => c.lastUserMessage === typed), `the model never saw typed "${typed}"`);
    assert.deepEqual(ranTotal, [`sent:typed-${typed}`], `button approve after typed "${typed}" should run the tool exactly once`);
  }

  // (c) our own cancel through inputResponses
  {
    const s = await park('pr:send C');
    const sentBefore = sent().length;
    const cancelOption = (s.card.options ?? []).find((o) => /cancel|deny|reject/i.test(`${o.id} ${o.label}`))?.id;
    const cancel = await post(s.sessionId, { inputResponses: [{ requestId: s.card.requestId, optionId: cancelOption ?? 'cancel' }] });
    const after = await follow(s.sessionId, s.parked.next);
    const ranAfterCancel = sent().slice(sentBefore);
    const lateApprove = await post(s.sessionId, { inputResponses: [{ requestId: s.card.requestId, optionId: 'approve' }] });
    const late = await follow(s.sessionId, after.next, 8000);
    evidence.c = { sessionId: s.sessionId, cancelOption, cancelStatus: cancel.status, cancelBody: cancel.text, types: types(after.events), cancelEvents: after.events.filter((e) => /input|tool/.test(e.type)), executedAfterCancel: ranAfterCancel, lateApproveStatus: lateApprove.status, lateApproveBody: lateApprove.text, lateTypes: types(late.events), executedAfterLateApprove: sent().slice(sentBefore) };
    say('c', `cancel option "${cancelOption}" POST ${cancel.status}; stream ${JSON.stringify(types(after.events))}; executions after cancel: ${ranAfterCancel.length}; late approve of same card: ${lateApprove.status} -> executions in total ${sent().slice(sentBefore).length}; session ${s.sessionId}`);
  }

  // (d) a second card for the same tool while the first waits
  {
    const s = await park('pr:send first');
    const sentBefore = sent().length;
    const second = await post(s.sessionId, { message: 'pr:send second' });
    const after = await follow(s.sessionId, s.parked.next);
    const cards = cardsIn(after.events);
    const secondCard = cards.find((c) => c.requestId !== s.card.requestId) ?? null;
    const firstApprove = await post(s.sessionId, { inputResponses: [{ requestId: s.card.requestId, optionId: 'approve' }] });
    const afterFirst = await follow(s.sessionId, after.next);
    const ranFirst = sent().slice(sentBefore);
    let secondResult = null;
    if (secondCard) {
      const r = await post(s.sessionId, { inputResponses: [{ requestId: secondCard.requestId, optionId: 'cancel' }] });
      const f = await follow(s.sessionId, afterFirst.next, 10000);
      secondResult = { status: r.status, types: types(f.events), executedTotal: sent().slice(sentBefore) };
    }
    evidence.d = { sessionId: s.sessionId, secondStatus: second.status, typesAfterSecond: types(after.events), cardsSeenAfterSecond: cards, firstApproveStatus: firstApprove.status, typesAfterFirstApprove: types(afterFirst.events), executedAfterFirstApprove: ranFirst, secondResult };
    say('d', `second POST ${second.status}; cards after it: ${cards.length} (${cards.map((c) => c.requestId).join(', ')}); first approve ${firstApprove.status} -> executed ${JSON.stringify(ranFirst)}; second-card cancel: ${JSON.stringify(secondResult)}; session ${s.sessionId}`);
  }

  // (e) a revised proposal in a later turn, with the real hooks loaded
  {
    // The mock model reuses the same call id in every session, and the ledger keeps one row per call id
    // (a real model never repeats one), so start this scenario from an empty ledger.
    { const wipe = new Pool({ connectionString: uriFor('pendingreply') }); await wipe.query('TRUNCATE approval_asks'); await wipe.end(); }
    const s = await park('pr:send E1');
    const sentBefore = sent().length;
    const revise = await post(s.sessionId, { message: 'pr:send E2' });
    const after = await follow(s.sessionId, s.parked.next);
    const newCard = cardsIn(after.events).find((c) => c.requestId !== s.card.requestId) ?? null;
    // The cancel was sent while the revising turn was running; give eve a moment, then read on.
    await new Promise((r) => setTimeout(r, 2500));
    const settle = await follow(s.sessionId, after.next, 6000);
    const resolved = [...after.events, ...settle.events].filter((e) => e.type === 'input.resolved' || e.type === 'approval.settled');
    const ledgerDb = new Pool({ connectionString: uriFor('pendingreply') });
    const ledger = (await ledgerDb.query("SELECT request_id, tool, session_id, turn_sequence, outcome, answered_via FROM approval_asks WHERE session_id = $1 ORDER BY asked_at", [s.sessionId])).rows;
    await ledgerDb.end();
    const ranBeforeApprove = sent().slice(sentBefore);
    let approveNew = null;
    if (newCard) {
      const r = await post(s.sessionId, { inputResponses: [{ requestId: newCard.requestId, optionId: 'approve' }] });
      const f = await follow(s.sessionId, settle.next, 15000);
      approveNew = { status: r.status, types: types(f.events), executed: sent().slice(sentBefore) };
    }
    const lateOld = await post(s.sessionId, { inputResponses: [{ requestId: s.card.requestId, optionId: 'approve' }] });
    await new Promise((r) => setTimeout(r, 1500));
    evidence.e = { sessionId: s.sessionId, oldRequestId: s.card.requestId, newRequestId: newCard?.requestId ?? null, reviseStatus: revise.status, typesAfterRevise: types(after.events), typesAfterWait: types(settle.events), resolvedEvents: resolved, ledger, executedBeforeApprovingNew: ranBeforeApprove, approveNew, lateApproveOldStatus: lateOld.status, executedInTotal: sent().slice(sentBefore) };
    say('e', `revise POST ${revise.status}; new card ${newCard?.requestId ?? 'NONE'}; resolutions seen: ${JSON.stringify(resolved.map((e) => [e.type, e.data?.resolutions ?? e.data]))}; ledger ${JSON.stringify(ledger)}; executed before approving the new card: ${JSON.stringify(ranBeforeApprove)}; approve new: ${JSON.stringify(approveNew)}; late approve of old ${lateOld.status}; executed in total ${JSON.stringify(sent().slice(sentBefore))}; session ${s.sessionId}`);
  }

  evidence.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  evidence.fullToolLog = readLines(env.BOARD_LOG);
  if (process.env.PENDING_REPLY_PROOF_OUT) writeFileSync(process.env.PENDING_REPLY_PROOF_OUT, JSON.stringify(evidence, null, 2));
  console.log(`\nPENDING REPLY PROOF: DONE (${evidence.elapsedSeconds}s). Scenario (b) is asserted (typed text never approves); the others are observations.`);
} finally {
  try {
    if (door?.pid) { try { process.kill(-door.pid, 'SIGKILL'); } catch { try { door.kill('SIGKILL'); } catch {} } }
    await new Promise((r) => setTimeout(r, 300));
    app?.dispose();
  } finally {
    try { await db?.end(); } finally { await container?.stop(); }
  }
}
