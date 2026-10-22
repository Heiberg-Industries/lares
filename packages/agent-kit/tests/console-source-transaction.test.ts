import { expect, it } from 'vitest';
import { consoleSourceTransaction, gateConsoleOrganisation, invalidateConsoleSource, sourceTransactionBoundary,
  querySourceBounded, sourceObservationCommit, consumeSourceObservationCommit, retainSourceTransactionDeadline, type SourceDatabase, type SourceTransactionOutcome } from '../src/console-source-transaction.js';

type QueryConfig={text:string;values?:unknown[];query_timeout?:number};
class Client {
  calls:QueryConfig[]=[];released:boolean[]=[];slow=false;delayCommitMs=0;deadlineLive=true;
  async query(value:string|QueryConfig,values?:unknown[]):Promise<{rows:any[];command?:string}>{
    const config=typeof value==='string'?{text:value,values}:value;this.calls.push(config);
    const command=/^\s*([A-Za-z]+)/.exec(config.text)?.[1]?.toUpperCase();
    if(command==='COMMIT'&&this.delayCommitMs)await wait(this.delayCommitMs);
    if(this.slow&&config.text==='SELECT slow')throw new Error('Query read timeout');
    if(config.text.includes('SELECT org_id AS organisation_id'))return {rows:[{organisation_id:'org'}]};
    if(config.text.includes('SELECT id FROM orgs'))return {rows:[{id:'org'}]};
    if(config.text.includes('FROM users WHERE id=$1'))return {rows:[{id:'member',org_id:'org',org_role:'owner',status:'active',automation_mode:'draft-and-ask'}]};
    if(config.text.includes('clock_timestamp()'))return {rows:this.deadlineLive?[{one:1}]:[]};
    if(config.text.startsWith('SELECT min(deadline)'))return {rows:[{deadline:'2026-10-22 13:14:15.123456+00'}]};
    return {rows:[],...(command==='BEGIN'||command==='COMMIT'||command==='ROLLBACK'?{command}:{})};
  }
  release(error?:boolean){this.released.push(error===true);}
}
class Pool {
  clients:Client[]=[];next?:Promise<Client>;
  async query(sql:string,values?:unknown[]){return {rows:[]};}
  async connect(){const client=this.next?await this.next:new Client();this.clients.push(client);return client;}
}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

it('keeps the checked-out client identity, restores its query method, and uses one checkout',async()=>{
  const pool=new Pool(),client=new Client(),original=client.query;pool.next=Promise.resolve(client);
  let workClient:SourceDatabase|undefined,boundaryClient:SourceDatabase|undefined;
  const boundary=sourceTransactionBoundary({beforeCommit:async db=>{boundaryClient=db;},settled:async()=>{}});
  const value=await consoleSourceTransaction(pool,async db=>{workClient=db;return 'buffered';},boundary,{deadlineAtMs:Date.now()+5000});
  expect(value).toBe('buffered');expect(workClient).toBe(client);expect(boundaryClient).toBe(client);
  expect(pool.clients).toHaveLength(1);expect(client.query).toBe(original);expect(client.released).toEqual([false]);
  expect(client.calls.filter(c=>c.text==='COMMIT')).toHaveLength(1);
});

it('releases a checkout that arrives after the absolute deadline exactly once',async()=>{
  const pool=new Pool(),client=new Client();let resolve!:(client:Client)=>void;pool.next=new Promise< Client >(r=>{resolve=r;});
  await expect(consoleSourceTransaction(pool,async()=>undefined,undefined,{deadlineAtMs:Date.now()+10})).rejects.toThrow();
  resolve(client);await wait(10);expect(client.released).toEqual([true]);
});

it('bounds owned queries and destroys a client after a driver query timeout',async()=>{
  const pool=new Pool(),client=new Client(),original=client.query;client.slow=true;pool.next=Promise.resolve(client);
  await expect(consoleSourceTransaction(pool,db=>db.query('SELECT slow'),undefined,{deadlineAtMs:Date.now()+5000})).rejects.toThrow('Query read timeout');
  const slow=client.calls.find(c=>c.text==='SELECT slow');expect(slow?.query_timeout).toBeGreaterThan(0);expect(slow?.query_timeout).toBeLessThanOrEqual(1000);
  expect(client.released).toEqual([true]);expect(client.query).toBe(original);
});

it('commits revoke-only source retirement after the request deadline without reporting financial success',async()=>{
  const pool=new Pool(),client=new Client(),binding={agent:'helper',incarnation:'11111111-1111-4111-8111-111111111111',sessionId:'session',memberId:'member',admissionNonce:'a'.repeat(43)};pool.next=Promise.resolve(client);
  let settled:SourceTransactionOutcome|undefined;let ranBeforeCommit=false;
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{ranBeforeCommit=true;},settled:async outcome=>{settled=outcome;}});
  await expect(consoleSourceTransaction(pool,async db=>{await gateConsoleOrganisation(db,'member',binding);await wait(120);invalidateConsoleSource(db,binding);},boundary,{deadlineAtMs:Date.now()+100}))
    .rejects.toThrow('Conversation authority is not available');
  expect(ranBeforeCommit).toBe(false);expect(settled).toBe('source-retirement-acknowledged');
  expect(client.calls.map(c=>c.text.trim().toUpperCase()).filter(s=>['ROLLBACK','COMMIT'].includes(s))).toEqual(['ROLLBACK','COMMIT']);
  expect(client.released).toEqual([false]);
});

it('withholds bytes after a post-ACK authority failure but settles the acknowledged outcome',async()=>{
  const pool=new Pool(),client=new Client();pool.next=Promise.resolve(client);let settled:SourceTransactionOutcome|undefined;
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{},settled:async outcome=>{settled=outcome;}});
  await expect(consoleSourceTransaction(pool,async()=>({content:'private bytes'}),boundary,{deadlineAtMs:Date.now()+5000,afterCommit:()=>{throw new Error('turn expired');}}))
    .rejects.toThrow('turn expired');
  expect(client.calls.filter(c=>c.text==='COMMIT')).toHaveLength(1);expect(settled).toBe('commit-acknowledged');expect(client.released).toEqual([false]);
});

it('keeps the same owned client through a bounded post-COMMIT observation and settles its result',async()=>{
  const pool=new Pool(),client=new Client();pool.next=Promise.resolve(client);let settled:SourceTransactionOutcome|undefined,observed:unknown,observerClient:SourceDatabase|undefined;
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{},afterCommitObservation:async(db,operationId)=>{
    observerClient=db;await querySourceBounded(db,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',undefined,250);
    await querySourceBounded(db,'SELECT observer',undefined,250);await querySourceBounded(db,'COMMIT',undefined,250);
    return {operationId,commit:sourceObservationCommit(db)};
  },settled:async(outcome,value)=>{settled=outcome;observed=value;}});
  await expect(consoleSourceTransaction(pool,async()=>"committed",boundary)).resolves.toBe('committed');
  expect(observerClient).toBe(client);expect(settled).toBe('commit-acknowledged');expect(observed).toBeDefined();
  expect(client.calls.find(call=>call.text==='SELECT observer')?.query_timeout).toBe(250);
  expect(client.calls.findIndex(call=>call.text==='COMMIT')).toBeLessThan(client.calls.findIndex(call=>call.text==='SELECT observer'));
  const proof=observed as {operationId:string;commit:Parameters<typeof consumeSourceObservationCommit>[0]};
  expect(()=>consumeSourceObservationCommit(proof.commit,proof.operationId)).not.toThrow();
  expect(()=>consumeSourceObservationCommit(proof.commit,proof.operationId)).toThrow();
  expect(client.released).toEqual([false]);
});

it('keeps the acknowledged outcome when observation fails and discards its client',async()=>{
  const pool=new Pool(),client=new Client();pool.next=Promise.resolve(client);let settled:SourceTransactionOutcome|undefined;
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{},afterCommitObservation:async()=>{throw new Error('observer commit unknown');},settled:async outcome=>{settled=outcome;}});
  await expect(consoleSourceTransaction(pool,async()=>"committed",boundary)).rejects.toThrow('observer commit unknown');
  expect(settled).toBe('commit-acknowledged');expect(client.calls.filter(call=>call.text==='ROLLBACK')).toHaveLength(0);expect(client.released).toEqual([true]);
});

it('withholds a result when the request deadline expires before a delayed COMMIT ACK without rewriting the ACK outcome',async()=>{
  const pool=new Pool(),client=new Client();pool.next=Promise.resolve(client);client.delayCommitMs=30;let settled:SourceTransactionOutcome|undefined;
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{},settled:async outcome=>{settled=outcome;}});
  await expect(consoleSourceTransaction(pool,async()=>({content:'private bytes'}),boundary,{deadlineAtMs:Date.now()+10})).rejects.toThrow();
  expect(client.calls.filter(c=>c.text==='COMMIT')).toHaveLength(1);expect(settled).toBe('commit-acknowledged');expect(client.released).toEqual([false]);
});

it('checks an exact generic PostgreSQL deadline after proposal and rolls back without sticky source retirement',async()=>{
  const pool=new Pool(),client=new Client();pool.next=Promise.resolve(client);let settled:SourceTransactionOutcome|undefined;
  const exact='2026-10-22T13:14:15.123456Z';
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{client.deadlineLive=false;},settled:async outcome=>{settled=outcome;}});
  await expect(consoleSourceTransaction(pool,async db=>{
    await gateConsoleOrganisation(db,'member',undefined,{lock:'update'});
    retainSourceTransactionDeadline(db,exact);
    await db.query('FINANCIAL MUTATION');
    return 'must not escape';
  },boundary,{deadlineAtMs:Date.now()+5000})).rejects.toThrow('Conversation authority is not available');
  expect(client.calls.some(call=>call.text.includes('clock_timestamp()')&&call.values?.[0]===exact)).toBe(true);
  expect(client.calls.some(call=>call.text==='SELECT id FROM orgs WHERE id=$1 FOR UPDATE')).toBe(true);
  expect(client.calls.some(call=>call.text.includes('FROM users WHERE id=$1')&&call.text.endsWith('FOR UPDATE'))).toBe(true);
  expect(client.calls.filter(call=>call.text==='ROLLBACK')).toHaveLength(1);
  expect(client.calls.filter(call=>call.text==='COMMIT')).toHaveLength(0);
  expect(settled).toBe('rollback-acknowledged');
  expect(client.released).toEqual([false]);
});
