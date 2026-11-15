/**
 * tainted-approval-proof.mjs — does `asksAfterUntrustedText()` actually FIND the taint?
 *
 * `packages/agent-kit/src/tainted-approval.ts` raises an approval card for a fetch made in a turn
 * that has already read somebody else's words. It finds out by looking the turn up in
 * `origin-taint.ts`'s per-turn map, under the key `turnKeyFrom(ctx)` builds from eve's
 * `ApprovalContext`. The taint is WRITTEN under two other keys: one that a reading tool's own
 * `execute` builds from its `ToolContext` (`catalogue/read_url.ts`), and one that
 * `agent/hooks/origin-taint.ts` builds from a `call.settled` event's turn id.
 *
 * THREE KEYS, THREE DIFFERENT eve SURFACES, AND NOBODY HAS SEEN THEM AGREE. They were established
 * by reading eve's `dist/`, never observed. The failure mode is SILENT in the dangerous direction:
 * if the policy's key differs from the writers' keys, `currentTaint` answers `undefined`, the
 * policy returns `"not-applicable"`, no card is ever raised, and the tool behaves exactly as it
 * did before the control existed. Nothing logs, nothing throws, every unit test still passes —
 * they all build their own contexts by hand. (The same class of mistake as `callIdFrom`, which
 * once read `ctx.toolCallId` where eve passes `ctx.callId`.)
 *
 * WHAT THIS RUNS. A real eve 1.0 runtime, a real Postgres, a scripted model, no credential —
 * the technique of `approval-binding-proof.mjs`: a disposable copy of this package, probe tools and
 * a hook written into the COPY only, one eval, ~40 s. The probes import the REAL
 * `asksAfterUntrustedText`, `taintTurn`, `turnKeyFrom` and `clearTurn` from `@lares/agent-kit` —
 * never a copy — so what is measured is the shipping control, not a re-implementation.
 *
 * THE FOUR TURNS, all in ONE session (turn isolation is only a question inside a session):
 *   t1  the gated tool alone, nothing tainting         → expect NO card, and it runs
 *   t2  the reading probe, then the gated tool         → expect ONE card; approve; it runs
 *   t3  the gated tool alone again, after t2's taint   → expect NO card (turn isolation)
 *   t4  the reading probe, then a gated tool whose
 *       `approval:` is the bare production expression  → expect ONE card (the wrapper in t2 is
 *                                                        not what made the card appear)
 *
 * The gated tool in t1–t3 wraps the real policy only to RECORD the key it looks up — the wrapper
 * calls the real `turnKeyFrom(ctx)` (the policy's own first line) and then the real policy, and
 * returns the real policy's answer untouched. t4's tool carries `approval: asksAfterUntrustedText()`
 * written exactly as `services/chief-of-staff/catalogue/read_url.ts` writes it.
 *
 * EVERY LINE CARRIES `process.pid`. The taint map is module-level memory in one process. If eve
 * ran the approval policy in a different process or worker from the hook and the tool, the lookup
 * would miss for that reason alone — so the pid is part of the evidence, not an aside.
 *
 * NOT IN SCOPE. `read_url`'s own `assertApproval` re-check (proven by `approval-binding-proof.mjs`) and the Notion/Google branches. This proof is about one question: does the policy
 * find the taint.
 *
 * Run: `node packages/board-evals/scripts/tainted-approval-proof.mjs` (Docker running). One eve
 * process at a time; the container and every temporary directory are disposed in `finally`.
 * Results: `packages/board-evals/proofs/tainted-approval-2026-11-11.md` (eve 1.0.0-rc.9); the
 * 2026-09-20 record is the same proof on eve 0.60.1.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { makeApp, run, source, abort, ensureProbeExtensionBuilt } from './proof-harness.mjs';

/** The four turns, in order, in one session. `seq` is what the scripted model emits, one tool per
 *  model call, until each has come back with a result carrying this turn's unique message. */
const TURNS = [
  {
    id: 't1',
    message: 't1 gate only',
    seq: ['gated_probe'],
    what: 'the gated tool alone — nothing tainting ran in this turn',
    expectCards: 0,
    expectRan: 'gated_probe',
  },
  {
    id: 't2',
    message: 't2 taint gate',
    seq: ['taint_reader', 'gated_probe'],
    what: 'a reading tool taints the turn, then the gated tool is called',
    expectCards: 1,
    expectRan: 'gated_probe',
  },
  {
    id: 't3',
    message: 't3 gate only',
    seq: ['gated_probe'],
    what: 'the gated tool alone in the NEXT turn of the same session, after t2 tainted',
    expectCards: 0,
    expectRan: 'gated_probe',
  },
  {
    id: 't4',
    message: 't4 taint plain',
    seq: ['taint_reader', 'gated_plain'],
    what: 'the same as t2, against the bare `approval: asksAfterUntrustedText()` production expression',
    expectCards: 1,
    expectRan: 'gated_plain',
  },
];

/** The recorder + the watched policy. Written into the COPY's `lib/`. The policy here is the REAL
 *  one: `watched` calls `asksAfterUntrustedText()`'s returned function and returns its answer
 *  unchanged; the only addition is a line in the log naming the key `turnKeyFrom(ctx)` produced,
 *  which is literally the first thing the real policy does with `ctx`. */
const PROBE_SRC = `
import { appendFileSync } from "node:fs";
import type { ApprovalStatus } from "eve/tools/approval";
import { asksAfterUntrustedText } from "@lares/agent-kit/tainted-approval";
import { turnKeyFrom } from "@lares/agent-kit/origin-taint";

/** One JSON line per observation. Every line carries the pid: the taint map is process-local. */
export function note(entry: Record<string, unknown>): void {
  appendFileSync(process.env.TAINT_LOG!, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
}

/** What a context says about itself, without assuming any of it is there. */
export function shapeOf(ctx: unknown): Record<string, unknown> {
  const c = (typeof ctx === "object" && ctx !== null ? ctx : {}) as {
    session?: { id?: unknown; turn?: { id?: unknown; sequence?: unknown } };
    callId?: unknown;
    toolName?: unknown;
  };
  return {
    ctxKeys: typeof ctx === "object" && ctx !== null ? Object.keys(ctx).sort() : null,
    sessionId: typeof c.session?.id === "string" ? c.session.id : null,
    ctxTurnId: typeof c.session?.turn?.id === "string" ? c.session.turn.id : null,
    ctxTurnSequence: c.session?.turn?.sequence ?? null,
    callId: typeof c.callId === "string" ? c.callId : null,
  };
}

export function watched(tool: string): (ctx?: unknown) => Promise<ApprovalStatus> {
  const real = asksAfterUntrustedText();
  return async (ctx?: unknown): Promise<ApprovalStatus> => {
    const key = turnKeyFrom(ctx);
    const verdict = await real(ctx);
    // eve's ApprovalContext carries the tool input, so a consult can be attributed to the SEND it
    // belongs to — which a log position cannot do: eve consults the policy a second time when the
    // approved call resumes, and that consult lands after its own turn's record.
    const input = (typeof ctx === "object" && ctx !== null ? (ctx as { toolInput?: { text?: unknown } }).toolInput : undefined);
    note({ side: "policy", tool, key: key ?? null, verdict, mark: typeof input?.text === "string" ? input.text : null, ...shapeOf(ctx) });
    return verdict;
  };
}
`;

/** The hook — `agent/hooks/origin-taint.ts` reduced to this proof's one tool, field for field:
 *  `call.settled`, the call's name read from the session view by its `callId`, and
 *  `turnKeyFrom(ctx, <the event's turn id>)` with the turn id taken from `data` and then `scope`,
 *  exactly as production's `keyOf` does. The turn-boundary clears are kept because production
 *  keeps them (`turn.started` and `turn.settled`; eve 1.0 ends a turn with one event whatever the
 *  outcome), and turn isolation is one of the questions. */
const HOOK_SRC = `
import { call as callOf } from "eve/events";
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { clearTurn, taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { note, shapeOf } from "../../lib/taint-probe.js";

function turnIdOf(event: unknown): unknown {
  const e = typeof event === "object" && event !== null ? (event as { data?: unknown; scope?: unknown }) : undefined;
  const field = (v: unknown): unknown => (typeof v === "object" && v !== null ? (v as { turnId?: unknown }).turnId : undefined);
  return field(e?.data) ?? field(e?.scope);
}

function callFromView(ctx: HookContext, callId: string): { name: string; kind?: string } | undefined {
  try {
    const view = (ctx as unknown as { view?: never } | null | undefined)?.view;
    if (view === undefined) return undefined;
    const row = callOf(view, callId);
    return row !== undefined && typeof row.name === "string" ? { name: row.name, kind: row.kind } : undefined;
  } catch {
    return undefined;
  }
}

async function onCallSettled(event: HookEvent<"call.settled">, ctx: HookContext): Promise<void> {
  try {
    const callId = (event?.data as { callId?: unknown } | undefined)?.callId;
    if (typeof callId !== "string") return;
    const asked = callFromView(ctx, callId);
    if (asked === undefined) { note({ side: "hook-error", message: "call.settled named a call the view does not know: " + callId }); return; }
    if (asked.kind !== undefined && asked.kind !== "tool") return;
    if (asked.name !== "taint_reader") return;
    const eventTurnId = turnIdOf(event);
    const key = turnKeyFrom(ctx, eventTurnId);
    if (key) taintTurn(key, "third_party");
    note({
      side: "hook",
      tool: asked.name,
      key: key ?? null,
      eventTurnId: typeof eventTurnId === "string" ? eventTurnId : null,
      ...shapeOf(ctx),
    });
  } catch (err) {
    note({ side: "hook-error", message: String(err) });
  }
}

function boundary(name: string) {
  return async (event: unknown, ctx: HookContext): Promise<void> => {
    try {
      const eventTurnId = turnIdOf(event);
      const key = turnKeyFrom(ctx, eventTurnId);
      if (key) clearTurn(key);
      note({ side: "boundary", event: name, key: key ?? null, eventTurnId: typeof eventTurnId === "string" ? eventTurnId : null });
    } catch (err) {
      note({ side: "hook-error", message: String(err) });
    }
  };
}

export default defineHook({
  events: {
    "call.settled": onCallSettled,
    "turn.started": boundary("turn.started"),
    "turn.settled": boundary("turn.settled"),
  },
});
`;

/** The reading probe. No `approval:`, so it never parks — it stands for `read_url` on the read that
 *  brings the outside words in, and taints from inside `execute` the way that tool does. */
const READER_SRC = `
import { defineTool } from "eve/tools";
import { z } from "zod";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { note, shapeOf } from "../../lib/taint-probe.js";

export default defineTool({
  description: "Reading probe: brings back words the owner did not write and taints the turn from inside execute.",
  inputSchema: z.object({ text: z.string() }),
  async execute(input, ctx) {
    const key = turnKeyFrom(ctx);
    if (key) taintTurn(key, "third_party");
    note({ side: "reader-execute", tool: "taint_reader", key: key ?? null, mark: input.text, ...shapeOf(ctx) });
    return { ran: "taint_reader", mark: input.text };
  },
});
`;

/** The gated probes. `gated_probe` carries the watched policy; `gated_plain` carries the bare
 *  production expression, byte for byte as `catalogue/read_url.ts` writes it. */
const gatedSource = (name, approval, imports) => `
import { defineTool } from "eve/tools";
import { z } from "zod";
${imports}
import { note, shapeOf } from "../../lib/taint-probe.js";

export default defineTool({
  description: "Gated probe: its approval policy is the real asksAfterUntrustedText().",
  inputSchema: z.object({ text: z.string() }),
  async execute(input, ctx) {
    note({ side: "gated-execute", tool: ${JSON.stringify(name)}, key: turnKeyFrom(ctx) ?? null, mark: input.text, ...shapeOf(ctx) });
    return { ran: ${JSON.stringify(name)}, mark: input.text };
  },
  approval: ${approval},
});
`;

const TOOLS = {
  taint_reader: READER_SRC,
  gated_probe: gatedSource(
    'gated_probe',
    'watched("gated_probe")',
    'import { turnKeyFrom } from "@lares/agent-kit/origin-taint";\nimport { watched } from "../../lib/taint-probe.js";',
  ),
  gated_plain: gatedSource(
    'gated_plain',
    'asksAfterUntrustedText()',
    'import { turnKeyFrom } from "@lares/agent-kit/origin-taint";\nimport { asksAfterUntrustedText } from "@lares/agent-kit/tainted-approval";',
  ),
};

/** Two surgical replacements in the COPY of `agent/agent.ts`. Both anchors are asserted, so a
 *  future edit to the scripted model fails this script loudly instead of silently proving nothing.
 *
 *  The "has this tool already run THIS turn" test is over the tool RESULT carrying this turn's
 *  unique message, never over the tool name alone: results stay in the prompt across turns, so a
 *  name-only memo would make t3 answer without calling anything (the trap `agent.ts:49-53`
 *  documents for the seam messages). */
function patchScriptedModel(root) {
  const file = join(root, 'agent/agent.ts');
  let text = readFileSync(file, 'utf8');
  const anchorTop = 'const acted = new Set<string>();';
  const anchorTool = 'const tool = msg.startsWith("write")';
  assert.ok(text.includes(anchorTop), 'agent/agent.ts no longer declares `acted` — re-anchor the patch');
  assert.ok(text.includes(anchorTool), 'agent/agent.ts no longer dispatches on "write" — re-anchor the patch');
  const table = Object.fromEntries(TURNS.map((t) => [t.message, t.seq]));
  text = text.replace(
    anchorTop,
    `${anchorTop}\n\n// Added by scripts/tainted-approval-proof.mjs in a disposable copy of this package.\nconst TAINT_SEQ: Record<string, string[]> = ${JSON.stringify(table, null, 2)};\n`,
  );
  text = text.replace(
    anchorTool,
    `const taintSeq = TAINT_SEQ[msg];\n  if (taintSeq) {\n    const ranThisTurn = (name: string) =>\n      toolResults.some((r) => r.name === name && JSON.stringify(r.output ?? null).includes(msg));\n    for (const name of taintSeq) {\n      if (!ranThisTurn(name)) return { toolCalls: [{ name, input: { text: msg } }] };\n    }\n    return \`DONE:\${msg}\`;\n  }\n\n  ${anchorTool}`,
  );
  writeFileSync(file, text);
}

/** The driver, as one eval — `session.send` parks a real card, `respondAll("approve")` answers it.
 *  ONE session for all four turns: turn isolation is only a question within a session. */
const EVAL_SRC = `
import { appendFileSync } from "node:fs";
import { defineEval } from "eve/evals";

const TURNS = ${JSON.stringify(TURNS.map((t) => ({ id: t.id, message: t.message })), null, 2)};

export default defineEval({
  async test(t) {
    const session = await t.session();
    for (const turn of TURNS) {
      const sent = await session.send(turn.message);
      const requests = sent.interactions;
      appendFileSync(process.env.TAINT_LOG!, JSON.stringify({
        pid: process.pid,
        side: "turn",
        id: turn.id,
        message: turn.message,
        cards: requests.length,
        kinds: requests.map((r) => r.request.kind),
        tools: requests.map((r) => r.call?.name ?? null),
      }) + "\\n");
      if (requests.length > 0) {
        const resumed = await session.respondAll("approve");
        // A card still OPEN once the approval has been answered is a second card for the same call.
        appendFileSync(process.env.TAINT_LOG!, JSON.stringify({
          pid: process.pid,
          side: "approved",
          id: turn.id,
          message: turn.message,
          status: resumed.status,
          openCardsAfter: session.pendingInteractions.length,
        }) + "\\n");
      }
      t.log(\`\${turn.id} "\${turn.message}": \${requests.length} card(s)\`);
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
  writeFileSync(join(root, 'evals/taint.eval.ts'), EVAL_SRC);
  writeFileSync(join(root, 'lib/taint-probe.ts'), PROBE_SRC);
  mkdirSync(join(root, 'agent/hooks'), { recursive: true });
  writeFileSync(join(root, 'agent/hooks/taint-record.ts'), HOOK_SRC);
  for (const [name, src] of Object.entries(TOOLS)) writeFileSync(join(root, `agent/tools/${name}.ts`), src);
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** The four box files and two synthetic rows `all-evals.mjs` installs — the shared approval
 *  authority guard and the definition cache read them. */
async function seed(uri) {
  const pool = new Pool({ connectionString: uri });
  try {
    for (const name of ['001_baseline.sql'])
      await pool.query(readFileSync(resolve(source, '../../services/box/sql', name), 'utf8'));
    await pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending)
      VALUES ('board-evals','192.0.2.1','synthetic-unused','owned','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','ready',false)`);
    await pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,applied_revision)
      VALUES ('board-evals','slack','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','owner@example.test','U_SYNTHETIC','22222222-2222-4222-8222-222222222222')`);
  } finally {
    await pool.end();
  }
}

const short = (k) => (k === null || k === undefined ? 'none' : `${k.sessionId}/${k.turnId}`);

let container, db;
const apps = [];
try {
  await ensureProbeExtensionBuilt();
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  const uriFor = (name) => container.getConnectionUri().replace(/\/[^/?]*(\?|$)/, `/${name}$1`);

  await db.query('CREATE DATABASE taint');
  await seed(uriFor('taint'));
  const app = makeApp(uriFor('taint'), '0'); // schedules off: nothing here needs a tick
  apps.push(app);
  const { root: cwd, env, eve } = app;
  env.TAINT_LOG = join(cwd, 'TAINT_LOG');
  writeFileSync(env.TAINT_LOG, '');
  fitOut(cwd);
  let started = Date.now();
  await run(eve, ['build'], { cwd, env });
  console.log(`fixture built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  abort.signal.throwIfAborted();
  started = Date.now();
  const evalRun = await run(eve, ['eval', 'taint', '--verbose', '--strict', '--skip-report', '--timeout', '300000', '--max-concurrency', '1'], { cwd, env, timeout: 600_000 });
  console.log(`${evalRun.stdout.trim()}\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const recorded = lines(env.TAINT_LOG);
  const pids = [...new Set(recorded.map((l) => l.pid))];
  const turnLines = recorded.filter((l) => l.side === 'turn');
  // ATTRIBUTED BY MARK, NEVER BY POSITION IN THE LOG. eve consults the policy a SECOND time when an
  // approved call resumes, and that consult is emitted after its own send's record — so slicing the
  // log between `turn` lines files t2's resume consult under t3. Every probe line carries the
  // send's unique message, including the policy's (off `ApprovalContext.toolInput`).
  const byMark = (side, mark) => recorded.filter((l) => l.side === side && l.mark === mark);

  const findings = TURNS.map((t, i) => {
    const policy = byMark('policy', t.message);
    const reader = byMark('reader-execute', t.message)[0] ?? null;
    const exec = recorded.find((l) => l.side === 'gated-execute' && l.mark === t.message && l.tool === t.expectRan) ?? null;
    // The turn this send STARTED in. An untainted send never parks, so its execution is in it too.
    const origin = reader?.ctxTurnId ?? policy[0]?.ctxTurnId ?? exec?.ctxTurnId ?? null;
    return {
      ...t,
      // `gated_plain` carries the bare production expression and therefore records nothing; its
      // evidence is the card count and the execution, which is exactly what it is there to show.
      instrumented: t.expectRan === 'gated_probe',
      cards: turnLines[i]?.cards ?? null,
      origin,
      policy,
      park: policy.find((p) => p.ctxTurnId === origin) ?? null,
      // Every consult after the one that parked. eve 0.60.1 resumed an approved call in a NEW turn;
      // eve 1.0 resumes it in the SAME turn, so a re-consult is told apart by order, not by turn id.
      resume: policy.filter((p) => p !== (policy.find((q) => q.ctxTurnId === origin) ?? null)),
      executions: recorded.filter((l) => l.side === 'gated-execute' && l.mark === t.message && l.tool === t.expectRan).length,
      approved: recorded.find((l) => l.side === 'approved' && l.message === t.message) ?? null,
      hook: recorded.find((l) => l.side === 'hook' && l.key?.turnId === origin) ?? null,
      reader,
      exec,
      boundaries: recorded.filter((l) => l.side === 'boundary' && l.eventTurnId === origin),
    };
  });

  for (const f of findings) {
    console.log(`\n${f.id} "${f.message}" — ${f.what}`);
    console.log(`   cards: ${f.cards} (expected ${f.expectCards})`);
    if (f.reader) console.log(`   execute taint key : ${short(f.reader.key)}`);
    if (f.hook) console.log(`   hook taint key    : ${short(f.hook.key)}   (event turnId ${f.hook.eventTurnId}, ctx turnId ${f.hook.ctxTurnId})`);
    console.log(`   policy lookup key : ${f.instrumented ? `${short(f.park?.key)}   verdict ${JSON.stringify(f.park?.verdict ?? null)}` : 'not recorded — this turn runs the bare, unwrapped production expression'}`);
    if (f.resume.length > 0) console.log(`   re-consulted on resume in ${f.resume.map((p) => `${p.ctxTurnId} → ${JSON.stringify(p.verdict)}`).join(', ')}`);
    console.log(`   execute after     : ${f.exec ? `ran, turn ${f.exec.ctxTurnId} (seq ${f.exec.ctxTurnSequence})` : 'DID NOT RUN'}`);
  }
  const anyPolicy = findings.find((f) => f.park)?.park ?? null;
  console.log(`\nexecute-time ToolContext keys: ${JSON.stringify(findings[0]?.exec?.ctxKeys)}`);
  console.log(`ApprovalContext keys         : ${JSON.stringify(anyPolicy?.ctxKeys)}`);
  console.log(`processes in this run        : ${JSON.stringify(pids)}`);

  const t1 = findings.find((f) => f.id === 't1');
  const t2 = findings.find((f) => f.id === 't2');
  const t3 = findings.find((f) => f.id === 't3');
  const t4 = findings.find((f) => f.id === 't4');
  const q = [];
  q.push({
    id: '1',
    question: 'the policy finds a taint written by both writers in the same turn',
    pass:
      t2.cards === 1 &&
      t2.reader !== null &&
      t2.hook !== null &&
      t2.park !== null &&
      short(t2.reader.key) === short(t2.park.key) &&
      short(t2.hook.key) === short(t2.park.key) &&
      t2.park.verdict === 'user-approval',
    detail: `execute \`${short(t2.reader?.key)}\` · hook \`${short(t2.hook?.key)}\` · policy \`${short(t2.park?.key)}\` · ${t2.cards} card · verdict ${JSON.stringify(t2.park?.verdict ?? null)}`,
  });
  q.push({
    id: '1b',
    question: 'the bare `approval: asksAfterUntrustedText()` expression parks too (the wrapper is not what made the card)',
    pass: t4.cards === 1 && t4.exec !== null && t4.reader !== null && t4.hook !== null,
    detail: `${t4.cards} card · taint written under \`${short(t4.reader?.key)}\` (execute) and \`${short(t4.hook?.key)}\` (hook) · ${t4.exec ? 'ran after approval' : 'did not run'}`,
  });
  q.push({
    id: '2',
    question: 'an untainted turn raises NO card and still runs',
    pass: t1.cards === 0 && t1.exec !== null && t1.park?.verdict === 'not-applicable',
    detail: `${t1.cards} cards · policy key \`${short(t1.park?.key)}\` · verdict ${JSON.stringify(t1.park?.verdict ?? null)} · ${t1.exec ? 'ran' : 'DID NOT RUN'}`,
  });
  q.push({
    id: '3',
    question: "turn N's taint does not raise a card in turn N+1 of the same session",
    pass: t3.cards === 0 && t3.exec !== null && t3.park !== null && short(t3.park.key) !== short(t2.park?.key),
    detail: `${t3.cards} cards · t2 tainted \`${short(t2.park?.key)}\`, t3 looked up \`${short(t3.park?.key)}\` · ${t2.boundaries.filter((b) => b.event !== 'turn.started').length} turn-boundary clear(s) fired for t2's turn`,
  });
  q.push({
    id: '4',
    question: 'the approved call executes, and the turn id it sees there',
    pass: t2.exec !== null,
    detail: t2.exec
      ? `ran · park turn \`${t2.park?.ctxTurnId}\` (seq ${t2.park?.ctxTurnSequence}) → execute turn \`${t2.exec.ctxTurnId}\` (seq ${t2.exec.ctxTurnSequence}) — ${t2.exec.ctxTurnId === t2.park?.ctxTurnId ? 'SAME turn id' : 'a BRAND-NEW turn id'}`
      : 'the approved call never executed',
  });
  q.push({
    id: '4b',
    // On eve 0.60.1 this read "the policy is consulted again on resume, in the new turn, and does
    // not park a second time": the resumed call ran in a new turn, where the policy found no taint.
    // eve 1.0 resumes the approved call in the SAME turn. What the question protects is unchanged
    // and is asserted directly: one approval is enough. Whether eve consults the policy again on
    // the way is recorded as evidence, not required.
    question: 'one approval is enough: the approved call runs exactly once and no second card is raised',
    pass: t2.executions === 1 && t2.approved !== null && t2.approved.openCardsAfter === 0 && t2.approved.status !== 'failed',
    detail: `ran ${t2.executions} time(s) · open cards after the approval: ${t2.approved?.openCardsAfter ?? 'not recorded'} · request ended "${t2.approved?.status ?? 'not recorded'}" · ` +
      (t2.resume.length === 0
        ? 'the policy was NOT consulted again on resume'
        : `the policy was consulted again on resume: ${t2.resume.map((p) => `\`${p.ctxTurnId}\` → ${JSON.stringify(p.verdict)}`).join(', ')}`),
  });
  q.push({
    id: '5',
    question: 'hook, policy and execute share one process (the taint map is module-level memory)',
    pass: pids.length === 1,
    detail: `pids ${JSON.stringify(pids)}`,
  });

  const report = [
    '| # | question | verdict | evidence |',
    '| --- | --- | --- | --- |',
    ...q.map((r) => `| ${r.id} | ${r.question} | ${r.pass ? 'PASS' : '**FAIL**'} | ${r.detail} |`),
  ].join('\n');
  console.log(`\n${report}\n`);
  const keyTable = [
    '| turn | what ran | execute-side taint key | hook-side taint key | policy lookup key | verdict | card |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...findings.map((f) => `| ${f.id} | ${f.seq.join(' → ')} | ${f.reader ? `\`${short(f.reader.key)}\`` : '—'} | ${f.hook ? `\`${short(f.hook.key)}\`` : '—'} | ${f.instrumented ? `\`${short(f.park?.key)}\`` : '_unwrapped_'} | ${f.instrumented ? `\`${JSON.stringify(f.park?.verdict ?? null)}\`` : '_unwrapped_'} | ${f.cards} |`),
  ].join('\n');
  console.log(`${keyTable}\n`);

  const failed = q.filter((r) => !r.pass);
  console.log(failed.length === 0
    ? `TAINTED APPROVAL: PASS — all ${q.length} questions answered as designed; the card really appears, and only where it should.`
    : `TAINTED APPROVAL: FAIL — ${failed.map((r) => r.id).join(', ')}.`);
  if (process.env.TAINT_PROOF_OUT) writeFileSync(process.env.TAINT_PROOF_OUT, `${report}\n\n${keyTable}\n`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  try {
    if (!process.env.TAINT_PROOF_KEEP) for (const app of apps) app.dispose();
    else console.log(`kept: ${apps.map((a) => a.root).join(' ')}`);
  } finally {
    try { await db?.end(); } finally { await container?.stop(); }
  }
}
