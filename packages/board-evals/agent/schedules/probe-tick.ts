import { appendFileSync } from 'node:fs';
import { defineSchedule } from 'eve/schedules';
import { scheduleEnabled } from '@lares/agent-kit/schedule-switch';
import { fixtureDefinition } from '../../lib/definition.js';
export default defineSchedule({
  cron: '0 0 1 1 *',
  async run() {
    if (!process.env.LARES_DEFINITION_DIR) return;
    const { loaded } = await fixtureDefinition();
    if (!scheduleEnabled(loaded.definition, 'probe-tick')) return;
    appendFileSync(process.env.BOARD_LOG!, 'schedule-tick\n');
  },
});
