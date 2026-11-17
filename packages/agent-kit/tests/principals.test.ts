// The allow-list, written once in the kit and bound by each role to its doors: both roles' real
// bindings side by side, so a change to the kit or to a binding shows here as a changed row.
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHENTICATOR_FOR, CONSOLE_AUTHENTICATOR, allowedPrincipalIds, consoleMember, principalFromAuth, principalPolicy } from '../src/principals.js';
import { CONSOLE_SESSION_AUTHENTICATOR } from '../src/door-authority.js';

const chief = await import(new URL('../../../services/chief-of-staff/lib/principals.ts', import.meta.url).href);
const creative = await import(new URL('../../../services/creative/lib/principals.ts', import.meta.url).href);

const ENV = {
  SLACK_ALLOWED_USER_IDS: 'U0EXAMPLEOWNER,U0EXAMPLEOTHER',
  TELEGRAM_PRINCIPAL_ID: '100,200',
  CONSOLE_ALLOWED_EMAILS: 'owner@example.invalid,second@example.invalid',
} as NodeJS.ProcessEnv;
const MANAGED = { LARES_AGENT_INCARNATION: '11111111-1111-4111-8111-111111111111', LARES_SLACK_PRINCIPAL: 'U0EXAMPLEMANAGED',
  LARES_TELEGRAM_PRINCIPAL: '300', LARES_CONSOLE_PRINCIPAL: 'managed@example.invalid', SLACK_ALLOWED_USER_IDS: 'U0EXAMPLEOWNER' } as NodeJS.ProcessEnv;

afterEach(() => { /* the bindings read only the env passed in */ });

// [authenticator, user id, env, chief: [allowed, owner], creative: [allowed, owner]]
const ROWS: ReadonlyArray<readonly [string | undefined, string | undefined, NodeJS.ProcessEnv, readonly [boolean, boolean], readonly [boolean, boolean]]> = [
  ['slack-webhook', 'U0EXAMPLEOWNER', ENV, [true, true], [true, true]],
  ['slack-webhook', 'U0EXAMPLEOTHER', ENV, [true, false], [true, false]],
  ['slack-webhook', 'U0STRANGER', ENV, [false, false], [false, false]],
  ['telegram-webhook', '100', ENV, [true, true], [false, false]],
  ['telegram-webhook', '200', ENV, [true, false], [false, false]],
  ['lares-console', 'owner@example.invalid', ENV, [true, true], [true, true]],
  ['lares-console', 'second@example.invalid', ENV, [true, false], [true, false]],
  ['http-basic', 'owner@example.invalid', ENV, [false, false], [false, false]],
  [undefined, 'U0EXAMPLEOWNER', ENV, [false, false], [false, false]],
  ['slack-webhook', '', ENV, [false, false], [false, false]],
  ['slack-webhook', undefined, ENV, [false, false], [false, false]],
  ['slack-webhook', 'U0EXAMPLEOWNER', {} as NodeJS.ProcessEnv, [false, false], [false, false]],
  ['slack-webhook', 'U0EXAMPLEMANAGED', MANAGED, [true, true], [true, true]],
  ['slack-webhook', 'U0EXAMPLEOWNER', MANAGED, [false, false], [false, false]],
  ['telegram-webhook', '300', MANAGED, [true, true], [false, false]],
  ['lares-console', 'managed@example.invalid', MANAGED, [true, true], [true, true]],
];

describe('both roles bound to the kit allow-list', () => {
  it.each(ROWS)('%s %s', (authenticator, userId, env, chiefWants, creativeWants) => {
    expect([chief.isAllowedPrincipal(authenticator, userId, env), chief.isOwnerPrincipal(authenticator, userId, env)]).toEqual(chiefWants);
    expect([creative.isAllowedPrincipal(authenticator, userId, env), creative.isOwnerPrincipal(authenticator, userId, env)]).toEqual(creativeWants);
  });

  it('each role knows only its own doors', () => {
    expect(chief.channelForAuthenticator('telegram-webhook')).toBe('telegram');
    expect(creative.channelForAuthenticator('telegram-webhook')).toBeUndefined();
    for (const role of [chief, creative]) {
      expect(role.channelForAuthenticator('slack-webhook')).toBe('slack');
      expect(role.channelForAuthenticator(CONSOLE_AUTHENTICATOR)).toBe('console');
      expect(role.channelForAuthenticator('http-basic')).toBeUndefined();
      expect(role.channelForAuthenticator(undefined)).toBeUndefined();
    }
  });
});

describe('the kit module itself', () => {
  it('the console authenticator is the one the door authority checks', () => {
    expect(CONSOLE_AUTHENTICATOR).toBe(CONSOLE_SESSION_AUTHENTICATOR);
    expect(AUTHENTICATOR_FOR).toEqual({ slack: 'slack-webhook', telegram: 'telegram-webhook', console: 'lares-console' });
  });
  it('a policy with no doors names nobody', () => {
    const none = principalPolicy([]);
    expect(none.isAllowedPrincipal('slack-webhook', 'U0EXAMPLEOWNER', ENV)).toBe(false);
    expect(none.isOwnerPrincipal('slack-webhook', 'U0EXAMPLEOWNER', ENV)).toBe(false);
  });
  it('lists fail closed and split on commas', () => {
    expect(allowedPrincipalIds('slack', { SLACK_ALLOWED_USER_IDS: ' , ,' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(allowedPrincipalIds('slack', { SLACK_ALLOWED_USER_IDS: ' U0A , U0B ' } as NodeJS.ProcessEnv)).toEqual(['U0A', 'U0B']);
  });
  it('a member address is one plain address or nothing', () => {
    expect(consoleMember(' owner@example.invalid ')).toBe('owner@example.invalid');
    for (const bad of ['', 'no-at', 'a@b@c', '@example.invalid', 'owner@', 'a b@example.invalid', 'a,b@example.invalid', 'a\u0000b@example.invalid', null, undefined]) {
      expect(consoleMember(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
  it('shapes an auth context, stringifying a numeric id', () => {
    expect(principalFromAuth(null)).toEqual({ absent: true });
    expect(principalFromAuth('x')).toEqual({});
    expect(principalFromAuth({ authenticator: 'telegram-webhook', attributes: { user_id: 100 } })).toEqual({ authenticator: 'telegram-webhook', userId: '100' });
  });
});
