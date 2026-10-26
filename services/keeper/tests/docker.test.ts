import { vi,it,expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
const calls=vi.hoisted(()=>[] as string[][]);
vi.mock('node:child_process',()=>({execFile:Object.assign((_bin:string,args:string[],_opts:unknown,cb:any)=>{calls.push(args);cb(null,{stdout:args[0]==='network'?'[{"Containers":{"other":{"IPv4Address":"172.18.0.7/16"}},"IPAM":{"Config":[{"Gateway":"172.18.0.1"}]}}]':'',stderr:''});},{})}));
import { AgentNotHealthyError, NoOwnedContainerError, OutsideRouteAcknowledgementError, acknowledgeOutsideSquidStage,
  outsideRouteStageAcknowledged, ownedDocker } from '../lib/docker.js';
const image='example/image@sha256:'+'a'.repeat(64);
it('accepts only the strict bounded-Squid route acknowledgement grammar',()=>{
 const stage='11111111-1111-4111-8111-111111111111';
 const response=(...lines:string[])=>Buffer.from(lines.join('\r\n')+'\r\n\r\n','latin1');
 expect(outsideRouteStageAcknowledged(response('HTTP/1.1 403 Forbidden',`X-Lares-Route-Stage:\t${stage} `),stage)).toBe(true);
 for(const raw of [
   response('HTTP/1.1 403 Forbidden','Other: value'),
   response('HTTP/1.1 403 Forbidden',`X-Lares-Route-Stage: ${stage}`,`x-lares-route-stage: ${stage}`),
   response('HTTP/1.1 403 Forbidden',`X-Lares-Route-Stage: ${stage}`,'Other: value',' X-Lares-Route-Stage: stale'),
   response('HTTP/1.1 403 Forbidden',`X-Lares-Route-Stage: \u000b${stage}`),
   response('HTTP/1.1 4030 Forbidden',`X-Lares-Route-Stage: ${stage}`),
   response('HTTP/1.1 403 Forbidden',`X-Lares-Route-Stage : ${stage}`),
   Buffer.from(`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${stage}\r\n\r\nCI_PROXY_DESTINATION_OK`),
 ]) expect(outsideRouteStageAcknowledged(raw,stage)).toBe(false);
});
it('retains the one pinned acknowledgement request and exposes only fixed safe failure reasons',async()=>{
 const stage='11111111-1111-4111-8111-111111111111',source='192.0.2.14';
 const valid=Buffer.from(`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${stage}\r\n\r\n`);
 class FakeSocket extends EventEmitter {
  destroyed=false;
  closed=false;
  constructor(public localAddress:string,private readonly mode:'success'|'source'|'error'|'large'|'empty'|'partial'|'no-response'|'response'|'pre-refused'|'pre-error'|'write-throw',
   private readonly response=valid,private readonly errorCode='ECONNREFUSED') {super();}
  write=vi.fn((request:string)=>{
   if(this.mode==='write-throw')throw new Error('private write detail');
   if(this.mode==='success'||this.mode==='response')queueMicrotask(()=>{this.emit('data',this.response);this.emit('end');});
   if(this.mode==='error')queueMicrotask(()=>this.emit('error',Object.assign(new Error('private socket detail'),{code:this.errorCode})));
   if(this.mode==='large')queueMicrotask(()=>this.emit('data',Buffer.alloc(8193,0x41)));
   if(this.mode==='partial')queueMicrotask(()=>this.emit('data',Buffer.from('HTTP/1.1 403')));
   void request;return true;
  });
  destroy=vi.fn(()=>{this.destroyed=true;queueMicrotask(()=>{this.closed=true;this.emit('close',false);});return this as unknown as Socket;});
 }
 const open=(mode:'success'|'source'|'error'|'large'|'empty'|'partial'|'no-response'|'response'|'pre-refused'|'pre-error'|'write-throw',address=source,
  deadline=Date.now()+1000,response=valid,errorCode='ECONNREFUSED')=>{
  let socket:FakeSocket|undefined;
  const connect=vi.fn((options:{host:string;port:number;localAddress:string;family:number})=>{
   expect(options).toEqual({host:'lares-egress-proxy',port:8888,localAddress:source,family:4});
   socket=new FakeSocket(address,mode,response,errorCode);
   if(mode==='pre-refused'||mode==='pre-error')queueMicrotask(()=>socket?.emit('error',Object.assign(new Error('private socket detail'),{code:mode==='pre-refused'?'ECONNREFUSED':errorCode})));
   else if(mode!=='empty')queueMicrotask(()=>socket?.emit('connect'));
   return socket as unknown as Socket;
  });
  const promise=acknowledgeOutsideSquidStage(stage,source,'http://lares-egress-proxy:8888/',deadline,connect as never);
  return {promise,connect,get socket(){return socket;}};
 };
 const success=await open('success');
 await expect(success.promise).resolves.toBeUndefined();
 expect(success.connect).toHaveBeenCalledTimes(1);
 expect(success.socket?.write).toHaveBeenCalledTimes(1);
 expect(success.socket?.write.mock.calls[0]?.[0]).toBe(`CONNECT lares-route-${stage}.invalid:443 HTTP/1.1\r\nHost: lares-route-${stage}.invalid:443\r\nProxy-Connection: close\r\n\r\n`);
 expect(success.socket?.destroyed).toBe(true);

 const expectReason=async(promise:Promise<void>,reason:string)=>{
  let caught:unknown;
  try{await promise;}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(OutsideRouteAcknowledgementError);
  expect((caught as OutsideRouteAcknowledgementError).reason).toBe(reason);
  expect((caught as Error).message).toBe('keeper: outside route acknowledgement unavailable');
  expect(JSON.stringify(caught)).toBe('{}');
  expect((caught as Error).message).not.toContain('private');
 };
 await expectReason(open('source','192.0.2.15').promise,'source-mismatch');
 for(const [code,reason] of [['ENOTFOUND','dns-failure'],['ECONNREFUSED','connection-refused'],
  ['EADDRNOTAVAIL','local-source-unavailable'],['ENETUNREACH','network-unreachable'],
  ['ECONNRESET','connection-reset'],['ETIMEDOUT','socket-timeout'],['SECRET_CODE','connection-error']])
   await expectReason(open('error',source,Date.now()+1000,valid,code).promise,reason);
 await expectReason(open('large').promise,'response-too-large');
 await expectReason(open('empty',source,Date.now()+30).promise,'deadline-before-connect');
 await expectReason(open('partial',source,Date.now()+30).promise,'response-not-ended');
 const noResponse=await open('no-response',source,Date.now()+30);
 await expectReason(noResponse.promise,'deadline-no-response');
 const invalidResponse=(raw:string)=>Buffer.from(raw);
 for(const [raw,reason] of [
  [`HTTP/1.1 502 Bad Gateway\r\nX-Lares-Route-Stage: ${stage}\r\n\r\n`,'status-not-403'],
  [`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${stage}`,'incomplete-headers'],
  ['HTTP/1.1 403 Forbidden\r\nOther: value\r\n\r\n','stage-absent'],
  [`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${stage}\r\nx-lares-route-stage: ${stage}\r\n\r\n`,'stage-multiple'],
  [`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${'2'.repeat(36)}\r\n\r\n`,'stage-mismatch'],
  [`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage : ${stage}\r\n\r\n`,'malformed-headers'],
  [`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${stage}\r\n\r\nCI_PROXY_DESTINATION_OK`,'allow-marker'],
 ] as const) await expectReason(open('response',source,Date.now()+1000,invalidResponse(raw)).promise,reason);
 await expectReason(acknowledgeOutsideSquidStage('invalid',source,'http://lares-egress-proxy:8888/',Date.now()+1000),
   'invalid-input');
});
it('retries only a closed pre-connect ECONNREFUSED within the original deadline',async()=>{
 const stage='11111111-1111-4111-8111-111111111111',source='192.0.2.14';
 const valid=Buffer.from(`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${stage}\r\n\r\n`);
 class RetrySocket extends EventEmitter {
  destroyed=false;closed=false;
  constructor(public localAddress:string,public readonly refusal:boolean) {super();}
  write=vi.fn(()=>{queueMicrotask(()=>{this.emit('data',valid);this.emit('end');});return true;});
  destroy=vi.fn(()=>{this.destroyed=true;queueMicrotask(()=>{this.closed=true;this.emit('close',false);});return this as unknown as Socket;});
 }
 const sockets:RetrySocket[]=[],times:number[]=[],deadline=Date.now()+1500;
 const connect=vi.fn((options:{host:string;port:number;localAddress:string;family:number})=>{
  expect(options).toEqual({host:'lares-egress-proxy',port:8888,localAddress:source,family:4});
  if(sockets.length)expect(sockets.at(-1)?.closed).toBe(true);
  times.push(Date.now());
  const socket=new RetrySocket(source,sockets.length===0);sockets.push(socket);
  queueMicrotask(()=>socket.refusal?socket.emit('error',Object.assign(new Error('secret'),{code:'ECONNREFUSED'})):socket.emit('connect'));
  return socket as unknown as Socket;
 });
 await expect(acknowledgeOutsideSquidStage(stage,source,'http://lares-egress-proxy:8888/',deadline,connect as never)).resolves.toBeUndefined();
 expect(connect).toHaveBeenCalledTimes(2);expect(times[1]!-times[0]!).toBeGreaterThanOrEqual(50);
 expect(sockets[0]?.write).not.toHaveBeenCalled();expect(sockets[1]?.write).toHaveBeenCalledTimes(1);
 expect(sockets.every(socket=>socket.destroyed&&socket.closed)).toBe(true);
});
it('caps refused attempts and counts the minimum retry delay against the single deadline',async()=>{
 const stage='11111111-1111-4111-8111-111111111111',source='192.0.2.14';
 const refused=()=>{const socket=new EventEmitter() as EventEmitter&{destroyed:boolean;destroy:()=>void};socket.destroyed=false;
  socket.destroy=()=>{socket.destroyed=true;queueMicrotask(()=>socket.emit('close',false));};return socket;};
 const connectFive=vi.fn(()=>{const socket=refused();queueMicrotask(()=>socket.emit('error',Object.assign(new Error('secret'),{code:'ECONNREFUSED'})));return socket as unknown as Socket;});
 let caught:unknown;try{await acknowledgeOutsideSquidStage(stage,source,'http://lares-egress-proxy:8888/',Date.now()+1500,connectFive as never);}catch(error){caught=error;}
 expect(caught).toBeInstanceOf(OutsideRouteAcknowledgementError);
 expect((caught as OutsideRouteAcknowledgementError).reason).toBe('connection-refused');expect(connectFive).toHaveBeenCalledTimes(5);
 const connectDeadline=vi.fn(()=>{const socket=refused();queueMicrotask(()=>socket.emit('error',Object.assign(new Error('secret'),{code:'ECONNREFUSED'})));return socket as unknown as Socket;});
 const before=Date.now();
 try{await acknowledgeOutsideSquidStage(stage,source,'http://lares-egress-proxy:8888/',before+90,connectDeadline as never);}catch(error){caught=error;}
 expect((caught as OutsideRouteAcknowledgementError).reason).toBe('deadline-before-connect');
 expect(connectDeadline).toHaveBeenCalledTimes(2);expect(Date.now()-before).toBeLessThan(250);
});
it('never retries another pre-connect error or any post-connect failure',async()=>{
 const stage='11111111-1111-4111-8111-111111111111',source='192.0.2.14';
 const connect=vi.fn((mode:'before'|'after'|'response'|'write-throw')=>{
  const socket=new EventEmitter() as EventEmitter&{destroyed:boolean;destroy:()=>void;localAddress:string;write:()=>boolean};
  socket.destroyed=false;socket.localAddress=source;socket.write=()=>{if(mode==='write-throw')throw new Error('secret write error');queueMicrotask(()=>socket.emit(mode==='response'?'data':'error',mode==='response'?Buffer.from('not an acknowledgement'):Object.assign(new Error('secret'),{code:'ECONNRESET'})));if(mode==='response')queueMicrotask(()=>socket.emit('end'));return true;};
  socket.destroy=()=>{socket.destroyed=true;queueMicrotask(()=>socket.emit('close',false));};
  queueMicrotask(()=>{if(mode==='before')socket.emit('error',Object.assign(new Error('secret'),{code:'ECONNRESET'}));else socket.emit('connect');});
  return socket as unknown as Socket;
 });
 for(const mode of ['before','after','response','write-throw'] as const){
  let calls=0;const opener=vi.fn(()=>{calls++;return connect(mode);});let caught:unknown;
  try{await acknowledgeOutsideSquidStage(stage,source,'http://lares-egress-proxy:8888/',Date.now()+1000,opener as never);}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(OutsideRouteAcknowledgementError);expect(opener).toHaveBeenCalledTimes(1);expect(calls).toBe(1);
 }
});
it('does not write or accept an acknowledgement after the original deadline',async()=>{
 const stage='11111111-1111-4111-8111-111111111111',source='192.0.2.14';
 const delayedConnect=new EventEmitter() as EventEmitter&{destroyed:boolean;destroy:()=>void;localAddress:string;write:ReturnType<typeof vi.fn>};
 delayedConnect.destroyed=false;delayedConnect.localAddress=source;delayedConnect.write=vi.fn(()=>true);
 delayedConnect.destroy=()=>{delayedConnect.destroyed=true;queueMicrotask(()=>delayedConnect.emit('close',false));};
 const first=acknowledgeOutsideSquidStage(stage,source,'http://lares-egress-proxy:8888/',Date.now()+15,(()=>{
  setTimeout(()=>delayedConnect.emit('connect'),35);return delayedConnect as unknown as Socket;
 }) as never);
 let firstFailure:unknown;try{await first;}catch(error){firstFailure=error;}
 expect((firstFailure as OutsideRouteAcknowledgementError).reason).toBe('deadline-before-connect');
 await new Promise(resolve=>setTimeout(resolve,30));expect(delayedConnect.write).not.toHaveBeenCalled();

 const delayedEnd=new EventEmitter() as EventEmitter&{destroyed:boolean;destroy:()=>void;localAddress:string;write:()=>boolean};
 delayedEnd.destroyed=false;delayedEnd.localAddress=source;
 delayedEnd.write=()=>{queueMicrotask(()=>delayedEnd.emit('data',Buffer.from(`HTTP/1.1 403 Forbidden\r\nX-Lares-Route-Stage: ${stage}\r\n\r\n`)));
  setTimeout(()=>delayedEnd.emit('end'),45);return true;};
 delayedEnd.destroy=()=>{delayedEnd.destroyed=true;queueMicrotask(()=>delayedEnd.emit('close',false));};
 const second=acknowledgeOutsideSquidStage(stage,source,'http://lares-egress-proxy:8888/',Date.now()+20,
  (()=>{queueMicrotask(()=>delayedEnd.emit('connect'));return delayedEnd as unknown as Socket;}) as never);
 let secondFailure:unknown;try{await second;}catch(error){secondFailure=error;}
 expect((secondFailure as OutsideRouteAcknowledgementError).reason).toBe('response-not-ended');
 await new Promise(resolve=>setTimeout(resolve,35));
});
it('uses fixed execFile arrays, only owned compose file, digest helpers, host nft namespace and no broad cleanup',async()=>{
 let healthAttempts=0;
 const health=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>{healthAttempts++;if(healthAttempts===1)throw new Error('starting');if(healthAttempts===2)return new Response('{}',{status:503});return Response.json({ok:true,status:'ready'});});
 const pause=vi.fn(async()=>{});
 const d=ownedDocker({project:'test',dir:'/owned',composeFile:'/owned/compose.lares-agents.yaml',egressDir:'/owned/egress',proxyContainer:'lares-egress-proxy',squidImage:image,firewallImage:image},health as typeof fetch,pause);
 expect(await d.inventory('test_default')).toEqual(['172.18.0.7','172.18.0.1']);
 await d.start('bookkeeper','172.18.0.24');await d.stop('bookkeeper');await d.validateSquid('a'.repeat(36));await d.firewall('a'.repeat(36),true);await d.firewall('a'.repeat(36),false);await d.reloadSquid();await d.remove('bookkeeper');
 expect(calls.find(a=>a.includes('up'))).toEqual(['compose','--project-name','test','--project-directory','/owned','-f','/owned/compose.lares-agents.yaml','up','-d','--no-deps','lares-bookkeeper']);
 expect(health).toHaveBeenCalledTimes(3);expect(health.mock.calls[0]![0]).toBe('http://172.18.0.24:3000/eve/v1/health');expect(pause).toHaveBeenCalledTimes(2);
 const firewall=calls.filter(a=>a.includes('nft'));expect(firewall).toHaveLength(2);
 expect(firewall[0]).toContain('host');expect(firewall[0]).toContain('NET_ADMIN');expect(firewall[0]).toContain('--check');expect(firewall[1]).not.toContain('--check');
 expect(calls.flat()).not.toContain('--privileged');expect(calls.flat()).not.toContain('--remove-orphans');expect(calls.flat()).not.toContain('prune');
 await expect(d.start('../foreign','172.18.0.24')).rejects.toThrow();
 await expect(d.start('bookkeeper','127.0.0.1')).rejects.toThrow('address was refused');
});

it('leaves an unhealthy started container for explicit reconciliation and says so',async()=>{
 const health=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>new Response('{}',{status:503}));
 const d=ownedDocker({project:'test',dir:'/owned',composeFile:'/owned/compose.lares-agents.yaml',egressDir:'/owned/egress',proxyContainer:'lares-egress-proxy',squidImage:image,firewallImage:image},health as typeof fetch,async()=>{});
 await expect(d.start('bookkeeper','172.18.0.24')).rejects.toThrow('reconciliation required');
 expect(health).toHaveBeenCalledTimes(30);
 await expect(d.start('bookkeeper','172.18.0.24')).rejects.toBeInstanceOf(AgentNotHealthyError);
});
it('tells an absent container apart from other inspect failures',async()=>{
 const d=ownedDocker({project:'test',dir:'/owned',composeFile:'/owned/compose.lares-agents.yaml',egressDir:'/owned/egress',proxyContainer:'lares-egress-proxy',squidImage:image,firewallImage:image},vi.fn() as unknown as typeof fetch,async()=>{});
 await expect(d.inspect!('bookkeeper')).rejects.toBeInstanceOf(NoOwnedContainerError);
});
it('honours a smaller probe count',async()=>{
 const health=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>new Response('{}',{status:503}));
 const d=ownedDocker({project:'test',dir:'/owned',composeFile:'/owned/compose.lares-agents.yaml',egressDir:'/owned/egress',proxyContainer:'lares-egress-proxy',squidImage:image,firewallImage:image},health as typeof fetch,async()=>{});
 await expect(d.start('bookkeeper','172.18.0.24',false,15)).rejects.toBeInstanceOf(AgentNotHealthyError);
 expect(health).toHaveBeenCalledTimes(15);
});
