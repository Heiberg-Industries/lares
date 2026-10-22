import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signPrivateVaultRequest } from '../lib/vault-capsule';

const root=mkdtempSync(join(tmpdir(),'lares-vault-capsule-'));
const socketPath=join(root,'keeper.sock'),keyPath=join(root,'console-key'),sockets=new Set<Socket>();
let server:Server;

beforeAll(async()=>{
 writeFileSync(keyPath,'2'.repeat(64));process.env.CONSOLE_VAULT_SIGNING_KEY_FILE=keyPath;process.env.LARES_VAULT_CONSOLE_SOCKET=socketPath;
 server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let received='';socket.on('data',chunk=>{received+=chunk.toString('utf8');if(!received.includes('\n'))return;const mode=JSON.parse(received.slice(0,received.indexOf('\n'))).input?.rawBodyHash;
  if(mode==='clean-eof'){socket.end();return;}if(mode==='partial-eof'){socket.end('{"ok":');return;}if(mode==='stall')return;
  let index=0;const bytes=Buffer.from('{"ok":true');const timer=setInterval(()=>{if(socket.destroyed){clearInterval(timer);return;}socket.write(bytes.subarray(index,index+1));index=index===bytes.length-1?0:index+1;},150);
  const onWriteError=(error:NodeJS.ErrnoException)=>{clearInterval(timer);if(mode==='trickle'&&['EPIPE','ECONNRESET'].includes(error.code??''))return;throw error;};
  socket.on('error',onWriteError);socket.once('close',()=>{clearInterval(timer);socket.off('error',onWriteError);});
 });});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
});
afterAll(async()=>{for(const socket of sockets)socket.destroy();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));delete process.env.CONSOLE_VAULT_SIGNING_KEY_FILE;delete process.env.LARES_VAULT_CONSOLE_SOCKET;rmSync(root,{recursive:true,force:true});});

const request={agent:'proof-agent',incarnation:'11111111-1111-4111-8111-111111111111',session:'session_proof',member:'member-proof',admissionNonce:'a'.repeat(43),method:'POST',path:'/eve/v1/session/session_proof',rawBodyHash:'b'.repeat(64),policyRevision:2,definitionHash:'c'.repeat(64)};
describe('console Vault challenge response bounds',()=>{
 it.each([['clean EOF','clean-eof'],['partial EOF','partial-eof'],['trickle','trickle'],['stalled handler','stall']])('refuses %s without hanging',async(_label,rawBodyHash)=>{
  const start=Date.now();await expect(signPrivateVaultRequest({...request,rawBodyHash})).rejects.toThrow('Vault request authority unavailable');
  expect(Date.now()-start).toBeLessThan(2200);
 },6000);
});
