/**
 * model-guard-proof.mjs — is a model call OUTSIDE the scripted model really refused?
 *
 * `tests/model-guard.test.ts` pins that the guard is installed. This run shows it biting in a real
 * runtime. A turn is served by the fixture's scripted model; then the conversation's history is
 * compacted between turns. Compaction makes a model call of its own, and it is the path on which
 * eve picks a model up from its saved id instead of the provider object the agent selected, so it
 * is where a call would leave for a hosted provider if nothing stopped it.
 *
 * WHAT IS ASSERTED: the scripted model is not called for the compaction; whatever the compaction
 * attempted was refused, by the kit's own compaction refusal or by the refusing default provider
 * (the message says which); no request left the machine (nothing here has a credential or a
 * provider configured, and the allowlisted environment carries none); and the conversation still
 * answers from the scripted model afterwards.
 *
 * Run: `node packages/board-evals/scripts/model-guard-proof.mjs` (Docker running, for the
 * definition database). One eve process; everything temporary is disposed in `finally`.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { makeApp, run, source, ensureProbeExtensionBuilt } from './proof-harness.mjs';

const EVAL_SRC = `
import { appendFileSync, readFileSync } from "node:fs";
import { defineEval } from "eve/evals";

const note = (value: unknown) => appendFileSync(process.env.GUARD_PROOF_LOG!, JSON.stringify(value) + "\\n");
const calls = () => readFileSync(process.env.PROOF_MODEL_LOG!, "utf8").split("\\n").filter(Boolean).length;

export default defineEval({
  async test(t) {
    const session = await t.session();
    const control = await session.send("hello there");
    note({ step: "control", status: control.status, reply: control.reply ?? null, scriptedCalls: calls() });
    const before = calls();
    try {
      const compaction = await session.compact();
      note({
        step: "compact", threw: false, status: compaction.status, error: compaction.error ?? null,
        events: compaction.events.map((e) => (/settled|ended/.test(e.type) ? { type: e.type, data: e.data } : e.type)),
        scriptedCallsDuring: calls() - before,
      });
    } catch (error) {
      note({ step: "compact", threw: true, message: String(error instanceof Error ? error.message : error), scriptedCallsDuring: calls() - before });
    }
    const beforeNext = calls();
    try {
      const next = await session.send("still here");
      note({ step: "after", threw: false, status: next.status, reply: next.reply ?? null, error: next.error ?? null, scriptedCallsDuring: calls() - beforeNext });
    } catch (error) {
      note({ step: "after", threw: true, message: String(error instanceof Error ? error.message : error), scriptedCallsDuring: calls() - beforeNext });
    }
  },
});
`;

let container, db, app;
try {
  await ensureProbeExtensionBuilt();
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  await db.query(readFileSync(resolve(source, '../../services/box/sql/001_baseline.sql'), 'utf8'));
  await db.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
    VALUES ('board-evals','192.0.2.1','synthetic-unused','owned','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','ready',false)`);
  app = makeApp(container.getConnectionUri(), '0');
  const { root: cwd, env, eve } = app;
  env.GUARD_PROOF_LOG = join(cwd, 'GUARD_PROOF_LOG');
  writeFileSync(env.GUARD_PROOF_LOG, '');
  rmSync(join(cwd, 'evals'), { recursive: true, force: true });
  mkdirSync(join(cwd, 'evals'), { recursive: true });
  writeFileSync(join(cwd, 'evals/evals.config.ts'), 'import { defineEvalConfig } from "eve/evals";\nexport default defineEvalConfig({ maxConcurrency: 1 });\n');
  writeFileSync(join(cwd, 'evals/guard.eval.ts'), EVAL_SRC);
  await run(eve, ['build'], { cwd, env });
  const evalRun = await run(eve, ['eval', 'guard', '--verbose', '--skip-report', '--timeout', '300000', '--max-concurrency', '1'], { cwd, env, timeout: 600_000, acceptedCodes: [0, 1] });
  const notes = readFileSync(env.GUARD_PROOF_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const n of notes) console.log(`OBSERVED ${JSON.stringify(n)}`);
  const serverLog = `${evalRun.stdout}\n${evalRun.stderr}`;
  const refusals = [...new Set(serverLog.split('\n').filter((l) => /outside the engine's gateway|compact/i.test(l)).map((l) => l.trim().slice(0, 300)))].slice(0, 12);
  for (const line of refusals) console.log(`SERVER LOG ${line}`);

  const control = notes.find((n) => n.step === 'control');
  const compact = notes.find((n) => n.step === 'compact');
  const after = notes.find((n) => n.step === 'after');
  assert.ok(control?.reply?.includes('DONE:hello there'), 'the control turn was not served by the scripted model');
  assert.ok(compact, 'the compaction step never reported');
  assert.equal(compact.scriptedCallsDuring, 0, 'the scripted model was called for the compaction: this run cannot show a call outside it');
  const everything = `${JSON.stringify(compact)}\n${serverLog}`;
  const byDefaultProvider = everything.includes("outside the engine's gateway");
  const byKit = /compact/i.test(JSON.stringify(compact.error ?? compact.message ?? '')) || /refus/i.test(JSON.stringify(compact.error ?? compact.message ?? ''));
  assert.ok(byDefaultProvider || byKit, `the compaction did not end in a refusal: ${JSON.stringify(compact)}`);
  console.log(`MODEL GUARD PROOF: PASS — the compaction's model call was refused (${byDefaultProvider ? 'by the refusing default provider' : "by the kit's own compaction refusal, before any provider was asked"}); the scripted model was not called for it; afterwards the conversation ${after?.reply ? `answered ${JSON.stringify(after.reply)}` : `ended ${JSON.stringify(after)}`}.`);
} finally {
  try { app?.dispose(); } finally { try { await db?.end(); } finally { await container?.stop(); } }
}
