import { beforeAll,afterAll,it,expect } from 'vitest';
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { mkdtempSync,readdirSync,copyFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLedger } from '../lib/migration-ledger.js';
import { runMigrations } from '../lib/migration-runner.js';
import { quiet } from './helpers/quiet-pool.js';
let container:StartedPostgreSqlContainer,pool:Pool;
beforeAll(async()=>{container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri()}));},120_000);
afterAll(async()=>{await pool?.end();await container?.stop();});
it('upgrades the released006 ledger through021 and a second actual migration run is empty',async()=>{
  const sql=join(__dirname,'../sql'),released=mkdtempSync(join(tmpdir(),'personal-send-released-'));
  try{
    for(const file of readdirSync(sql).filter(file=>/^00[1-6]_.*\.sql$/.test(file)))copyFileSync(join(sql,file),join(released,file));
    await ensureLedger(pool);
    const original=await runMigrations(pool,released);expect(original.refused).toEqual([]);expect(original.applied.at(-1)).toBe('006_approval_session.sql');
    const upgrade=await runMigrations(pool,sql);expect(upgrade.refused).toEqual([]);expect(upgrade.applied.at(-1)).toBe('021_personal_action_acceptance.sql');
    expect((await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='personal_actions'::regclass AND conname='personal_actions_receipt_check_v2'")).rows).toHaveLength(1);
    expect(await runMigrations(pool,sql)).toMatchObject({applied:[],refused:[]});
  }finally{rmSync(released,{recursive:true,force:true});}
});
