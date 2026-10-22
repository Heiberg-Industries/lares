import { createConnection } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER } from '@lares/agent-kit/private-console-envelope';

const DEFAULT_SOCKET = '/run/lares/vault-console.sock';
const DEFAULT_KEY_FILE = '/run/secrets/console-vault-signing-key';
const MAX_FRAME = 16_384;
type VaultCapsuleInput = Readonly<{agent:string;incarnation:string;session:string;member:string;admissionNonce:string;method:string;path:string;rawBodyHash:string;policyRevision:number;definitionHash:string}>;
function key(): Buffer {
  const value=readFileSync(process.env.CONSOLE_VAULT_SIGNING_KEY_FILE??DEFAULT_KEY_FILE,'utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Vault request authority unavailable');
  return Buffer.from(value,'hex');
}
async function challenge(input:VaultCapsuleInput):Promise<{challenge:string;expiry:number}> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(process.env.LARES_VAULT_CONSOLE_SOCKET??DEFAULT_SOCKET);let data=Buffer.alloc(0),settled=false;
    const finish=(error?:Error,result?:{challenge:string;expiry:number})=>{if(settled)return;settled=true;clearTimeout(deadline);socket.destroy();if(error)reject(new Error('Vault request authority unavailable'));else resolve(result!);};
    const deadline=setTimeout(()=>finish(new Error('deadline')),1500);
    socket.once('error',error=>finish(error));
    socket.once('end',()=>{if(!settled)finish(new Error('eof'));});
    socket.once('close',()=>{if(!settled)finish(new Error('close'));});
    socket.once('connect',()=>socket.write(JSON.stringify({op:'challenge',input})+'\n'));
    socket.on('data',chunk=>{
      data=Buffer.concat([data,chunk]);if(data.length>MAX_FRAME){finish(new Error('size'));return;}
      const end=data.indexOf(10);if(end<0)return;if(end!==data.length-1){finish(new Error('trailing'));return;}
      try{const response=JSON.parse(data.subarray(0,end).toString('utf8'));if(response.ok!==true||typeof response.challenge!=='string'||!Number.isSafeInteger(response.expiry))throw new Error();finish(undefined,{challenge:response.challenge,expiry:response.expiry});}
      catch{finish(new Error('response'));}
    });
  });
}
export async function signPrivateVaultRequest(input:VaultCapsuleInput):Promise<string>{
  const issued=await challenge(input);
  const capsule={version:1,purpose:'human',...input,challenge:issued.challenge,nonce:randomBytes(32).toString('base64url'),expiry:issued.expiry};
  const canonical=Buffer.from(JSON.stringify(capsule)).toString('base64url');
  const signature=createHmac('sha256',key()).update(canonical).digest('base64url');
  const result=`${canonical}.${signature}`;
  if(result.length>8192)throw new Error('Vault request authority unavailable');
  return result;
}
export { PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER };
