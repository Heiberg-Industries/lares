import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from 'eve/client';
import { startServer, FIXTURE_DOOR } from './proof-harness.mjs';
// THE RESTART PROOF. A gated call parks on a card in one server process; that process is killed;
// a NEW process of the same build receives the approval and runs the call exactly once. Then the
// scripted model, which forgets everything at each restart, proposes the same call again three
// times, and each proposal is denied in yet another process: a denial adds no effect.
//
// eve 1.0 has no `eve invoke` (0.60.1's one-shot command, whose `--resume` gave this proof its
// process boundary). The boundary is now explicit: `eve start` is started and stopped around every
// answer (a clean stop, as a restart or an upgrade makes; see `startServer` in proof-harness.mjs), and the session is driven over eve's own HTTP door with `eve/client`. The app must have
// been built with the fixture door in it (`addFixtureDoor`, proof-harness.mjs).
//
// Hash every compiled file, not just the entrypoint, across the measured boundary.
function revision(root) {
  const hash = createHash('sha256');
  for (const file of readdirSync(join(root, '.output'), { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => join(d.parentPath, d.name)).sort()) {
    hash.update(relative(root, file)); hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
/** One delivery read to its end. With RESTART_PROOF_TRACE=1 every step prints what its stream
 *  carried, which is the first thing to read when an assertion below fails. */
async function settled(delivery, what) {
  const types = [];
  for await (const event of delivery.stream({ signal: AbortSignal.timeout(120_000) })) types.push(event.type === 'turn.settled' || event.type === 'delivery.settled' || event.type === 'interaction.settled' || event.type === 'call.settled' ? `${event.type}:${event.data?.outcome}` : event.type);
  const result = await delivery.result({ signal: AbortSignal.timeout(120_000) });
  if (process.env.RESTART_PROOF_TRACE) console.log(`TRACE ${what}: status=${result.status} outcome=${result.outcome} interactions=${result.interactions.length} reply=${JSON.stringify(result.reply)} events=${JSON.stringify(types.filter(t => !t.startsWith('content.delta') && !t.startsWith('call.input')))}`);
  return result;
}
const clientFor = server => new Client({ baseUrl: server.url, auth: { basic: FIXTURE_DOOR } });
/** Run `fn` against a fresh server process and return its result with that process's pid. The
 *  process group is gone before this resolves. */
async function inFreshProcess(app, fn) {
  const server = await startServer(app);
  try { return { value: await fn(clientFor(server)), pid: server.pid }; }
  catch (error) { throw Object.assign(error, { message: `${error.message}\n--- eve start log ---\n${server.log().slice(-4000)}` }); }
  finally { await server.stop(); }
}
export async function restartProof(app) {
  const { root: cwd, env } = app;
  const revisionBefore = revision(cwd);
  writeFileSync(env.BOARD_LEVELS, '{"vault":"gated"}');
  const count = needle => readFileSync(env.BOARD_LOG, 'utf8').split('\n').filter(line => line === needle).length;
  for (const [name, prompt, needle] of [
    ['authored control', 'write restart-control', 'write restart-control'],
    ['definition catalogue', 'seam call vault_list', 'pool-vault-list'],
  ]) {
    const before = count(needle);
    const first = await inFreshProcess(app, async client => {
      const { session, delivery } = await client.sessions.create({ message: prompt });
      return { result: await settled(delivery, `${name}: first message`), state: session.state };
    });
    let card = first.value.result, state = first.value.state;
    assert.equal(card.status, 'awaiting-input', name);
    assert.equal(card.interactions.length, 1, name);
    assert.equal(card.interactions[0].request.kind, 'approval', name);
    assert.equal(count(needle), before, 'Executed before approval');
    assert.equal(revision(cwd), revisionBefore, 'Compiled revision changed before restart');
    // inFreshProcess has observed close AND absence of the owned process group. Nothing remains alive.
    const answer = (optionId) => inFreshProcess(app, async client => {
      const session = client.sessions.attach(state.sessionId, state);
      const delivery = await session.respond(card.interactions.map(i => ({ interactionId: i.interactionId, optionId })));
      return { result: await settled(delivery, `${name}: ${optionId}`), state: session.state };
    });
    const second = await answer('approve');
    assert.notEqual(first.pid, second.pid, 'No process boundary');
    assert.equal(count(needle), before + 1, 'Approval must execute exactly once after restart');
    card = second.value.result; state = second.value.state;
    // The in-memory scripted model forgets after EVERY restart and proposes again.
    // Deny three distinct proposals across three further process boundaries; their
    // pending continuation is discarded only with this harness-owned world on cleanup.
    let denials = 0;
    const pids = new Set([first.pid, second.pid]);
    for (; denials < 3 && card.status === 'awaiting-input'; denials++) {
      assert.equal(card.interactions.length, 1, `${name}: expected one repeated proposal`);
      const next = await answer('deny');
      assert.ok(!pids.has(next.pid), 'No process boundary before a denial'); pids.add(next.pid);
      card = next.value.result; state = next.value.state;
      assert.equal(count(needle), before + 1, 'Denial executed a duplicate side effect');
    }
    assert.equal(denials, 3, `Expected the deliberate repeated mock proposals to exercise denial; the request after denial ${denials} ended ${JSON.stringify({ status: card.status, reply: card.reply, interactions: card.interactions.length, error: card.error ?? null })}`);
    assert.notEqual(card.status, 'failed', 'Resumed conversation failed');
    assert.equal(revision(cwd), revisionBefore, 'Compiled revision changed during restart');
    console.log(`REQUIRED: restart ${name} PASS (exited pid ${first.pid} -> new pid ${second.pid}; exactly one effect; ${denials} denials in ${denials} further processes added zero effects)`);
  }
}
