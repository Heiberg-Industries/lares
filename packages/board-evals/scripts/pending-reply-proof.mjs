/**
 * pending-reply-proof.mjs — what does eve do when a person types while an approval card is still
 * waiting? (First measured on eve 0.60.1; this file is the same proof on eve 1.0.)
 *
 * Five questions, each answered by watching a real run, none by reading a doc:
 *   (a) a plain text reply during a pending card: does it run a turn, and what does the model see?
 *   (b) typed "approve" / "1" / "Approve" on the HTTP route (the route web chat uses): must NOT approve (asserted)
 *   (c) can our own code refuse a pending request with a "deny" answer, so the tool never runs?
 *   (d) a second card for the same tool while the first waits: does approving the first still run it?
 *   (e) with the REAL approval-record and approval-supersede hooks loaded: a revised proposal in a
 *       later turn raises a new card; is the older card denied by our hook (sent while that turn is
 *       still running), never executed, recorded cancelled/revised, with the new card live?
 *
 * REAL: an eve 1.0 process (`eve build` + `eve start`), a disposable Postgres, eve's own session
 * routes driven with eve's own `Client`, the kit's real approval-record and approval-supersede
 * hooks. SCRIPTED: the model (the package's `mockModel`, patched in a disposable copy). No
 * credential, no gateway, no network beyond loopback, no money. The Slack card repaint is NOT
 * observed here (no Slack in the fixture); that part can only be described from eve's docs/code.
 *
 * THE DOOR is eve's own HTTP door behind the route password, under the username the kit's deny
 * call uses. It is NOT a copy of a role's door file any more: that file now needs a dozen of the
 * role's own modules and cannot be lifted out alone. What this proof asks is about eve and the two
 * hooks, not about who may pass the door; the web-chat proofs carry the production door.
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
import { Client } from 'eve/client';
import { makeApp, run, source } from './proof-harness.mjs';

const AGENT = 'board-evals';
const INCARNATION = '11111111-1111-4111-8111-111111111111';
const ROUTE_USER = 'eve';
const ROUTE_PASSWORD = 'disposable-fixture-only';

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

// The two real hooks, registered as the roles register them (services/*/agent/hooks/). The one
// difference: the deny is aimed at this run's loopback port (a role's eve listens on 3000 in its
// container).
const hookSrc = (port) => ({
  record: `import { defineHook, type HookContext } from "eve/hooks";
import { makeApprovalRecord } from "@lares/agent-kit/approval-record-hook";
const live = makeApprovalRecord();
type Handler = (event: unknown, ctx: HookContext) => Promise<void>;
export default defineHook({ events: { "interaction.opened": live["interaction.opened"] as Handler, "interaction.settled": live["interaction.settled"] as Handler } });
`,
  supersede: `import { defineHook, type HookContext } from "eve/hooks";
import { makeApprovalSupersede, denyApprovalRequest } from "@lares/agent-kit/approval-supersede-hook";
const live = makeApprovalSupersede({ deny: (s, r) => denyApprovalRequest(s, r, { baseUrl: "http://127.0.0.1:${port}" }) });
type Handler = (event: unknown, ctx: HookContext) => Promise<void>;
export default defineHook({ events: { "interaction.opened": live["interaction.opened"] as Handler } });
`,
});

const DOOR_SRC = `import { eveChannel } from "eve/channels/eve";
import { httpBasic } from "eve/channels/auth";
export default eveChannel({ auth: [httpBasic({ username: "${ROUTE_USER}", password: "${ROUTE_PASSWORD}" })] });
`;

function fitOut(root, port) {
  const file = join(root, 'agent/agent.ts');
  let text = readFileSync(file, 'utf8');
  const anchor = 'const tool = msg.startsWith("write")';
  assert.ok(text.includes(anchor), 'agent/agent.ts no longer dispatches on "write" — re-anchor the patch');
  text = text.replace(anchor, `${MODEL_PATCH}\n  ${anchor}`);
  writeFileSync(file, text);
  // This proof does not use the probe extension. Leave it out of the disposable copy.
  rmSync(join(root, 'agent/extensions/probe'), { recursive: true, force: true });
  mkdirSync(join(root, 'agent/channels'), { recursive: true });
  writeFileSync(join(root, 'agent/channels/eve.ts'), DOOR_SRC);
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
let client;

/** Read one delivery to its end: every event its stream carried, and eve's own summary of it. A
 *  refused request (an answer to a card that is no longer open, say) is evidence too, so it is
 *  returned, not thrown. */
async function read(start) {
  let delivery;
  try { delivery = await start(); }
  catch (error) { return { refused: true, status: error?.status ?? null, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300), events: [], result: null }; }
  const events = [];
  for await (const event of delivery.stream({ signal: AbortSignal.timeout(30000) })) events.push(event);
  const result = await delivery.result({ signal: AbortSignal.timeout(30000) });
  return { refused: false, status: 200, events, result };
}
const cardsOf = (result) => (result?.interactions ?? []).filter((i) => i.request.kind === 'approval' && i.status === 'open');
const types = (events) => events.map((e) => e.type);
const sendText = (session, message) => read(() => session.send(message));
const answer = (session, interactionId, optionId) => read(() => session.respond([{ interactionId, optionId }]));

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
  writeFileSync(env.EVE_ROUTE_PASSWORD_FILE, `${ROUTE_PASSWORD}\n`);
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
    try { if ((await fetch(`http://127.0.0.1:${port}/eve/v1/health`)).ok) break; } catch {}
    if (i >= 150) throw new Error(`the door never answered\n${doorLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const sent = () => readLines(env.BOARD_LOG).filter((l) => l.startsWith('sent:'));
  const modelCalls = () => readLines(env.PROOF_MODEL_LOG).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

  client = new Client({ baseUrl: `http://127.0.0.1:${port}`, auth: { basic: { username: ROUTE_USER, password: ROUTE_PASSWORD } } });

  async function park(message) {
    let session;
    const parked = await read(async () => { const created = await client.sessions.create({ message }); session = created.session; return created.delivery; });
    assert.ok(!parked.refused, `the first message was refused: ${parked.message}`);
    const cards = cardsOf(parked.result);
    assert.ok(cards.length > 0, `no card parked\n${JSON.stringify(types(parked.events))}`);
    assert.equal(parked.result.status, 'awaiting-input', 'a parked card must leave the request awaiting input');
    return { session, sessionId: session.id, parked, card: cards[0] };
  }

  // (a) a plain text reply while the card waits
  {
    const s = await park('pr:send A');
    evidence.cardShape = s.card;
    const callsBefore = modelCalls().length;
    const sentBefore = sent().length;
    const reply = await sendText(s.session, 'pr:please change the subject line');
    const newCalls = modelCalls().slice(callsBefore);
    const executedByReply = sent().length - sentBefore;
    const approve = await answer(s.session, s.card.interactionId, 'approve');
    evidence.a = { sessionId: s.sessionId, replyStatus: reply.status, replyTypes: types(reply.events), replyEvents: reply.events, replyResult: reply.result, modelCallsForReply: newCalls.length, modelView: newCalls.at(-1), executedByReply, newCardsInReplyTurn: cardsOf(reply.result).filter((c) => c.interactionId !== s.card.interactionId).length, laterApprove: { refused: approve.refused, status: approve.status, code: approve.code ?? null, types: types(approve.events) }, toolLogAfterApprove: sent() };
    say('a', `reply ${reply.refused ? `REFUSED ${reply.status}` : `accepted, request ended "${reply.result.status}"`}; stream of the reply: ${JSON.stringify(types(reply.events))}; model calls for the reply: ${newCalls.length}; executions caused by the reply: ${executedByReply}; original card then approved: ${approve.refused ? `refused ${approve.status} ${approve.code ?? ''}` : 'accepted'} -> log ${JSON.stringify(sent())}; session ${s.sessionId}`);
  }

  // (b) typed answers must NOT answer a tool-approval card (patched eve: a typed reply is never
  // read as the answer to an approval). ASSERTED.
  evidence.b = {};
  for (const typed of ['approve', '1', 'Approve']) {
    const s = await park(`pr:send typed-${typed}`);
    const callsBefore = modelCalls().length;
    const sentBefore = sent().length;
    const reply = await sendText(s.session, typed);
    const ranByText = sent().slice(sentBefore);
    const newCalls = modelCalls().slice(callsBefore);
    // What became of the card once text arrived, in eve's own words.
    const settled = reply.events.filter((e) => e.type === 'interaction.settled' && e.data?.interactionId === s.card.interactionId).map((e) => e.data?.outcome);
    // A button/console answer for the SAME card afterwards: it may approve it once, never twice.
    const approve = await answer(s.session, s.card.interactionId, 'approve');
    const ranTotal = sent().slice(sentBefore);
    evidence.b[typed] = { sessionId: s.sessionId, options: s.card.request.options, replyStatus: reply.status, types: types(reply.events), replyResult: reply.result, cardSettledByText: settled, modelCalls: newCalls.length, modelSawText: newCalls.some((c) => c.lastUserMessage === typed), executedByText: ranByText, approve: { refused: approve.refused, status: approve.status, code: approve.code ?? null, types: types(approve.events) }, executedTotal: ranTotal };
    say(`b "${typed}"`, `text ${reply.refused ? `REFUSED ${reply.status}` : 'accepted'}; stream ${JSON.stringify(types(reply.events))}; card after the text: ${settled.length ? `settled ${JSON.stringify(settled)}` : 'still open'}; model calls: ${newCalls.length}; tool log after text ${JSON.stringify(ranByText)}; button approve afterwards: ${approve.refused ? `refused ${approve.status} ${approve.code ?? ''}` : 'accepted'} -> total ${JSON.stringify(ranTotal)}; session ${s.sessionId}`);
    assert.ok(!reply.refused, `typed "${typed}" was refused instead of arriving as a message: ${reply.message}`);
    assert.equal(ranByText.length, 0, `typed "${typed}" ran the tool`);
    assert.ok(!settled.includes('accepted'), `typed "${typed}" was taken as an approval: the card settled ${JSON.stringify(settled)}`);
    assert.ok(types(reply.events).includes('delivery.consumed'), `typed "${typed}" was consumed instead of arriving as a message: ${JSON.stringify(types(reply.events))}`);
    assert.ok(newCalls.some((c) => c.lastUserMessage === typed), `the model never saw typed "${typed}"`);
    // On eve 0.60.1 the card stayed open after text and a later button approve ran the tool exactly
    // once. eve 1.0 may instead withdraw the card when text arrives; then the later approve is
    // refused and nothing runs. Either way the tool runs AT MOST once, and only by a button answer.
    if (settled.length === 0) assert.deepEqual(ranTotal, [`sent:typed-${typed}`], `button approve after typed "${typed}" should run the tool exactly once`);
    else assert.deepEqual(ranTotal, [], `the card was settled ${JSON.stringify(settled)} by the text, yet the tool ran afterwards`);
  }

  // (c) our own refusal through an answer
  {
    const s = await park('pr:send C');
    const sentBefore = sent().length;
    const denyOption = (s.card.request.options ?? []).find((o) => /cancel|deny|reject/i.test(`${o.id} ${o.label}`))?.id;
    const deny = await answer(s.session, s.card.interactionId, denyOption ?? 'deny');
    const ranAfterDeny = sent().slice(sentBefore);
    const lateApprove = await answer(s.session, s.card.interactionId, 'approve');
    evidence.c = { sessionId: s.sessionId, denyOption, deny: { refused: deny.refused, status: deny.status, types: types(deny.events), result: deny.result }, settledEvents: deny.events.filter((e) => /interaction|call/.test(e.type)), executedAfterDeny: ranAfterDeny, lateApprove: { refused: lateApprove.refused, status: lateApprove.status, code: lateApprove.code ?? null, types: types(lateApprove.events) }, executedTotal: sent().slice(sentBefore) };
    say('c', `deny option "${denyOption}": ${deny.refused ? `REFUSED ${deny.status}` : 'accepted'}; stream ${JSON.stringify(types(deny.events))}; executions after the deny: ${ranAfterDeny.length}; late approve of the same card: ${lateApprove.refused ? `refused ${lateApprove.status} ${lateApprove.code ?? ''}` : 'accepted'} -> executions in total ${sent().slice(sentBefore).length}; session ${s.sessionId}`);
  }

  // (d) a second card for the same tool while the first waits
  {
    const s = await park('pr:send first');
    const sentBefore = sent().length;
    const second = await sendText(s.session, 'pr:send second');
    const cards = cardsOf(second.result);
    const secondCard = cards.find((c) => c.interactionId !== s.card.interactionId) ?? null;
    const firstSettledBySecond = second.events.filter((e) => e.type === 'interaction.settled' && e.data?.interactionId === s.card.interactionId).map((e) => e.data?.outcome);
    const firstApprove = await answer(s.session, s.card.interactionId, 'approve');
    const ranFirst = sent().slice(sentBefore);
    let secondResult = null;
    if (secondCard) {
      const r = await answer(s.session, secondCard.interactionId, 'deny');
      secondResult = { refused: r.refused, status: r.status, types: types(r.events), executedTotal: sent().slice(sentBefore) };
    }
    evidence.d = { sessionId: s.sessionId, second: { refused: second.refused, status: second.status }, typesAfterSecond: types(second.events), openCardsAfterSecond: cards, firstSettledBySecond, firstApprove: { refused: firstApprove.refused, status: firstApprove.status, code: firstApprove.code ?? null, types: types(firstApprove.events) }, executedAfterFirstApprove: ranFirst, secondResult };
    say('d', `second message ${second.refused ? `REFUSED ${second.status}` : 'accepted'}; open cards after it: ${cards.length} (${cards.map((c) => c.interactionId).join(', ')}); first card after the second message: ${firstSettledBySecond.length ? `settled ${JSON.stringify(firstSettledBySecond)}` : 'still open'}; first approve ${firstApprove.refused ? `refused ${firstApprove.status} ${firstApprove.code ?? ''}` : 'accepted'} -> executed ${JSON.stringify(ranFirst)}; second-card deny: ${JSON.stringify(secondResult)}; session ${s.sessionId}`);
  }

  // (e) a revised proposal in a later turn, with the real hooks loaded
  {
    // The mock model reuses the same call id in every session, and the ledger keeps one row per call id
    // (a real model never repeats one), so start this scenario from an empty ledger.
    { const wipe = new Pool({ connectionString: uriFor('pendingreply') }); await wipe.query('TRUNCATE approval_asks'); await wipe.end(); }
    const s = await park('pr:send E1');
    const sentBefore = sent().length;
    const revise = await sendText(s.session, 'pr:send E2');
    const newCard = cardsOf(revise.result).find((c) => c.interactionId !== s.card.interactionId) ?? null;
    // The deny was sent while the revising turn was running; give eve a moment, then read on.
    await new Promise((r) => setTimeout(r, 2500));
    const tail = [];
    try { for await (const event of s.session.stream({ follow: false, signal: AbortSignal.timeout(6000) })) tail.push(event); } catch (error) { if (!/abort|timeout/i.test(String(error))) throw error; }
    const resolved = [...revise.events, ...tail].filter((e) => e.type === 'interaction.settled');
    const ledgerDb = new Pool({ connectionString: uriFor('pendingreply') });
    const ledger = (await ledgerDb.query("SELECT request_id, tool, session_id, turn_sequence, outcome, answered_via FROM approval_asks WHERE session_id = $1 ORDER BY asked_at", [s.sessionId])).rows;
    await ledgerDb.end();
    const ranBeforeApprove = sent().slice(sentBefore);
    let approveNew = null;
    if (newCard) {
      const r = await answer(s.session, newCard.interactionId, 'approve');
      approveNew = { refused: r.refused, status: r.status, types: types(r.events), executed: sent().slice(sentBefore) };
    }
    const lateOld = await answer(s.session, s.card.interactionId, 'approve');
    await new Promise((r) => setTimeout(r, 1500));
    evidence.e = { sessionId: s.sessionId, oldInteractionId: s.card.interactionId, newInteractionId: newCard?.interactionId ?? null, revise: { refused: revise.refused, status: revise.status }, typesAfterRevise: types(revise.events), typesAfterWait: types(tail), settledEvents: resolved, ledger, executedBeforeApprovingNew: ranBeforeApprove, approveNew, lateApproveOld: { refused: lateOld.refused, status: lateOld.status, code: lateOld.code ?? null }, executedTotal: sent().slice(sentBefore) };
    say('e', `revise ${revise.refused ? `REFUSED ${revise.status}` : 'accepted'}; new card ${newCard?.interactionId ?? 'NONE'}; settlements seen: ${JSON.stringify(resolved.map((e) => [e.data?.interactionId, e.data?.outcome]))}; ledger ${JSON.stringify(ledger)}; executed before approving the new card: ${JSON.stringify(ranBeforeApprove)}; approve new: ${JSON.stringify(approveNew)}; late approve of the old card: ${lateOld.refused ? `refused ${lateOld.status} ${lateOld.code ?? ''}` : 'accepted'} -> executed in total ${JSON.stringify(sent().slice(sentBefore))}; session ${s.sessionId}`);
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
