import { describe, expect, it } from 'vitest';
import { slackManifest, telegramSteps } from '../lib/doors';
describe('door setup', () => {
  it('carries only this agent request URLs', () => {
    const { manifest, createUrl } = slackManifest({name:'bookkeeper',display:'Bookkeeper'}, 'https://doors.example.com');
    expect(JSON.stringify(manifest)).toContain('https://doors.example.com/api/doors/bookkeeper/slack/events');
    expect(JSON.stringify(manifest)).not.toContain('saga');
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
});
