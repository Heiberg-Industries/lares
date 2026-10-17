import { describe, expect, it } from 'vitest';
import { slackManifest, telegramSteps, telegramConnectLink, doorStateText, doorTouched, slackClaimMessage } from '../lib/doors';
describe('door setup', () => {
  it('carries only this agent request URLs', () => {
    const { manifest, createUrl } = slackManifest({name:'bookkeeper',display:'Bookkeeper'}, 'https://doors.example.com');
    expect(JSON.stringify(manifest)).toContain('https://doors.example.com/api/doors/bookkeeper/slack/events');
    expect(JSON.stringify(manifest)).not.toContain('chief-of-staff');
    expect(createUrl).toMatch(/^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
    expect(JSON.parse(new URL(createUrl).searchParams.get('manifest_json')!)).toEqual(manifest);
  });
  it('requests only scopes needed for direct messages', () => {
    const {manifest}=slackManifest({name:'b',display:'B'},'https://c.example.com');
    expect(manifest.oauth_config.scopes.bot).toEqual(['chat:write','im:history']);
  });
  it('gives ordered BotFather instructions naming the agent', () => {
    const steps=telegramSteps('Bookkeeper');
    expect(steps[0].text).toMatch(/BotFather/);
    expect(steps.map(s=>s.step)).toEqual([1,2,3,4]);
    expect(JSON.stringify(steps)).toContain('Bookkeeper');
  });
  it.each(['http://doors.example.com','https://user:password@doors.example.com','https://doors.example.com/base','https://doors.example.com?x=1'])('refuses an invalid public origin %s',origin=>{
    expect(()=>slackManifest({name:'bookkeeper',display:'Bookkeeper'},origin)).toThrow();
  });
  it('rejects path injection',()=>expect(()=>slackManifest({name:'../other',display:'B'},'https://doors.example.com')).toThrow());
  it('builds the Telegram tap link only from a plain bot username and a 24 character code',()=>{
    const code='A1'.repeat(12);
    expect(telegramConnectLink('example_bot',code)).toBe(`https://t.me/example_bot?start=${code}`);
    expect(()=>telegramConnectLink('example bot',code)).toThrow();
    expect(()=>telegramConnectLink('example_bot','short')).toThrow();
    expect(()=>telegramConnectLink('example_bot/../x',code)).toThrow();
    expect(slackClaimMessage(code)).toBe(`claim ${code}`);
  });
  it('shows Pending only for a door the owner has touched',()=>{
    const base={kind:'telegram',enabled:false,claimed:false,pending:true,pending_reason:'Apply',applied:false};
    expect(doorTouched(base)).toBe(false);expect(doorStateText(base)).toBe('Not set up');expect(doorStateText(undefined)).toBe('Not set up');
    expect(doorStateText({...base,configured:true})).toBe('Pending: Apply');
    expect(doorStateText({...base,enabled:true,pending:false,applied:true,claimed:true})).toBe('Connected');
  });
});
