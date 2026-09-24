import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {registerDoorActions} from '../lib/doors.js';
import {runAction,resetActions} from '../lib/actions.js';
let dir:string;const query=vi.fn(),fetcher=vi.fn();
const row={runtime_control_token:'11111111-1111-4111-8111-111111111111',ownership:'owned',state:'ready',status:'valid',pending:false,ownership_token:'11111111-1111-4111-8111-111111111111',definition:{role:'travel'},applied_definition:{doors:[{kind:'telegram',enabled:true}]}};
beforeEach(()=>{vi.clearAllMocks();resetActions();dir=mkdtempSync(join(tmpdir(),'lares-webhook-test-'));writeFileSync(join(dir,'example-telegram-token'),'123:secret');writeFileSync(join(dir,'example-telegram-webhook-secret'),'a'.repeat(64));query.mockResolvedValue({rows:[row]});registerDoorActions({pool:{query,connect:async()=>({query,release:()=>{}})} as never,secretsDir:dir,publicOrigin:'https://doors.example.com',fetch:fetcher});});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const call=()=>runAction('telegram.webhook_set',{name:'example'},{actor:'owner',audit:async()=>{}});
it('reads bot state first and registers the fixed URL with both credentials kept out of results',async()=>{
 fetcher.mockResolvedValueOnce(Response.json({ok:true,result:{url:''}})).mockResolvedValueOnce(Response.json({ok:true,result:true}));
 const result=await call();expect(query.mock.calls.some(([sql])=>sql.includes('pg_advisory_xact_lock'))).toBe(true);expect(fetcher.mock.calls[0][0]).toMatch(/getWebhookInfo$/);expect(fetcher.mock.calls[1][0]).toMatch(/setWebhook$/);
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({url:'https://doors.example.com/api/doors/example/telegram/events',secret_token:'a'.repeat(64),allowed_updates:['message','callback_query'],drop_pending_updates:false});
 expect(JSON.stringify(result)).not.toContain('secret');expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
});
it('refuses another existing webhook without calling setWebhook',async()=>{fetcher.mockResolvedValue(Response.json({ok:true,result:{url:'https://existing.example.com/live'}}));await expect(call()).rejects.toThrow('another webhook');expect(fetcher).toHaveBeenCalledTimes(1);});
it('does not claim success on API refusal, malformed response, or pending mounts',async()=>{
 fetcher.mockResolvedValue(Response.json({ok:false}));await expect(call()).rejects.toThrow();expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
 query.mockResolvedValue({rows:[{...row,pending:true}]});fetcher.mockClear();await expect(call()).rejects.toThrow('Apply');expect(fetcher).not.toHaveBeenCalled();
});
