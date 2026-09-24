import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { makeApp, run, source, abort, ensureProbeExtensionBuilt } from './proof-harness.mjs';
import { restartProof } from './restart-proof.mjs';
// eve's telemetry is disabled in every child process this script spawns (EVE_TELEMETRY_DISABLED=1 is set in makeApp's env object in proof-harness.mjs)
let container, db;
const apps = [];
try {
  await ensureProbeExtensionBuilt();
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  for (const name of ['039_agent_definitions.sql', '042_agent_resources.sql', '044_agent_door_connections.sql', '045_agent_runtime_control.sql'])
    await db.query(readFileSync(resolve(source, '../../services/box/sql', name), 'utf8'));
  await db.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
    VALUES ('board-evals','192.0.2.1','synthetic-unused','owned','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','ready',false)`);
  await db.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,applied_revision)
    VALUES ('board-evals','slack','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','owner@example.test','U_SYNTHETIC','22222222-2222-4222-8222-222222222222')`);
  const batches = process.argv.includes('--restart-only') ? [] : [
    { ids: ['board', 'definition', 'language', 'schedules', 'doors'], live: '1' },
    { ids: ['schedules'], live: '0' },
  ];
  for (const { ids, live } of batches) {
    abort.signal.throwIfAborted();
    const app = makeApp(container.getConnectionUri(), live); apps.push(app);
    console.log(`Building isolated fixture: ${ids.join(', ')}; schedules live=${live}`);
    await run(app.eve, ['build'], { cwd: app.root, env: app.env });
    const result = await run(app.eve, ['eval', ...ids, '--verbose', '--strict', '--skip-report', '--timeout', '300000', '--max-concurrency', '1'], { cwd: app.root, env: app.env, timeout: 600_000 }).catch(error => {
      try {
        const runs = readdirSync(join(app.root, '.eve/evals')).sort();
        console.error(readFileSync(join(app.root, '.eve/evals', runs.at(-1), 'summary.json'), 'utf8'));
      } catch { /* Startup/interrupt errors may precede artifact creation. Keep the original. */ }
      throw error;
    });
    console.log(result.stdout);
    // Exit zero also means skipped evals in eve. Check the durable result index explicitly.
    const runs = readdirSync(join(app.root, '.eve/evals')).sort();
    const rows = readFileSync(join(app.root, '.eve/evals', runs.at(-1), 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    console.log('RESULT INDEX', JSON.stringify(rows.map(r => ({ id: r.id, status: r.status, verdict: r.verdict }))));
    assert.equal(rows.length, ids.length, 'Required eval missing');
    // Detailed field validation is against installed eve artifact shape (see README).
    for (const id of ids) assert.ok(rows.some(r => r.id === id && r.verdict === 'passed'), `Required eval missing, skipped or failed: ${id}`);
  }
  const restart = makeApp(container.getConnectionUri()); apps.push(restart);
  await run(restart.eve, ['build'], { cwd: restart.root, env: restart.env });
  await restartProof(restart);
  console.log(process.argv.includes('--restart-only') ? 'RESTART PROOF PASS: authored control + definition catalogue.' : 'EIGHT BEHAVIORS PASS: 8/8 required + disabled-door supplemental proof; mock models only.');
} finally {
  try {
    const cleanup = await Promise.allSettled(apps.map(app => Promise.resolve().then(() => app.dispose())));
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Temporary fixture cleanup failed');
  } finally {
    try { await db?.end(); } finally { await container?.stop(); }
  }
}
