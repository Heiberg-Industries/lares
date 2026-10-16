import { defineEval } from 'eve/evals';
import { readFileSync } from 'node:fs';
import { valid, writeDefinition, check } from './definition-fixture.js';
export default defineEval({ async test(t) {
  const count = () => readFileSync(process.env.BOARD_LOG!, 'utf8').split('\n').filter(x => x === 'schedule-tick').length;
  const live = process.env.EVE_SCHEDULES_LIVE === '1';
  try {
    writeDefinition();
    const before = count();
    await t.target.dispatchSchedule('probe-tick');
    check(count() === before + (live ? 1 : 0), 'Enabled tick did not obey installation switch');
    writeDefinition({ ...valid, schedules: { 'probe-tick': { on: false } } });
    await t.target.dispatchSchedule('probe-tick');
    check(count() === before + (live ? 1 : 0), 'Disabled next tick executed');
    writeDefinition();
    await t.target.dispatchSchedule('probe-tick');
    check(count() === before + (live ? 2 : 0), 'Reenabled tick did not reread definition');
    t.log(`REQUIRED: schedule definition next tick and installation switch=${live ? '1' : '0'} PASS`);
  } finally { writeDefinition(); }
}});
