/**
 * approval-binding-proof.mjs — does the hash on the CARD equal the hash at EXECUTION?
 *
 * `services/chief-of-staff/lib/approvals.ts`'s `assertApproval` refuses a gated tool call whose
 * `payloadFingerprint(toolName, input)` at execution time differs from the one the approval hook
 * recorded from eve's `input.requested` event. Every test of that check so far built BOTH sides by
 * hand. This script builds neither: it boots a REAL eve 0.60.1 runtime against a REAL Postgres,
 * parks a real approval card, answers it, and compares the two fingerprints that the real
 * framework produced — for six input shapes that schema parsing and a durable round-trip are each
 * capable of changing:
 *
 *   a plain          every key supplied, nothing for zod to add or remove
 *   b default        a `.default(...)` the model did not supply
 *   c optional       an optional key the model omitted
 *   d null           an optional+nullable key the model sent as `null`
 *   e nested         an object and an array, to catch key reordering
 *   f extra          an unknown key zod's object strips
 *
 * It also compares the `callId` on the card with `callIdFrom(ctx)` inside `execute` — if those
 * differ, the check looks up the wrong card (or no card at all) and never binds anything.
 *
 * METHOD. The package's own `proof-harness.mjs` makes a disposable copy of this fixture with an
 * allowlisted environment (no inherited model credentials), so the run needs NO model credential:
 * `agent/agent.ts`'s `mockModel` is scripted. This script patches exactly two anchors in that
 * scripted model inside the COPY (never in the source tree), adds six gated probe tools and one
 * hook to the copy, and drives park → approve → execute through eve's own eval harness
 * (`session.send` → one `inputRequest` → `session.respondAll("approve")`), the way
 * `evals/board.eval.ts` already drives a real approval. Both sides append a line to one file; the
 * comparison is over those lines, not over anything this script computed itself.
 *
 * WHY NOT `eve invoke --resume`, which `restart-proof.mjs` uses and which would add a real process
 * boundary: measured here, roughly one resume in five answers HTTP 409 `session_not_active` ("The
 * session is no longer active.", `dist/src/eve-channel/index.js`) — reproduced with a fresh app per
 * case AND a fresh database per case, so it is neither state accumulating in one app nor in one
 * database. That flake is a property of driving the local invoke server once per turn, not of the
 * binding, and it is reported as a separate observation. The eval harness runs the same runtime and
 * the same durable pending-input path in one process, and is stable.
 *
 * Run: `node packages/board-evals/scripts/approval-binding-proof.mjs` (Docker running). One eve
 * process at a time; the container and every temporary directory are disposed in `finally`.
 * Results: `packages/board-evals/proofs/approval-binding-2026-09-20.md`.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { makeApp, run, source, abort, ensureProbeExtensionBuilt } from './proof-harness.mjs';

/** The six shapes. `schema` is the zod object literal the probe tool declares; `input` is what the
 *  scripted model emits as the RAW tool-call input — deliberately not always schema-shaped (case f
 *  carries a key the schema strips). */
const CASES = [
  {
    id: 'a',
    tool: 'bind_a_plain',
    what: 'plain input, nothing for the schema to add or remove',
    schema: 'z.object({ text: z.string() })',
    input: { text: 'alpha' },
  },
  {
    id: 'b',
    tool: 'bind_b_default',
    what: 'a `.default("normal")` the model did not supply',
    schema: 'z.object({ text: z.string(), mode: z.string().default("normal") })',
    input: { text: 'beta' },
  },
  {
    id: 'c',
    tool: 'bind_c_optional',
    what: 'an optional key the model omitted',
    schema: 'z.object({ text: z.string(), cc: z.string().optional() })',
    input: { text: 'gamma' },
  },
  {
    id: 'd',
    tool: 'bind_d_null',
    what: 'an optional+nullable key the model sent as `null`',
    schema: 'z.object({ text: z.string(), cc: z.string().nullable().optional() })',
    input: { text: 'delta', cc: null },
  },
  {
    id: 'e',
    tool: 'bind_e_nested',
    what: 'a nested object and an array, keys emitted out of alphabetical order',
    schema: 'z.object({ text: z.string(), nested: z.object({ list: z.array(z.number()), inner: z.object({ k: z.string() }) }) })',
    input: { text: 'epsilon', nested: { list: [3, 1, 2], inner: { k: 'v' } } },
  },
  {
    id: 'f',
    tool: 'bind_f_extra',
    what: 'an unknown extra key the schema strips',
    schema: 'z.object({ text: z.string() })',
    input: { text: 'zeta', stray: 'remove-me' },
  },
];

const message = (c) => `bind ${c.id}`;

/** The same rule as `packages/agent-kit/src/approval-ledger.ts`'s private `canonical`, copied so
 *  the proof can PRINT the two strings that a differing hash comes from. It is never used to
 *  decide anything: the verdict below is over `payloadFingerprint`, the real function. */
const CANONICAL_SRC = `
export function canonicalForProof(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value as object)) return '"[cycle]"';
  seen.add(value as object);
  if (Array.isArray(value)) return \`[\${value.map((v) => canonicalForProof(v, seen)).join(",")}]\`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return \`{\${keys.map((k) => \`\${JSON.stringify(k)}:\${canonicalForProof((value as Record<string, unknown>)[k], seen)}\`).join(",")}}\`;
}
`;

/** The hook: the ASK side. Reads `action.input` off eve's own `input.requested` event, exactly as
 *  `services/chief-of-staff/agent/hooks/approval-record.ts` does, and writes the fingerprint,
 *  the call id and the canonical string to a file instead of to Postgres. */
const HOOK_SRC = `
import { appendFileSync } from "node:fs";
import { defineHook, type HookContext } from "eve/hooks";
import { payloadFingerprint } from "@lares/agent-kit/approval-ledger";
import { canonicalForProof } from "../../lib/binding-canonical.js";

async function onInputRequested(event: unknown, _ctx: HookContext): Promise<void> {
  const requests = (event as { data?: { requests?: unknown } } | undefined)?.data?.requests;
  if (!Array.isArray(requests)) return;
  for (const req of requests) {
    const r = req as { kind?: unknown; requestId?: unknown; action?: { callId?: unknown; toolName?: unknown; input?: unknown } };
    if (r.kind !== "tool-approval") continue;
    const toolName = r.action?.toolName;
    if (typeof toolName !== "string" || !toolName.startsWith("bind_")) continue;
    appendFileSync(process.env.BINDING_LOG!, JSON.stringify({
      side: "ask",
      tool: toolName,
      callId: r.action?.callId ?? null,
      requestId: r.requestId ?? null,
      fingerprint: payloadFingerprint(toolName, r.action?.input),
      canonical: canonicalForProof(r.action?.input),
      keys: r.action?.input && typeof r.action.input === "object" ? Object.keys(r.action.input as object).sort() : null,
    }) + "\\n");
  }
}

export default defineHook({ events: { "input.requested": onInputRequested } });
`;

/** One probe tool per shape: `always()` so it parks on a card every time, and an `execute` that
 *  takes the RAW first argument (no destructuring — the same thing W7A-s6 had to change in 14
 *  chief-of-staff tools) and records the EXECUTE side. */
const toolSource = (c) => `
import { appendFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { callIdFrom, payloadFingerprint } from "@lares/agent-kit/approval-ledger";
import { canonicalForProof } from "../../lib/binding-canonical.js";

export default defineTool({
  description: ${JSON.stringify(`Approval binding probe (${c.what}).`)},
  inputSchema: ${c.schema},
  approval: always(),
  execute: async (input: unknown, ctx: unknown) => {
    const c = ctx as { callId?: unknown; toolCallId?: unknown } | null;
    appendFileSync(process.env.BINDING_LOG!, JSON.stringify({
      side: "execute",
      tool: ${JSON.stringify(c.tool)},
      // What the kit's helper reads (\`ctx.toolCallId\`) vs what eve 0.60.1's \`ToolContext\` declares.
      callId: callIdFrom(ctx) ?? null,
      ctxCallId: typeof c?.callId === "string" ? c.callId : null,
      ctxToolCallId: typeof c?.toolCallId === "string" ? c.toolCallId : null,
      ctxKeys: c ? Object.keys(c).sort() : null,
      fingerprint: payloadFingerprint(${JSON.stringify(c.tool)}, input),
      canonical: canonicalForProof(input),
      keys: input && typeof input === "object" ? Object.keys(input as object).sort() : null,
    }) + "\\n");
    return { ran: ${JSON.stringify(c.tool)} };
  },
});
`;

/** Two surgical replacements in the COPY of `agent/agent.ts`. Both anchors are asserted, so a
 *  future edit to the scripted model fails this script loudly instead of silently proving nothing. */
function patchScriptedModel(root) {
  const file = join(root, 'agent/agent.ts');
  let text = readFileSync(file, 'utf8');
  const anchorTop = 'const acted = new Set<string>();';
  const anchorTool = 'const tool = msg.startsWith("write")';
  assert.ok(text.includes(anchorTop), 'agent/agent.ts no longer declares `acted` — re-anchor the patch');
  assert.ok(text.includes(anchorTool), 'agent/agent.ts no longer dispatches on "write" — re-anchor the patch');
  const table = Object.fromEntries(CASES.map((c) => [message(c), { tool: c.tool, input: c.input }]));
  text = text.replace(
    anchorTop,
    `${anchorTop}\n\n// Added by scripts/approval-binding-proof.mjs in a disposable copy of this package.\nconst BIND_CASES: Record<string, { tool: string; input: unknown }> = ${JSON.stringify(table, null, 2)};\n`,
  );
  text = text.replace(
    anchorTool,
    `const bind = BIND_CASES[msg];\n  if (bind) {\n    return toolResults.some((r) => r.name === bind.tool)\n      ? \`DONE:\${msg}\`\n      : { toolCalls: [{ name: bind.tool, input: bind.input as Record<string, unknown> }] };\n  }\n\n  ${anchorTool}`,
  );
  writeFileSync(file, text);
}

/** The driver, as one eval — `session.send` parks a real card, `respondAll("approve")` answers it,
 *  and the next assertion is that the tool actually ran. Written into the COPY only. */
const EVAL_SRC = `
import { defineEval } from "eve/evals";

const CASES = ${JSON.stringify(CASES.map((c) => ({ id: c.id, tool: c.tool, message: message(c) })), null, 2)};

export default defineEval({
  async test(t) {
    const session = await t.session();
    for (const c of CASES) {
      const parked = await session.send(c.message);
      const requests = parked.inputRequests ?? [];
      if (requests.length !== 1) throw new Error(\`\${c.id}: expected exactly one card, got \${requests.length}\`);
      if (requests[0]?.kind !== "tool-approval") throw new Error(\`\${c.id}: expected a tool approval, got \${requests[0]?.kind}\`);
      await session.respondAll("approve");
      t.log(\`\${c.id} \${c.tool}: parked on one card, approved\`);
    }
  },
});
`;

function fitOut(root) {
  patchScriptedModel(root);
  // Only this run's eval is built; the package's own eval files are not part of this proof.
  rmSync(join(root, 'evals'), { recursive: true, force: true });
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(join(root, 'evals/evals.config.ts'), 'import { defineEvalConfig } from "eve/evals";\nexport default defineEvalConfig({ maxConcurrency: 1 });\n');
  writeFileSync(join(root, 'evals/binding.eval.ts'), EVAL_SRC);
  writeFileSync(join(root, 'lib/binding-canonical.ts'), CANONICAL_SRC);
  mkdirSync(join(root, 'agent/hooks'), { recursive: true });
  writeFileSync(join(root, 'agent/hooks/binding-record.ts'), HOOK_SRC);
  for (const c of CASES) writeFileSync(join(root, `agent/tools/${c.tool}.ts`), toolSource(c));
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** The four box files and two synthetic rows `all-evals.mjs` installs — the shared approval
 *  authority guard and the definition cache read them. Applied to a database of this run's own,
 *  so nothing in the container's default database is touched. */
async function seed(uri) {
  const pool = new Pool({ connectionString: uri });
  try {
    for (const name of ['039_agent_definitions.sql', '042_agent_resources.sql', '044_agent_door_connections.sql', '045_agent_runtime_control.sql'])
      await pool.query(readFileSync(resolve(source, '../../services/box/sql', name), 'utf8'));
    await pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
      VALUES ('board-evals','192.0.2.1','synthetic-unused','owned','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','ready',false)`);
    await pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,applied_revision)
      VALUES ('board-evals','slack','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','owner@example.test','U_SYNTHETIC','22222222-2222-4222-8222-222222222222')`);
  } finally {
    await pool.end();
  }
}

let container, db;
const apps = [];
const findings = [];
try {
  await ensureProbeExtensionBuilt();
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  const uriFor = (name) => container.getConnectionUri().replace(/\/[^/?]*(\?|$)/, `/${name}$1`);

  await db.query('CREATE DATABASE binding');
  await seed(uriFor('binding'));
  const app = makeApp(uriFor('binding'), '0'); // schedules off: nothing here needs a tick
  apps.push(app);
  const { root: cwd, env, eve } = app;
  env.BINDING_LOG = join(cwd, 'BINDING_LOG');
  writeFileSync(env.BINDING_LOG, '');
  fitOut(cwd);
  let started = Date.now();
  await run(eve, ['build'], { cwd, env });
  console.log(`fixture built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  abort.signal.throwIfAborted();
  started = Date.now();
  const evalRun = await run(eve, ['eval', 'binding', '--verbose', '--strict', '--skip-report', '--timeout', '300000', '--max-concurrency', '1'], { cwd, env, timeout: 600_000 });
  console.log(`${evalRun.stdout.trim()}\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const recorded = lines(env.BINDING_LOG);
  for (const c of CASES) {
    const mine = recorded.filter((l) => l.tool === c.tool);
    const ask = mine.find((l) => l.side === 'ask');
    const exec = mine.find((l) => l.side === 'execute');
    assert.ok(ask, `${c.id}: eve's input.requested carried no card for ${c.tool}`);
    assert.ok(exec, `${c.id}: the approved call never executed`);
    assert.equal(mine.length, 2, `${c.id}: expected exactly one ask and one execution, got ${mine.length} lines`);
    const verdict = {
      ...c,
      equal: ask.fingerprint === exec.fingerprint,
      callIdsMatch: ask.callId !== null && ask.callId === exec.callId,
      ask,
      exec,
    };
    findings.push(verdict);
    console.log(
      `${c.id} ${c.tool}: payload ${verdict.equal ? 'EQUAL' : 'DIFFERENT'}` +
        ` · callIdFrom(ctx) ${verdict.callIdsMatch ? 'matches' : 'DOES NOT MATCH'} the card` +
        ` (card ${ask.callId} · callIdFrom ${exec.callId} · ctx.callId ${exec.ctxCallId} · ctx.toolCallId ${exec.ctxToolCallId})`,
    );
    if (!verdict.equal) {
      console.log(`    ask     ${ask.canonical}`);
      console.log(`    execute ${exec.canonical}`);
    }
  }
  console.log(`execute-time ToolContext keys: ${JSON.stringify(findings[0]?.exec.ctxKeys)}`);

  const report = [
    '| case | shape | ask canonical | execute canonical | payload | card callId | callIdFrom(ctx) | ctx.callId |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...findings.map((f) => `| ${f.id} | ${f.what} | \`${f.ask.canonical}\` | \`${f.exec.canonical}\` | ${f.equal ? 'equal' : '**different**'} | \`${f.ask.callId}\` | ${f.exec.callId === null ? '**undefined**' : `\`${f.exec.callId}\``} | \`${f.exec.ctxCallId}\` |`),
  ].join('\n');
  console.log(`\n${report}\n`);
  // The two verdicts are independent and fail in opposite directions, so they are never merged:
  // a differing PAYLOAD would refuse every approved call; a missing CALL ID refuses nothing and
  // silently disables the whole check (`assertApprovedCall` passes when there is no call id).
  const differing = findings.filter((f) => !f.equal);
  const unmatched = findings.filter((f) => !f.callIdsMatch);
  console.log(differing.length === 0
    ? `PAYLOAD: PASS — all ${findings.length} shapes hash identically on both sides; no approved call would be refused as "not what the card showed".`
    : `PAYLOAD: FAIL — ${differing.map((f) => f.id).join(', ')} would be refused on every approved call.`);
  console.log(unmatched.length === 0
    ? `CALL ID: PASS — callIdFrom(ctx) equals the card's callId for all ${findings.length} shapes.`
    : `CALL ID: FAIL — callIdFrom(ctx) is ${JSON.stringify(unmatched[0].exec.callId)} for ${unmatched.map((f) => f.id).join(', ')}; the card is never found and the payload check never runs.`);
  if (process.env.BINDING_PROOF_OUT) writeFileSync(process.env.BINDING_PROOF_OUT, `${report}\n`);
  if (differing.length > 0 || unmatched.length > 0) process.exitCode = 1;
} finally {
  try {
    if (!process.env.BINDING_PROOF_KEEP) for (const app of apps) app.dispose();
    else console.log(`kept: ${apps.map((a) => a.root).join(' ')}`);
  } finally {
    try { await db?.end(); } finally { await container?.stop(); }
  }
}
