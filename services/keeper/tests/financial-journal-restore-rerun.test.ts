// A restore that stopped partway and is run again freezes the new server's spending ledger a
// second time (services/box/ops/restore.sh). The keeper is already stopped then, so the host
// command opens the journal itself (bin/budget-financial.ts freeze --host, its fallback). This is
// that path on a real journal: open a ledger that the first run froze, freeze it for restore
// again, and check that it is accepted, adds exactly one freeze record and changes nothing else.
import {readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {journalFixture, platformTestJournalLock, testJournalUid} from './helpers/financial-journal.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });

function preparedLedger() {
  const fixture = journalFixture();
  directories.push(fixture.directory);
  const directory = join(fixture.directory, 'prepared'), options = {ownershipUid: testJournalUid, lock: platformTestJournalLock};
  const preparation = HostFinancialJournal.prepareFresh(directory, {systemIdentifier: '74683378529478211', postmasterStartedAt: '2026-10-22T00:00:00.123456Z', databaseOid: '16384'}, options);
  try { preparation.complete(); } finally { preparation.close(); }
  const open = () => HostFinancialJournal.openExisting(directory, {...options, requirePrepared: true});
  const records = () => readFileSync(join(directory, 'journal.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line).record);
  return {open, records};
}

it('a second restore freeze on an already frozen ledger is accepted and adds exactly one freeze record', async () => {
  const ledger = preparedLedger();
  const first = ledger.open();
  await first.freezeForRestore();
  first.close();
  const afterFirst = ledger.records();
  expect(afterFirst.at(-1)).toMatchObject({kind: 'freeze', reason: 'restore'});

  // The run again: the keeper is stopped, so the host command opens the frozen journal itself.
  const second = ledger.open();
  expect(second.isFrozen).toBe(true);
  await second.freezeForRestore();
  second.close();
  const afterSecond = ledger.records();
  expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
  expect(afterSecond.slice(afterFirst.length)).toEqual([expect.objectContaining({kind: 'freeze', reason: 'restore'})]);

  // Still frozen: spending stays closed until the owner's recovery, as after any restore.
  const third = ledger.open();
  expect(third.isFrozen).toBe(true);
  await expect(third.operation('member-remove', async () => undefined)).rejects.toThrow();
  third.close();
});
