#!/usr/bin/env node
// W2-s12: how eve 0.60.1's OWN `workflow` schema tables grow, per turn, against a disposable
// Postgres. See docs/research/2026-09-18-eve-session-rows-retention.md, whose 0.32 verdict was
// "UNKNOWN UNTIL MEASURED" and whose candidate prune predicate keyed on `$eve.type='turn'` —
// a value 0.60.1 no longer writes (`buildTurnAttributes` is gone from eve's own dist; see
// node_modules/eve/dist/src/execution/eve-workflow-attributes.js, which now exports only
// `buildSessionAttributes` and `buildSubagentRootAttributes`). This script re-measures the shape
// so a later wave can size and write a prune against what is actually there.
//
// THE HARNESS. This reuses the technique proven by services/keeper/tests/conversation-runtime.probe.mts
// (real installed eve, real `eve build` + `eve start`, a disposable Postgres via testcontainers, no
// mock-model flag) rather than `capture-snapshot.sh`'s technique (`EVE_MOCK_AUTHORED_MODELS=1`),
// because W2-s3b's notes record that the mock discards the live provider object. It does NOT reuse
// that probe's committed fixture (services/keeper/tests/fixtures/conversation-agent) directly,
// though: that fixture deliberately runs on eve's DEFAULT local-disk workflow world (it exists to
// prove definition/model/duties resolution and a Postgres-backed *projection*, neither of which
// needs eve's own Postgres world). A row census needs the opposite — the real Postgres-backed
// world every role service runs in production (`experimental.workflow.world:
// "@workflow/world-postgres"`, services/chief-of-staff/agent/agent.ts:34-42) — so this script
// authors its own tiny agent app straight into a temp directory (never into the repo): one mock
// model (`eve/evals`'s `mockModel`, no network) and one tool with `approval: always()` (copied
// verbatim from the probe fixture's `agent/tools/proof_write.ts`) to park a genuine approval card
// on the literal message "pending write".
//
// `ClientSession#reset()` (services/chief-of-staff/node_modules/eve/dist/src/client/session.d.ts)
// dispatches the identical `{kind:'reset'}` workflow command that a server-side
// `attachSession(id).reset()` does (both route through `dispatchWorkflowCommand` in
// node_modules/eve/dist/src/execution/workflow-runtime.js) — so calling it from the client here
// measures the same reset the slice was asked to observe.
//
// SAFETY. This script must never reach a real installation's database. It refuses to run if
// WORKFLOW_POSTGRES_URL or DATABASE_URL is already set in its environment, and it always drives
// its own disposable Postgres via testcontainers, torn down unconditionally on exit.
//
// Usage: node packages/board-evals/scripts/session-rows-measure.mjs [--help]
// Needs: Docker running. Run `uptime` first — this starts a Postgres container and a real
// `eve start` runtime process.

import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

const HELP = `Usage: node packages/board-evals/scripts/session-rows-measure.mjs [--help]

Measures how many rows and bytes eve 0.60.1's own "workflow" Postgres schema grows by, per
turn, against a disposable database (testcontainers) — never an installation's. Drives one
session through three turns (two plain, one a tool call that parks an approval card), then
resets the session, taking a census of every workflow.* table after each step.

Needs Docker running. Refuses to run if WORKFLOW_POSTGRES_URL or DATABASE_URL is already set.`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (process.env.WORKFLOW_POSTGRES_URL || process.env.DATABASE_URL) {
  console.error(
    'Refusing to run: WORKFLOW_POSTGRES_URL or DATABASE_URL is already set in this ' +
      'environment. This script must drive its own disposable Postgres via testcontainers and ' +
      'must never be pointed at a real database.',
  );
  process.exit(1);
}

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '../../..');
const root = mkdtempSync(join(tmpdir(), 'lares-session-rows-measure-'));

/** The six tables the 0.32 finding inventoried; `pg_total_relation_size` is summed across them. */
const CORE_TABLES = [
  'workflow_events',
  'workflow_hooks',
  'workflow_runs',
  'workflow_steps',
  'workflow_stream_chunks',
  'workflow_waits',
];

/**
 * @typedef {object} RowCensus
 * @property {number} runs
 * @property {Record<string,number>} runsByType
 * @property {Record<string,number>} runsByName
 * @property {number} events
 * @property {number} steps
 * @property {number} streamChunks
 * @property {number} hooks
 * @property {number} waits
 * @property {number} eventSlots  extra: workflow_event_slots, new on beta.42, not one of the
 *   original six tables but worth watching since it is the newest addition to the schema.
 * @property {number} bytes  pg_total_relation_size across the six CORE_TABLES
 */

/** @returns {Promise<RowCensus>} */
async function census(db) {
  const totals = (
    await db.query(`SELECT
      (SELECT count(*) FROM workflow.workflow_runs)          AS runs,
      (SELECT count(*) FROM workflow.workflow_events)        AS events,
      (SELECT count(*) FROM workflow.workflow_steps)         AS steps,
      (SELECT count(*) FROM workflow.workflow_stream_chunks) AS stream_chunks,
      (SELECT count(*) FROM workflow.workflow_hooks)         AS hooks,
      (SELECT count(*) FROM workflow.workflow_waits)         AS waits,
      (SELECT count(*) FROM workflow.workflow_event_slots)   AS event_slots`)
  ).rows[0];
  const byType = await db.query(
    `SELECT coalesce(attributes->>'$eve.type','(none)') AS k, count(*)::int AS n
     FROM workflow.workflow_runs GROUP BY 1 ORDER BY 1`,
  );
  const byName = await db.query(
    `SELECT name AS k, count(*)::int AS n FROM workflow.workflow_runs GROUP BY 1 ORDER BY 1`,
  );
  const bytes = await db.query(
    `SELECT sum(pg_total_relation_size('workflow.' || t))::bigint AS bytes
     FROM unnest($1::text[]) AS t`,
    [CORE_TABLES],
  );
  return {
    runs: Number(totals.runs),
    runsByType: Object.fromEntries(byType.rows.map((r) => [r.k, r.n])),
    runsByName: Object.fromEntries(byName.rows.map((r) => [r.k, r.n])),
    events: Number(totals.events),
    steps: Number(totals.steps),
    streamChunks: Number(totals.stream_chunks),
    hooks: Number(totals.hooks),
    waits: Number(totals.waits),
    eventSlots: Number(totals.event_slots),
    bytes: Number(bytes.rows[0].bytes ?? 0),
  };
}

/** Longest-opening-message title eve stores in the clear, read back for stage (c). */
async function titleLengths(db) {
  const { rows } = await db.query(
    `SELECT id, length(attributes->>'$eve.title') AS len, attributes->>'$eve.title' AS title
     FROM workflow.workflow_runs WHERE attributes ? '$eve.title' ORDER BY id`,
  );
  return rows.map((r) => ({ id: r.id, length: r.len === null ? 0 : Number(r.len) }));
}

function delta(after, before) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of ['events', 'steps', 'streamChunks', 'hooks', 'waits', 'eventSlots', 'bytes', 'runs']) {
    out[k] = after[k] - before[k];
  }
  return out;
}

function printCensus(label, c) {
  console.log(
    `\n[${label}] runs=${c.runs} events=${c.events} steps=${c.steps} ` +
      `streamChunks=${c.streamChunks} hooks=${c.hooks} waits=${c.waits} eventSlots=${c.eventSlots} ` +
      `bytes=${c.bytes}`,
  );
  console.log(`  runsByType: ${JSON.stringify(c.runsByType)}`);
  console.log(`  runsByName: ${JSON.stringify(c.runsByName)}`);
}

async function lockedGraphileJobs(db) {
  // graphile-worker's schema is self-provisioning (createWorld().start() installs it on first
  // connect) and is not guaranteed to exist the instant `eve start` returns. `to_regclass` takes
  // a name as a plain text argument, so it never fails on a schema that is not there yet — unlike
  // a query that references `graphile_worker.jobs` directly, which Postgres refuses to PLAN (not
  // just run) against a relation that does not exist.
  const check = await db.query(`SELECT to_regclass('graphile_worker.jobs') AS rel`);
  if (!check.rows[0].rel) return 0;
  const { rows } = await db.query(`SELECT count(*) AS n FROM graphile_worker.jobs WHERE locked_at IS NOT NULL`);
  return Number(rows[0].n);
}

async function waitQuiet(db, label) {
  // Mirrors services/keeper/tests/runtime-image.probe.py's wait_quiet: "finished" means no
  // workflow step running and no queue job locked, twice in a row half a second apart.
  let calm = 0;
  for (let i = 0; i < 60; i++) {
    const stepsRunning = await db.query(`SELECT count(*) AS n FROM workflow.workflow_steps WHERE status='running'`);
    const busy = Number(stepsRunning.rows[0].n) + (await lockedGraphileJobs(db));
    calm = busy === 0 ? calm + 1 : 0;
    if (calm === 2) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Workflow work never went quiet ' + label);
}

let pg, db, server;
try {
  // --- a minimal agent, written fresh into the temp root, never into the repo ------------------
  // See the file header for why this is a fresh app rather than the committed probe fixture.
  // Nothing here is committed; `root` is a mkdtemp directory removed in the `finally` block below.
  // Symlinked from services/chief-of-staff, not packages/board-evals: chief-of-staff declares
  // `@workflow/world-postgres` as a direct dependency (services/chief-of-staff/package.json),
  // which is what makes it resolvable as a top-level entry in a pnpm workspace's per-package
  // node_modules; board-evals never depends on it directly, so `eve start` cannot resolve the
  // import there. `eve`, `zod` and everything else this fixture needs are direct deps of
  // chief-of-staff too.
  symlinkSync(join(repo, 'services/chief-of-staff/node_modules'), join(root, 'node_modules'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'session-rows-measure-fixture', type: 'module', dependencies: { eve: '0.60.1', zod: '4.5.4' } }),
  );
  mkdirSync(join(root, 'agent/tools'), { recursive: true });
  mkdirSync(join(root, 'agent/channels'), { recursive: true });
  writeFileSync(
    join(root, 'agent/agent.ts'),
    [
      "import {defineAgent} from 'eve';",
      "import {mockModel} from 'eve/evals';",
      "// Deterministic, no-network: plain text for any turn except the literal message",
      "// 'pending write', which calls the approval-gated tool below.",
      'const model=mockModel(({lastUserMessage})=>lastUserMessage===`pending write`',
      "  ?{toolCalls:[{name:'proof_write',input:{}}]}",
      "  :'measurement-fixture-reply');",
      'export default defineAgent({',
      '  model,',
      // eve looks up context-window metadata for a model id via the AI Gateway; a mock model has
      // none, so `eve build` refuses to compile compaction against it unless this escape hatch
      // (documented on the static branch of AgentDefinition.modelContextWindowTokens) is set.
      '  modelContextWindowTokens:200000,',
      '  experimental:{workflow:{world:"@workflow/world-postgres"}},',
      '});',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'agent/instructions.md'), 'Disposable measurement fixture. No real instructions.\n');
  writeFileSync(
    join(root, 'agent/tools/proof_write.ts'),
    [
      "import {defineTool} from 'eve/tools';",
      "import {always} from 'eve/tools/approval';",
      "import {z} from 'zod';",
      "export default defineTool({description:'A disposable proof write',inputSchema:z.object({}),approval:always(),execute:async()=>'written'});",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'agent/channels/eve.ts'),
    [
      "import {eveChannel} from 'eve/channels/eve';",
      "import {httpBasic} from 'eve/channels/auth';",
      "export default eveChannel({auth:[httpBasic({username:'fixture',password:'disposable-fixture-only'})]});",
      '',
    ].join('\n'),
  );

  // --- disposable Postgres ---------------------------------------------------------------------
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Pool({ connectionString: pg.getConnectionUri() });
  await db.query(readFileSync(join(repo, 'services/chief-of-staff/sql/001-eve-workflow.sql'), 'utf8'));

  // --- build + start the real runtime -----------------------------------------------------------
  const env = {
    ...process.env,
    DATABASE_URL: pg.getConnectionUri(),
    WORKFLOW_POSTGRES_URL: pg.getConnectionUri(),
    NODE_ENV: 'production',
  };
  const eveBin = join(repo, 'services/chief-of-staff/node_modules/.bin/eve');
  const build = await run(eveBin, ['build'], { cwd: root, env, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(root, 'build.log'), build.stdout + build.stderr);

  const port = await freePort();
  server = spawn(eveBin, ['start', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout?.on('data', (c) => (logs += c));
  server.stderr?.on('data', (c) => (logs += c));
  const host = `http://127.0.0.1:${port}`;
  await waitHealthy(host, () => logs);

  const { Client } = await import(join(repo, 'services/chief-of-staff/node_modules/eve/dist/src/client/index.js'));
  const client = new Client({ host, auth: { basic: { username: 'fixture', password: 'disposable-fixture-only' } } });

  // --- the measurement ---------------------------------------------------------------------------
  const stages = [];
  const record = async (label) => {
    const c = await census(db);
    printCensus(label, c);
    stages.push({ label, census: c });
    return c;
  };

  await record('0-baseline (build+start, no session yet)');

  const one = await client.sessions.create({ message: 'hello' });
  const first = await one.response.result();
  if (!/measurement-fixture-reply/.test(first.message)) throw new Error('Turn 1 reply did not come from the fixture model: ' + JSON.stringify(first));
  await waitQuiet(db, 'after turn 1');
  await record('1-after-turn-1 (plain)');

  const second = await (await one.session.send('hello again')).result();
  if (!/measurement-fixture-reply/.test(second.message)) throw new Error('Turn 2 reply did not come from the fixture model: ' + JSON.stringify(second));
  await waitQuiet(db, 'after turn 2');
  await record('2-after-turn-2 (plain)');

  const third = await (await one.session.send('pending write')).result();
  if (!(third.inputRequests?.length > 0)) throw new Error('Turn 3 did not park an approval card');
  await waitQuiet(db, 'after turn 3');
  const afterThird = await record('3-after-turn-3 (tool call, approval pending)');

  const titlesBeforeReset = await titleLengths(db);

  const resetResult = await one.session.reset({ reason: 'session-rows-measure W2-s12' });
  if (!['reset', 'no_active_session'].includes(resetResult.status)) {
    throw new Error('Unexpected reset outcome: ' + JSON.stringify(resetResult));
  }
  await waitQuiet(db, 'after reset');
  const afterReset = await record('4-after-reset');

  // --- answer the slice's five questions, with numbers -------------------------------------------
  console.log('\n=== ANSWERS ===');
  console.log(
    '(a) child runs per turn, or one session run that grows? runsByName after turn 3: ' +
      JSON.stringify(afterThird.runsByType) +
      ' — a single count under "session" that does not increase per turn means ONE session run ' +
      'now carries every turn; a growing count under a "turn" key would mean child runs persist.',
  );
  console.log('(b) per-turn deltas (rows/bytes added by that turn), from the census stages above:');
  for (let i = 1; i < stages.length; i++) {
    console.log(`    ${stages[i].label} vs ${stages[i - 1].label}: ${JSON.stringify(delta(stages[i].census, stages[i - 1].census))}`);
  }
  console.log(
    '(c) $eve.title length(s) before reset (max 125 expected if the truncation still applies): ' +
      JSON.stringify(titlesBeforeReset),
  );
  console.log(
    '(d) hooks/waits before vs after reset: before=' +
      JSON.stringify({ hooks: afterThird.hooks, waits: afterThird.waits }) +
      ' after=' +
      JSON.stringify({ hooks: afterReset.hooks, waits: afterReset.waits }),
  );
  console.log(
    '(e) $eve.type values observed: ' +
      JSON.stringify(Object.keys(afterReset.runsByType)) +
      '; workflow_runs.name values observed: ' +
      JSON.stringify(Object.keys(afterReset.runsByName)),
  );

  console.log('\nPASS: session-rows-measure completed. Full stage data follows as JSON:\n');
  console.log(JSON.stringify(stages, null, 2));
} catch (e) {
  console.error('FAIL:', e);
  console.error('Probe artifact directory:', root);
  process.exitCode = 1;
} finally {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', () => r()));
  }
  await db?.end();
  await pg?.stop();
  rmSync(root, { recursive: true, force: true });
}

// --- small helpers ---------------------------------------------------------------------------

async function freePort() {
  const { createServer } = await import('node:net');
  const listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(() => r()));
  return port;
}

async function waitHealthy(host, getLogs) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(host + '/eve/v1/health')).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error('Runtime did not start: ' + getLogs());
  }
}
