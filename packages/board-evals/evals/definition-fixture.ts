import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const valid = {
  name: 'board-evals', model: 'fixture-brain', persona: 'voice.md', role: 'creative',
  // W5C-s9: `atlas` left KNOWN_CAPABILITIES at s5/s6 — the grant this fixture drives is the one
  // area of `vault` the pool's `vault_list` tool needs (`catalogue/index.ts`).
  grants: [{ capability: 'vault', scope: 'write-with-confirm', areas: ['shared'] }],
  autonomy: { vault: 'autonomous' }, schedules: { 'probe-tick': { on: true } },
};
export function writeDefinition(value: unknown = valid, duties = 'Mind the synthetic shop.') {
  const dir = process.env.LARES_DEFINITION_DIR!;
  writeFileSync(join(dir, 'agent.json'), typeof value === 'string' ? value : JSON.stringify(value));
  writeFileSync(join(dir, 'voice.md'), 'A synthetic voice.');
  writeFileSync(join(dir, 'duties.md'), duties);
}
export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
