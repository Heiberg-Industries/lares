import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultBrokerRequest } from '../src/vault-broker-client.js';

const root=mkdtempSync(join(tmpdir(),'lares-vault-client-'));
const socketPath=join(root,'broker.sock'),secretPath=join(root,'runtime-key');
const sockets=new Set<Socket>();
let server:Server;

beforeAll(async()=>{
 writeFileSync(secretPath,'3'.repeat(64));
 process.env.LARES_AGENT_NAME='proof-agent';process.env.LARES_AGENT_INCARNATION='11111111-1111-4111-8111-111111111111';
 process.env.LARES_RUNTIME_CONTROL_SECRET_FILE=secretPath;process.env.LARES_VAULT_RUNTIME_SOCKET=socketPath;
 server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let received='';socket.on('data',chunk=>{received+=chunk.toString('utf8');if(!received.includes('\n'))return;
  const mode=JSON.parse(received.slice(0,received.indexOf('\n'))).input?.mode;
  if(mode==='eof'){socket.end();return;}if(mode==='partial'){socket.end('{"ok":');return;}if(mode==='stall')return;
  let index=0;const bytes=Buffer.from('{"ok":true');const timer=setInterval(()=>{if(socket.destroyed){clearInterval(timer);return;}socket.write(bytes.subarray(index,index+1));index++;if(index>=bytes.length)index=0;},150);socket.once('close',()=>clearInterval(timer));
 });});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
});
afterAll(async()=>{for(const socket of sockets)socket.destroy();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 for(const key of ['LARES_AGENT_NAME','LARES_AGENT_INCARNATION','LARES_RUNTIME_CONTROL_SECRET_FILE','LARES_VAULT_RUNTIME_SOCKET'])delete process.env[key];rmSync(root,{recursive:true,force:true});});

describe('Vault broker client response bounds',()=>{
 it.each(['eof','partial','trickle','stall'])('refuses %s without hanging',async mode=>{
  const start=Date.now();await expect(vaultBrokerRequest('test',{mode})).rejects.toThrow('Vault reader unavailable');
  expect(Date.now()-start).toBeLessThan(2600);
 },8000);
});
