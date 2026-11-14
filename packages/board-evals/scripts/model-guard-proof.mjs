/**
 * model-guard-proof.mjs — does the model guard refuse a bare model id in a live server?
 *
 * `tests/model-guard.test.ts` pins that the guard file exists and that loading it in a test leaves
 * the AI SDK's default provider refusing. This run shows the same thing in a real `eve start`
 * server built from the fixture.
 *
 * WHY A BARE MODEL ID. Handed a model-id string, the AI SDK resolves it through
 * `globalThis.AI_SDK_DEFAULT_PROVIDER` (`ai` 7.0.169, `dist/index.js`, `resolveLanguageModel`), and
 * without one through a hosted gateway. eve keeps only a model's id between steps and can
 * resolve it that way when it picks a conversation up cold. The guard
 * (`agent/instrumentation/model-guard.ts` → `installRefusingDefaultProvider()`) replaces that
 * default with one that refuses every request, and locks it.
 *
 * WHAT IS ASSERTED, two disposable copies of the fixture, each built and started with `eve start`:
 *
 *   A (the fixture as committed). A probe tool calls the AI SDK's `generateText` with a bare model
 *     id. Asserted: in the server process the default provider is installed and locked; the call
 *     throws the guard's own refusal ("outside the engine's gateway"); and the turn itself is
 *     still served by the scripted model, a provider object, which the guard does not touch (the
 *     reply is the scripted one and the scripted model was called).
 *   B (the same copy with `agent/instrumentation/model-guard.ts` deleted). The probe tool only
 *     LOOKS: asserted that no default provider is installed. This is what makes A's refusal the
 *     guard file's doing. B never makes the call, because without the guard it would be addressed
 *     to a hosted gateway.
 *
 * NOT asserted here: that eve itself ever takes the bare-id path. The kit refuses the known one
 * (a compaction) before any provider is asked; this run shows what happens if any path does.
 *
 * Run: `node packages/board-evals/scripts/model-guard-proof.mjs` (Docker running, for the
 * definition database). One server at a time; everything temporary is disposed in `finally`.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { Client } from 'eve/client';
import { makeApp, run, source, ensureProbeExtensionBuilt, addFixtureDoor, startServer, FIXTURE_DOOR } from './proof-harness.mjs';

const REFUSAL = "outside the engine's gateway";

// The one copy of the AI SDK eve itself uses, addressed by its real path: the fixture does not
// depend on `ai` directly, so the probe tool imports it from where eve's own dependency resolves.
const AI_ENTRY = join(realpathSync(resolve(source, '../agent-kit/node_modules/ai')), 'dist/index.js');

const PROBE_TOOL_SRC = `
import { appendFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateText } from ${JSON.stringify(AI_ENTRY)};

export default defineTool({
  description: "Model guard probe (proof fixture).",
  inputSchema: z.object({}),
  execute: async () => {
    const d = Object.getOwnPropertyDescriptor(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    const record: Record<string, unknown> = {
      pid: process.pid,
      installed: d !== undefined && d.value !== undefined,
      locked: d !== undefined && d.writable === false && d.configurable === false,
    };
    if (process.env.GUARD_PROBE_CALL === "1") {
      try {
        await generateText({ model: "anthropic/claude-guard-proof", prompt: "hello", maxRetries: 0 });
        record.call = "completed";
      } catch (error) {
        const e = error as { name?: unknown; message?: unknown; cause?: { message?: unknown } };
        record.call = "threw";
        record.name = String(e?.name ?? "");
        record.message = String(e?.message ?? error) + (e?.cause?.message ? " | cause: " + String(e.cause.message) : "");
      }
    }
    appendFileSync(process.env.GUARD_PROOF_LOG!, JSON.stringify(record) + "\\n");
    return { probed: true };
  },
});
`;

/** One anchored addition to the COPY's scripted model: "guard probe" calls the probe tool once. */
function patchScriptedModel(root) {
  const file = join(root, 'agent/agent.ts');
  const text = readFileSync(file, 'utf8');
  const anchor = 'const tool = msg.startsWith("write")';
  assert.ok(text.includes(anchor), 'agent/agent.ts no longer dispatches on "write" — re-anchor the patch');
  writeFileSync(file, text.replace(anchor, `if (msg === "guard probe") {\n    if (!acted.has(msg)) { acted.add(msg); return { toolCalls: [{ name: "guard_probe", input: {} }] }; }\n    return \`DONE:\${msg}\`;\n  }\n  ${anchor}`));
}

function prepare(app, { withGuard }) {
  const { root, env } = app;
  env.GUARD_PROOF_LOG = join(root, 'GUARD_PROOF_LOG');
  writeFileSync(env.GUARD_PROOF_LOG, '');
  if (withGuard) env.GUARD_PROBE_CALL = '1';
  else rmSync(join(root, 'agent/instrumentation/model-guard.ts'));
  patchScriptedModel(root);
  writeFileSync(join(root, 'agent/tools/guard_probe.ts'), PROBE_TOOL_SRC);
  addFixtureDoor(root);
}

async function probe(app) {
  await run(app.eve, ['build'], { cwd: app.root, env: app.env });
  const modelCallsBefore = readFileSync(app.env.PROOF_MODEL_LOG, 'utf8').split('\n').filter(Boolean).length;
  const server = await startServer(app);
  try {
    const client = new Client({ baseUrl: server.url, auth: { basic: FIXTURE_DOOR } });
    const { delivery } = await client.sessions.create({ message: 'guard probe' });
    const result = await delivery.result({ signal: AbortSignal.timeout(120_000) });
    const records = readFileSync(app.env.GUARD_PROOF_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const modelCalls = readFileSync(app.env.PROOF_MODEL_LOG, 'utf8').split('\n').filter(Boolean).length - modelCallsBefore;
    return { result, records, modelCalls, serverPid: server.pid };
  } catch (error) {
    throw Object.assign(error, { message: `${error.message}\n--- eve start log ---\n${server.log().slice(-4000)}` });
  } finally {
    await server.stop();
  }
}

let container, db;
const apps = [];
try {
  await ensureProbeExtensionBuilt();
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  await db.query(readFileSync(resolve(source, '../../services/box/sql/001_baseline.sql'), 'utf8'));
  await db.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
    VALUES ('board-evals','192.0.2.1','synthetic-unused','owned','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','ready',false)`);
  await db.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,applied_revision)
    VALUES ('board-evals','slack','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','owner@example.test','U_SYNTHETIC','22222222-2222-4222-8222-222222222222')`);

  // A — the fixture as committed.
  const guarded = makeApp(container.getConnectionUri(), '0'); apps.push(guarded);
  prepare(guarded, { withGuard: true });
  const a = await probe(guarded);
  console.log(`OBSERVED A (guard file present): ${JSON.stringify({ status: a.result.status, reply: a.result.reply ?? null, modelCalls: a.modelCalls, records: a.records })}`);
  assert.equal(a.records.length, 1, 'A: the probe tool did not run exactly once');
  const ra = a.records[0];
  assert.equal(ra.installed, true, 'A: no default provider is installed in the server process');
  assert.equal(ra.locked, true, 'A: the default provider is not locked');
  assert.equal(ra.call, 'threw', `A: a bare model id was NOT refused: ${JSON.stringify(ra)}`);
  assert.ok(String(ra.message).includes(REFUSAL), `A: the call failed, but not with the guard's refusal: ${ra.message}`);
  // The control: what the guard leaves alone still works in the same server.
  assert.equal(a.result.status, 'completed', `A: the turn did not complete: ${JSON.stringify(a.result)}`);
  assert.equal(a.result.reply, 'DONE:guard probe', 'A: the turn was not answered by the scripted model');
  assert.ok(a.modelCalls >= 2, `A: the scripted model was called ${a.modelCalls} time(s); expected the tool step and the answer`);

  // B — the same, with the guard file deleted. Looks only; never calls.
  const bare = makeApp(container.getConnectionUri(), '0'); apps.push(bare);
  prepare(bare, { withGuard: false });
  const b = await probe(bare);
  console.log(`OBSERVED B (guard file deleted): ${JSON.stringify({ status: b.result.status, reply: b.result.reply ?? null, records: b.records })}`);
  assert.equal(b.records.length, 1, 'B: the probe tool did not run exactly once');
  assert.equal(b.records[0].installed, false, 'B: a default provider is installed even without the guard file, so A does not show the guard file at work');
  assert.equal(b.records[0].call, undefined, 'B must never make the call');

  console.log(`MODEL GUARD PROOF: PASS — in a live eve start server (pid ${a.serverPid}) a bare model id handed to the AI SDK is refused with the guard's own message, the default provider is installed and locked, and the scripted model still serves the turn; with the guard file deleted (pid ${b.serverPid}) no default provider is installed.`);
} finally {
  try { for (const app of apps) app.dispose(); } finally { try { await db?.end(); } finally { await container?.stop(); } }
}
