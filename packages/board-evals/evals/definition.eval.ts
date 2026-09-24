import { defineEval } from 'eve/evals';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { valid, writeDefinition, check } from './definition-fixture.js';
export default defineEval({ async test(t) {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    writeDefinition();
    const first = await t.session();
    const initialTools = (await first.send('seam tools')).message?.split(' ') ?? [];
    check(initialTools.includes('vault_list') && !initialTools.includes('gmail_list'), 'Granted pool subset mismatch');
    writeDefinition({ ...valid, grants: [{ capability: 'gmail', scope: 'read' }], autonomy: { gmail: 'autonomous' } });
    const switchedTools = (await (await t.session()).send('seam tools')).message?.split(' ') ?? [];
    check(switchedTools.includes('gmail_list') && !switchedTools.includes('vault_list'), 'Changed capability subset mismatch');
    check((await first.send('seam system')).message?.includes('Mind the synthetic shop.'), 'Valid duties missing');
    writeDefinition({ ...valid, grants: [], autonomy: {} }, 'Narrowed duties.');
    const narrowed = await t.session();
    check(!(await narrowed.send('seam tools')).message?.split(' ').includes('vault_list'), 'Ungranted pool tool exposed');
    check((await first.send('seam tools')).message?.split(' ').includes('vault_list'), 'In-flight tool set changed');
    writeDefinition();
    await (await t.session()).send('seam system'); // remember the baseline in real Postgres
    for (const broken of ['{ not json', { ...valid, model: 'claude-opus-5' }]) {
      writeDefinition(broken, 'UNVALIDATED DUTIES');
      const cachedSession = await t.session();
      const turn = await cachedSession.send('seam system');
      check((await cachedSession.send('seam tools')).message?.split(' ').includes('vault_list'), 'Last-valid grants not used');
      check(turn.status !== 'failed' && turn.message?.includes('Mind the synthetic shop.'), 'Last-valid duties not used');
      check(!turn.message?.includes('UNVALIDATED DUTIES'), 'Invalid duties leaked');
      const { rows } = await db.query("SELECT status, duties FROM agent_definitions WHERE name='board-evals'");
      check(rows[0]?.status === 'invalid' && rows[0]?.duties === 'Mind the synthetic shop.', 'Cache failed to preserve last valid contents/status');
    }
    // No remembered configuration: the same runtime resolution must refuse the new conversation.
    await db.query("DELETE FROM agent_definitions WHERE name='board-evals'");
    const modelBefore = readFileSync(process.env.PROOF_MODEL_LOG!, 'utf8');
    check(modelBefore.length > 0, 'Positive controls never invoked mock model');
    const cold = await (await t.session()).send('seam system');
    check(readFileSync(process.env.PROOF_MODEL_LOG!, 'utf8') === modelBefore, 'Cold invalid definition reached model');
    check(cold.events.some(e => e.type === 'turn.failed') && !cold.message, `Cold-invalid turn was allowed: ${cold.message}`);
    // Force a real failed read, repair the file before fallback invocation, and still refuse.
    writeFileSync(`${process.env.LARES_DEFINITION_DIR}/repair-on-failure.json`, JSON.stringify(valid));
    const raced = await (await t.session()).send('seam system');
    check(raced.events.some(e => e.type === 'turn.failed') && !raced.message, 'Repair race admitted the failed session');
    check(readFileSync(process.env.PROOF_MODEL_LOG!, 'utf8') === modelBefore, 'Repair race reached model');
    check(JSON.parse(readFileSync(`${process.env.LARES_DEFINITION_DIR}/agent.json`, 'utf8')).model === valid.model, 'Race did not actually repair the file');
    const recovered = await (await t.session()).send('seam tools');
    check(recovered.message?.split(' ').includes('vault_list'), 'A new valid session did not recover after repair');
    t.log('REQUIRED: granted subset and invalid definition (last-valid + cold refusal) PASS');
  } finally { writeDefinition(); await db.end(); }
}});
