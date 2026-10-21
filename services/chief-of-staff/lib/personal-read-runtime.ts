/** Trusted fixed mounts only. Model arguments cannot supply clients, URLs or dispatchers. */
import { lstatSync, readFileSync } from 'node:fs';
import { ProxyAgent } from 'undici';
import { PersonalReadError } from './personal-read-contract.js';
import type { PersonalReadRuntime } from './personal-reads.js';
import { microsoftReadSettingsSchema } from './microsoft-personal-reads.js';
export function requirePersonalReadProxy(): string {
  try {
    const u=new URL(process.env.EGRESS_PROXY_URL ?? '');
    if(u.protocol!=='http:' || !u.hostname || u.username || u.password || u.pathname!=='/' || u.search || u.hash)throw new Error();
    return u.href;
  }catch{throw new PersonalReadError();}
}
function mounted(source:string|undefined,name:string,max:number):string {
  const path=`/run/secrets/${name}`;
  if(source!==path)throw new PersonalReadError();
  const st=lstatSync(path);
  if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || st.size===0 || st.size>max)throw new PersonalReadError();
  const value=readFileSync(path,'utf8').trim();
  if(!value || value.length>max)throw new PersonalReadError();
  return value;
}
/** A fresh dispatcher is owned by one bounded read, and closes after the custody callback. */
export const mountedPersonalReadRuntime:PersonalReadRuntime = {
  microsoft() {
    const proxy=requirePersonalReadProxy();
    const settings=microsoftReadSettingsSchema.parse({
      tenantId:mounted(process.env.LARES_PERSONAL_MICROSOFT_TENANT_ID_FILE,'personal-microsoft-tenant-id',128),
      clientId:mounted(process.env.LARES_PERSONAL_MICROSOFT_CLIENT_ID_FILE,'personal-microsoft-client-id',256),
      clientSecret:mounted(process.env.LARES_PERSONAL_MICROSOFT_CLIENT_SECRET_FILE,'personal-microsoft-client-secret',8192),
      tokenKeyHex:mounted(process.env.LARES_PERSONAL_MICROSOFT_TOKEN_KEY_FILE,'personal-microsoft-token-key',128),
    });
    if(process.env.TOKEN_ENC_KEY_FILE!==undefined &&
      mounted(process.env.TOKEN_ENC_KEY_FILE,'google-token-key',128)!==settings.tokenKeyHex)throw new PersonalReadError();
    const dispatcher=new ProxyAgent({uri:proxy,proxyTunnel:true});
    return {settings,dispatcher,close:()=>dispatcher.close()};
  },
};
