import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fake=vi.hoisted(()=>({files:{} as Record<string,string>,stats:{} as Record<string,any>,proxy:vi.fn(),close:vi.fn()}));
vi.mock('node:fs',async original=>{const fs=await original<typeof import('node:fs')>();return {...fs,readFileSync:(path:any,...args:any[])=>typeof path==='string'&&Object.hasOwn(fake.files,path)?fake.files[path]:(fs.readFileSync as any)(path,...args),lstatSync:(path:any)=>fake.stats[path]??fs.lstatSync(path)};});
vi.mock('undici',async original=>({...await original<typeof import('undici')>(),ProxyAgent:class {constructor(options:any){fake.proxy(options);}close=fake.close;}}));
import {mountedPersonalReadRuntime} from '../lib/personal-read-runtime.js';
const mounts={TENANT_ID:['tenant-id','11111111-2222-4333-8444-555555555555'],CLIENT_ID:['client-id','client'],CLIENT_SECRET:['client-secret','private-secret'],TOKEN_KEY:['token-key','1'.repeat(64)]};
beforeEach(()=>{
 fake.files={};fake.stats={};fake.close.mockResolvedValue(undefined);vi.stubEnv('EGRESS_PROXY_URL','http://proxy:8888');
 for(const [env,[suffix,value]] of Object.entries(mounts)){const path=`/run/secrets/personal-microsoft-${suffix}`;vi.stubEnv(`LARES_PERSONAL_MICROSOFT_${env}_FILE`,path);fake.files[path]=value;fake.stats[path]={isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:value.length};}
 vi.stubEnv('TOKEN_ENC_KEY_FILE',undefined);
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it('uses only deterministic mounted MS files and a managed proxy dispatcher, with Microsoft-only support',async()=>{
 const mounted=mountedPersonalReadRuntime.microsoft!();expect(mounted.settings).toMatchObject({clientId:'client',clientSecret:'private-secret'});expect(fake.proxy).toHaveBeenCalledWith({uri:'http://proxy:8888/',proxyTunnel:true});await mounted.close!();expect(fake.close).toHaveBeenCalledOnce();
});
it('refuses omitted/alternate mounts, empty files, links, invalid tenant/key and conflicting shared key before dispatcher creation',()=>{
 const path='/run/secrets/personal-microsoft-client-id',original=fake.stats[path];
 vi.stubEnv('LARES_PERSONAL_MICROSOFT_CLIENT_ID_FILE','/arbitrary');expect(()=>mountedPersonalReadRuntime.microsoft!()).toThrow();vi.stubEnv('LARES_PERSONAL_MICROSOFT_CLIENT_ID_FILE',path);
 for(const stat of [{...original,nlink:2},{...original,size:0},{...original,isSymbolicLink:()=>true}]){fake.stats[path]=stat;expect(()=>mountedPersonalReadRuntime.microsoft!()).toThrow();}fake.stats[path]=original;
 fake.files['/run/secrets/personal-microsoft-tenant-id']='common';expect(()=>mountedPersonalReadRuntime.microsoft!()).toThrow();fake.files['/run/secrets/personal-microsoft-tenant-id']=mounts.TENANT_ID[1];
 vi.stubEnv('TOKEN_ENC_KEY_FILE','/run/secrets/google-token-key');fake.files['/run/secrets/google-token-key']='2'.repeat(64);fake.stats['/run/secrets/google-token-key']={...original,size:64};expect(()=>mountedPersonalReadRuntime.microsoft!()).toThrow();expect(fake.proxy).not.toHaveBeenCalled();
 fake.files['/run/secrets/google-token-key']='1'.repeat(64);expect(()=>mountedPersonalReadRuntime.microsoft!()).not.toThrow();
});
