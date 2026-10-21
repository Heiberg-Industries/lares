import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => new Map<string,string>());
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: (path: string) => { if (!files.has(path)) throw new Error('private-file-details'); return files.get(path)!; },
}));
import { personalOrgConfig, orgConfig } from '../lib/google-orgs.js';
const config = (org: string) => ({ clientIdFile: `/run/secrets/personal-google-${org}-id`, clientSecretFile: `/run/secrets/personal-google-${org}-secret` });
beforeEach(() => {
  files.clear();
  for (const org of ['acme','second']) { files.set(config(org).clientIdFile, `${org}-client`); files.set(config(org).clientSecretFile, `${org}-secret`); }
  vi.stubEnv('TOKEN_ENC_KEY_FILE','/run/secrets/google-token-key');
  vi.stubEnv('LARES_PERSONAL_GOOGLE_CLIENTS',JSON.stringify({acme:config('acme'),second:config('second')}));
  vi.stubEnv('LARES_AGENT_INCARNATION','11111111-1111-4111-8111-111111111111');
  vi.stubEnv('LARES_EMAIL_ORG','legacy'); vi.stubEnv('GOOGLE_DEFAULT_ORG','acme');
});
afterEach(() => vi.unstubAllEnvs());
describe('personal Google client registry', () => {
  it('selects only exact credential org without an email door, principal or environment default', () => {
    expect(personalOrgConfig('second')).toEqual({orgId:'second',clientId:'second-client',clientSecret:'second-secret',redirectUri:''});
    expect(() => orgConfig('second')).toThrow('Selected Google organisation is not configured');
  });
  it.each(['ACME','Acme','ac_me','ac-me','../acme','unknown','a'.repeat(33)])('refuses noncanonical or absent org %s', org => {
    expect(() => personalOrgConfig(org)).toThrow('Selected personal Google client is not configured');
  });
  it.each(['','{}','not json','x'.repeat(16_385),JSON.stringify({acme:{...config('acme'),clientSecretFile:'/host/private'}}),
    JSON.stringify({ACME:config('acme')}),JSON.stringify({acme:{...config('acme'),token:'private-value'}}),
    JSON.stringify(Object.fromEntries(Array.from({length:33},(_,i)=>[`org${i}`,config(`org${i}`)])))])('refuses missing or malformed metadata without exposing its contents', raw => {
    vi.stubEnv('LARES_PERSONAL_GOOGLE_CLIENTS',raw);
    expect(() => personalOrgConfig('acme')).toThrow('Selected personal Google client is not configured');
  });
  it('requires the shared fixed key mount and refuses missing/empty client files', () => {
    vi.stubEnv('TOKEN_ENC_KEY_FILE','/host/private'); expect(() => personalOrgConfig('acme')).toThrow('Selected personal');
    vi.stubEnv('TOKEN_ENC_KEY_FILE','/run/secrets/google-token-key');
    files.delete(config('acme').clientIdFile); expect(() => personalOrgConfig('acme')).toThrow('Selected personal');
    files.set(config('acme').clientIdFile,'id'); files.set(config('acme').clientSecretFile,'');
    expect(() => personalOrgConfig('acme')).toThrow('Selected personal');
  });
});
