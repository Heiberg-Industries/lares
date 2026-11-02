import {afterAll,beforeAll,expect,it} from 'vitest';
import {chmodSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {keeperPool} from '../lib/config.js';
let container:StartedPostgreSqlContainer,root:string,admin:ReturnType<typeof keeperPool>,pool:ReturnType<typeof keeperPool>;
beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  root=mkdtempSync(join(realpathSync(tmpdir()),'lares-pool-'));chmodSync(root,0o700);
  const passwordFile=join(root,'password');writeFileSync(passwordFile,container.getPassword(),{mode:0o600});
  const db={host:container.getHost(),port:container.getPort(),database:container.getDatabase(),user:container.getUsername(),passwordFile} as Parameters<typeof keeperPool>[0];
  admin=keeperPool(db);pool=keeperPool(db,{max:2});
},120_000);
afterAll(async()=>{await pool?.end();await admin?.end();await container?.stop();rmSync(root,{recursive:true,force:true});});
const drop=async(pid:number)=>{await admin.query('SELECT pg_terminate_backend($1)',[pid]);await new Promise(resolve=>setTimeout(resolve,300));};
// Without its listeners, either case below is an uncaught error that ends the process. Vitest
// fails the whole run on one; a real keeper dies with its ledger left unclean.
it('survives losing an idle connection and keeps working',async()=>{
  const {rows}=await pool.query('SELECT pg_backend_pid() AS pid');await drop(rows[0].pid);
  expect((await pool.query('SELECT 1 AS one')).rows[0].one).toBe(1);
},30_000);
it('survives losing a connection a caller holds, and the caller learns from its own query',async()=>{
  const client=await pool.connect(),{rows}=await client.query('SELECT pg_backend_pid() AS pid');await drop(rows[0].pid);
  await expect(client.query('SELECT 1')).rejects.toThrow();client.release(true);
  expect((await pool.query('SELECT 1 AS one')).rows[0].one).toBe(1);
},30_000);
