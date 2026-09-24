import { vi,it,expect } from 'vitest';
const calls=vi.hoisted(()=>[] as string[][]);
vi.mock('node:child_process',()=>({execFile:Object.assign((_bin:string,args:string[],_opts:unknown,cb:any)=>{calls.push(args);cb(null,{stdout:args[0]==='network'?'[{"Containers":{"other":{"IPv4Address":"172.18.0.7/16"}},"IPAM":{"Config":[{"Gateway":"172.18.0.1"}]}}]':'',stderr:''});},{})}));
import { ownedDocker } from '../lib/docker.js';
const image='example/image@sha256:'+'a'.repeat(64);
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
});
