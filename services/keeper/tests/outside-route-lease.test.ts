import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { OutsideRouteAcknowledgementError, type DockerBoundary } from '../lib/docker.js';
import type { LifecycleConfig } from '../lib/lifecycle-config.js';
import { AgentLifecycle } from '../lib/lifecycle.js';
import { trackRouteBoundaryFailures } from './outside-discovery-image.probe.mjs';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

it('tracks only fixed route-boundary failures while preserving the production delegate contract',async()=>{
  const calls:string[]=[];
  const boundary={marker:'original-boundary',inventory:async()=>[],config:async()=>{},start:async()=>{},
    stop:async function(this:{marker:string}){calls.push(`stop:${this.marker}`);throw cleanupError;},
    remove:async()=>{},validateSquid:async()=>{},reloadSquid:async()=>{},acknowledgeOutsideStage:async()=>{},
    firewall:async function(this:{marker:string},stage:string,check:boolean){
      calls.push(`firewall:${this.marker}:${stage}:${check}`);
      if(check)throw firewallError;
      return 'delegated-result';
    }};
  const firewallError=new Error('private firewall detail');
  const cleanupError=new Error('private cleanup detail');
  const laterAcknowledgementError=new OutsideRouteAcknowledgementError('stage-absent');
  boundary.acknowledgeOutsideStage=async()=>{throw laterAcknowledgementError;};
  const tracked=trackRouteBoundaryFailures(boundary as unknown as DockerBoundary&typeof boundary);
  expect(await tracked.docker.firewall('route',false)).toBe('delegated-result');
  expect(calls[0]).toBe('firewall:original-boundary:route:false');
  await expect(tracked.docker.firewall('route',true)).rejects.toBe(firewallError);
  await expect(tracked.docker.stop('fixture')).rejects.toBe(cleanupError);
  await expect(tracked.docker.acknowledgeOutsideStage!('stage','192.0.2.4','http://proxy:8888/',Date.now()+1000))
    .rejects.toBe(laterAcknowledgementError);
  expect(tracked.firstFailure()).toBe('firewall-check');
  expect(tracked.firstAcknowledgementReason()).toBeUndefined();
  expect(calls).toContain('stop:original-boundary');
  expect(readFileSync(new URL('./outside-discovery-image.probe.mts',import.meta.url),'utf8'))
    .toContain('trackRouteBoundaryFailures(ownedDocker(');
});

it('captures only the fixed reason from the first real acknowledgement error and rethrows that same error',async()=>{
  const acknowledgementError=new OutsideRouteAcknowledgementError('stage-absent');
  const boundary={inventory:async()=>[],config:async()=>{},start:async()=>{},stop:async()=>{},remove:async()=>{},
    validateSquid:async()=>{},reloadSquid:async()=>{},
    acknowledgeOutsideStage:async()=>{throw acknowledgementError;},firewall:async()=>{}};
  const tracked=trackRouteBoundaryFailures(boundary as unknown as DockerBoundary&typeof boundary);
  await expect(tracked.docker.acknowledgeOutsideStage!('stage','192.0.2.4','http://proxy:8888/',Date.now()+1000))
    .rejects.toBe(acknowledgementError);
  expect(tracked.firstFailure()).toBe('route-acknowledgement');
  expect(tracked.firstAcknowledgementReason()).toBe('stage-absent');
  expect(acknowledgementError.message).toBe('keeper: outside route acknowledgement unavailable');
  expect(JSON.stringify(acknowledgementError)).toBe('{}');

  const plainError=new Error('sensitive arbitrary diagnostic');
  const plain=trackRouteBoundaryFailures({...boundary,acknowledgeOutsideStage:async()=>{throw plainError;}} as unknown as DockerBoundary);
  await expect(plain.docker.acknowledgeOutsideStage!('stage','192.0.2.4','http://proxy:8888/',Date.now()+1000))
    .rejects.toBe(plainError);
  expect(plain.firstFailure()).toBe('route-acknowledgement');
  expect(plain.firstAcknowledgementReason()).toBeUndefined();
});

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
