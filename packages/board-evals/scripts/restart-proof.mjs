import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { run } from './proof-harness.mjs';
// Hash every compiled file, not just the entrypoint, across the measured boundary.
function revision(root) {
  const hash = createHash('sha256');
  for (const file of readdirSync(join(root, '.output'), { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => join(d.parentPath, d.name)).sort()) {
    hash.update(relative(root, file)); hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
export async function restartProof(app) {
  const { root: cwd, env, eve } = app;
  const revisionBefore = revision(cwd);
  writeFileSync(env.BOARD_LEVELS, '{"vault":"gated"}');
  const count = needle => readFileSync(env.BOARD_LOG, 'utf8').split('\n').filter(line => line === needle).length;
  for (const [name, prompt, needle] of [
    ['authored control', 'write restart-control', 'write restart-control'],
    ['definition catalogue', 'seam call vault_list', 'pool-vault-list'],
  ]) {
    const before = count(needle);
    const first = await run(eve, ['invoke', prompt], { cwd, env, acceptedCodes: [0, 3] });
    const card = JSON.parse(first.stdout);
    assert.equal(card.status, 'input-required', name);
    assert.equal(card.requests.length, 1, name);
    assert.equal(card.requests[0].kind, 'tool-approval', name);
    assert.equal(count(needle), before, 'Executed before approval');
    assert.equal(revision(cwd), revisionBefore, 'Compiled revision changed before restart');
    // run() has observed close AND absence of the owned process group. Nothing remains alive.
    const second = await run(eve, ['invoke', '--resume', 'approve'], { cwd, env, acceptedCodes: [0, 3], input: first.stdout });
    assert.notEqual(first.pid, second.pid, 'No process boundary');
    assert.equal(count(needle), before + 1, 'Approval must execute exactly once after restart');
    let response = second.stdout;
    // The in-memory scripted model forgets after EVERY restart and proposes again.
    // Cancel three distinct proposals across three further process boundaries; their
    // pending continuation is discarded only with this harness-owned world on cleanup.
    let cancellations = 0;
    for (; cancellations < 3 && JSON.parse(response).status === 'input-required'; cancellations++) {
      response = (await run(eve, ['invoke', '--resume', 'cancel'], { cwd, env, acceptedCodes: [0, 3], input: response })).stdout;
      assert.equal(count(needle), before + 1, 'Cancellation executed a duplicate side effect');
    }
    assert.equal(cancellations, 3, 'Expected the deliberate repeated mock proposals to exercise cancellation');
    assert.notEqual(JSON.parse(response).status, 'failed', 'Resumed conversation failed');
    assert.equal(revision(cwd), revisionBefore, 'Compiled revision changed during restart');
    console.log(`REQUIRED: restart ${name} PASS (exited pid ${first.pid} -> new pid ${second.pid}; exactly one effect; ${cancellations} cancellations added zero effects)`);
  }
}
