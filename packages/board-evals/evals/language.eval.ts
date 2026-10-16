import { defineEval } from 'eve/evals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from './definition-fixture.js';
export default defineEval({ async test(t) {
  const file = join(process.env.LARES_DEFINITION_DIR!, 'agent.json'), before = readFileSync(file, 'utf8');
  // `t.send` now starts a brand-new session on every call (eve 0.59's eval API), so the
  // "next turn, same conversation" half of this proof needs one captured session reused across
  // both sends — a bare `t.send` twice would put each call in its own session and this would
  // pass for the wrong reason (no leakage to prove, because there is nothing shared to leak).
  const session = await t.session();
  await session.send('seam setlang en');
  check((await session.send('seam system')).message?.includes('Write in en for this conversation'), 'Language switch lost on next turn');
  check(!(await (await t.session()).send('seam system')).message?.includes('Write in en for this conversation'), 'Language leaked across sessions');
  check(readFileSync(file, 'utf8') === before, 'Language tool rewrote definition');
  t.log('REQUIRED: conversation language isolation PASS');
}});
