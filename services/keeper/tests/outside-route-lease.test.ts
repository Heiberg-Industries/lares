import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { DockerBoundary } from '../lib/docker.js';
import type { LifecycleConfig } from '../lib/lifecycle-config.js';
import { AgentLifecycle } from '../lib/lifecycle.js';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

it('rejects a detached route check whose acknowledgement arrives after its namespace lease is revoked',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'outside-route-lease-'));dirs.push(dir);
  const stage='stage-for-test',squid='fixture squid policy',nft='fixture firewall policy';
  writeFileSync(join(dir,'discovery-route-attempt'),`${stage}\n`);
  writeFileSync(join(dir,'installed-stage'),`${stage}\n`);
  writeFileSync(join(dir,`${stage}.squid`),squid);
  writeFileSync(join(dir,`${stage}.nft`),nft);
  writeFileSync(join(dir,'squid.conf'),squid);
  let letDetachedFinish!:()=>void,detachedStarted!:()=>void;
  const detachedGate=new Promise<void>(resolve=>{letDetachedFinish=resolve;});
  const detachedEntered=new Promise<void>(resolve=>{detachedStarted=resolve;});
  let ackCount=0;
  const acknowledgeOutsideStage=vi.fn(async()=>{
    ackCount++;
    if(ackCount===2){detachedStarted();await detachedGate;}
  });
  const client={query:vi.fn(async(query:string|{text:string})=>{
    const sql=typeof query==='string'?query:query.text;
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{acquired:true}]};
    if(sql.includes('pg_advisory_unlock'))return {rows:[{unlocked:true}]};
    throw new Error(`Unexpected namespace query: ${sql}`);
  }),release:vi.fn()} as unknown as PoolClient;
  const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
  const config={workflowTemplate:'template',workflowOwner:'lares_workflow_owner',egressDir:dir,
    runtime:{workflowServer:'postgres://lares_workflow@db/',proxyUrl:'http://proxy:8888'},
    egress:{legacyConsumers:[{name:'outside-bridge',address:'172.18.0.23',hosts:['api.example.com']}]}} as unknown as LifecycleConfig;
  const lifecycle=new AgentLifecycle(pool,pool,config,{mode:'overlay',agentsDir:dir,secretsDir:dir,
    outsideCustody:{routeConsumerName:'outside-bridge'} as never},{acknowledgeOutsideStage} as unknown as DockerBoundary);
  const internals=lifecycle as unknown as {outsideControllerEpoch:string;outsideRouteReady:{epoch:string;stage:string;sourceAddress:string;squidHash:string;nftHash:string;basePolicyHash:string}|undefined};
  internals.outsideRouteReady={epoch:internals.outsideControllerEpoch,stage,sourceAddress:'172.18.0.23',
    squidHash:createHash('sha256').update(squid).digest('hex'),nftHash:createHash('sha256').update(nft).digest('hex'),basePolicyHash:'base-policy'};
  const destination='https://api.example.com/';
  const policyHash=createHash('sha256').update(JSON.stringify(['lares-outside-destination-v1','base-policy',destination])).digest('hex');
  let escapedResult!:Promise<Error|undefined>;
  await expect(lifecycle.withAppliedOutsideRoute(destination,policyHash,Date.now()+5000,async lease=>{
    escapedResult=lease.assertCurrent().then(()=>undefined,error=>error as Error);
    await detachedEntered;
    return 'callback completed';
  })).resolves.toBe('callback completed');
  // The second acknowledgement is intentionally pending while the callback's final live check
  // completes and releases the namespace. Resolve it afterward to reproduce an escaped caller.
  letDetachedFinish();
  const result=await escapedResult;
  expect(result).toBeInstanceOf(Error);
  expect(acknowledgeOutsideStage).toHaveBeenCalledTimes(3);
  expect(client.release).toHaveBeenCalledWith(false);
});
