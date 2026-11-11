/**
 * Which kind of failure stopped the agent opening its mailbox, and what the log line may say about it.
 *
 * No database. Wherever the real library can be made to fail here, the error under test is the one it
 * actually throws: the Google auth client against a stubbed HTTP layer (the same seam the mailbox uses),
 * a connection to a port nothing listens on, an elapsed deadline. Only the Postgres server error is
 * built by hand, from the driver's own class, because producing one needs a running server.
 */
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Common } from 'googleapis';
import { DatabaseError, Pool } from 'pg';
import { z } from 'zod';
import { AccountAccessError } from '@lares/agent-kit/account-store';
import { AccountCredentialError } from '@lares/agent-kit/account-credentials';
import { SourceAuthorityUnavailable } from '@lares/agent-kit/console-source-transaction';
import { buildOAuth2Client, GoogleConfigError, readTokenEncKey } from '@lares/agent-kit/google-auth';
import {
  AgentMailboxRefusedError, agentMailbox, classifyMailboxOpenFailure, describeMailboxOpenFailure,
  resetAgentMailboxLogForTests,
} from '../lib/agent-mailbox.js';
import { personalOrgConfig } from '../lib/google-orgs.js';
import { bindPersonalGoogleDeadline } from '../lib/google.js';

// Everything a log line must never carry. All invented; none is a real credential or address.
const ACCESS_TOKEN = 'fixture-access-token-0123456789';
const REFRESH_TOKEN = 'fixture-refresh-token-0123456789';
const CLIENT_SECRET = 'fixture-client-secret-0123456789';
const CLIENT_ID = 'fixture-client-id-0123456789';
const ADDRESS = 'owner@example.invalid';
const MAILBOX_ID = 'mailbox-binding-7f3a9c2e';
const FORBIDDEN = [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, CLIENT_ID, ADDRESS, MAILBOX_ID, 'example.invalid', 'fixture'];
const LEAKY = `refresh ${REFRESH_TOKEN} access ${ACCESS_TOKEN} secret ${CLIENT_SECRET} client ${CLIENT_ID} for ${ADDRESS} (${MAILBOX_ID})`;

/** Exactly what a line may be made of: our own words, a class name, a three-digit status, a code. */
const LINE = /^category=(client-configuration|token|provider|database|unknown) class=[A-Za-z_$][A-Za-z0-9_$]*( status=[1-5][0-9]{2})?( code=[A-Za-z0-9_]+)?$/;

async function thrownBy(work: () => unknown): Promise<unknown> {
  try { await work(); } catch (err) { return err; }
  throw new Error('expected a failure');
}
/** The Google auth client the mailbox uses, with the HTTP layer stubbed and retries off, as in production. */
function googleClient(http: typeof fetch, deadline = AbortSignal.timeout(10_000)) {
  const auth = buildOAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: '' }, REFRESH_TOKEN);
  auth.transporter.defaults = { ...auth.transporter.defaults, fetchImplementation: http };
  bindPersonalGoogleDeadline(auth, deadline);
  return auth;
}
const answers = (status: number, body: unknown) => (async () => Response.json(body, { status })) as typeof fetch;
/** The token endpoint refusing the refresh. */
const refreshFailure = (status: number, body: unknown) => thrownBy(() => googleClient(answers(status, body)).refreshAccessToken());
/** A Google API call (the profile read) answered with an error. */
const apiFailure = (status: number, body: unknown) => thrownBy(() =>
  googleClient(answers(status, body)).transporter.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' }));
const apiError = (code: number, status: string) => ({ error: { code, status, message: LEAKY, errors: [{ message: LEAKY, reason: 'fixture' }] } });

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise(done => server.close(done));
  return port;
}
function postgresError(sqlstate: string): DatabaseError {
  return Object.assign(new DatabaseError(`relation "${MAILBOX_ID}" does not exist for ${ADDRESS}`, 120, 'error'), { code: sqlstate, severity: 'ERROR' });
}

afterEach(() => { vi.unstubAllEnvs(); resetAgentMailboxLogForTests(); });

describe('classifyMailboxOpenFailure', () => {
  describe('client configuration', () => {
    it('the Google client settings are missing on this host', async () => {
      vi.stubEnv('LARES_PERSONAL_GOOGLE_CLIENTS', '');
      const err = await thrownBy(() => personalOrgConfig('acme'));
      expect(err).toBeInstanceOf(GoogleConfigError);
      expect(describeMailboxOpenFailure(err)).toBe('category=client-configuration class=GoogleConfigError');
    });
    it('the Google client settings are malformed', async () => {
      vi.stubEnv('LARES_PERSONAL_GOOGLE_CLIENTS', '{"acme":{"clientIdFile":"/somewhere/else"}}');
      vi.stubEnv('TOKEN_ENC_KEY_FILE', '/run/secrets/google-token-key');
      expect(classifyMailboxOpenFailure(await thrownBy(() => personalOrgConfig('acme')))).toBe('client-configuration');
    });
    it('the token key file is not readable', async () => {
      vi.stubEnv('TOKEN_ENC_KEY_FILE', '/nonexistent/mailbox-open-failure-test-key');
      expect(classifyMailboxOpenFailure(await thrownBy(() => readTokenEncKey()))).toBe('client-configuration');
    });
    it.each(['invalid_client', 'unauthorized_client'])('Google does not accept the client itself (%s)', async code => {
      const err = await refreshFailure(401, { error: code, error_description: LEAKY });
      expect(err).toBeInstanceOf(Common.GaxiosError);
      expect(describeMailboxOpenFailure(err)).toBe(`category=client-configuration class=GaxiosError status=401 code=${code}`);
    });
  });

  describe('token', () => {
    it('Google says the stored credential is expired or revoked', async () => {
      const err = await refreshFailure(400, { error: 'invalid_grant', error_description: LEAKY });
      expect(describeMailboxOpenFailure(err)).toBe('category=token class=GaxiosError status=400 code=invalid_grant');
    });
    it('a Google API call is refused for lack of valid credentials', async () => {
      expect(describeMailboxOpenFailure(await apiFailure(401, apiError(401, 'UNAUTHENTICATED')))).toBe('category=token class=GaxiosError status=401');
    });
    it('no credential is stored for the account', () => {
      expect(describeMailboxOpenFailure(new AccountCredentialError())).toBe('category=token class=AccountCredentialError');
    });
  });

  describe('provider', () => {
    it.each([500, 503, 429, 403, 404])('Google answers an API call with %i', async status => {
      expect(describeMailboxOpenFailure(await apiFailure(status, apiError(status, 'FIXTURE')))).toBe(`category=provider class=GaxiosError status=${status}`);
    });
    it('the token endpoint answers with a server error', async () => {
      expect(describeMailboxOpenFailure(await refreshFailure(503, 'upstream unavailable'))).toBe('category=provider class=GaxiosError status=503');
    });
    it('the token endpoint answers with a code this does not know: it is not guessed at', async () => {
      const unknownCode = await refreshFailure(401, { error: 'some_new_code', error_description: LEAKY });
      expect(describeMailboxOpenFailure(unknownCode)).toBe('category=provider class=GaxiosError status=401');
      const otherStandardCode = await refreshFailure(400, { error: 'invalid_request', error_description: LEAKY });
      expect(describeMailboxOpenFailure(otherStandardCode)).toBe('category=provider class=GaxiosError status=400 code=invalid_request');
    });
    it('Google cannot be reached', async () => {
      const port = await closedPort();
      const err = await thrownBy(() => googleClient((() => fetch(`http://127.0.0.1:${port}/`)) as typeof fetch).refreshAccessToken());
      expect(err).toBeInstanceOf(Common.GaxiosError);
      expect(describeMailboxOpenFailure(err)).toBe('category=provider class=GaxiosError code=ECONNREFUSED');
    });
    it('the deadline for the Google calls has passed', async () => {
      const deadline = AbortSignal.timeout(1);
      await new Promise(done => setTimeout(done, 20));
      const err = await thrownBy(() => googleClient(answers(200, {}), deadline).refreshAccessToken());
      expect(err).toBeInstanceOf(DOMException);
      expect(describeMailboxOpenFailure(err)).toBe('category=provider class=DOMException code=TimeoutError');
    });
  });

  describe('database', () => {
    it('Postgres reports an error', () => {
      expect(describeMailboxOpenFailure(postgresError('42P01'))).toBe('category=database class=DatabaseError code=42P01');
    });
    it('the database cannot be reached', async () => {
      const pool = new Pool({ host: '127.0.0.1', port: await closedPort(), user: 'fixture', password: CLIENT_SECRET, database: MAILBOX_ID });
      try {
        const line = describeMailboxOpenFailure(await thrownBy(() => pool.query('SELECT 1')));
        expect(line).toMatch(/^category=database class=[A-Za-z]+ code=ECONNREFUSED$/);
      } finally { await pool.end(); }
    });
    it("the account store's lookup no longer finds a usable account", () => {
      expect(describeMailboxOpenFailure(new AccountAccessError())).toBe('category=database class=AccountAccessError');
    });
    it('the database did not acknowledge the transaction', () => {
      expect(describeMailboxOpenFailure(new SourceAuthorityUnavailable())).toBe('category=database class=SourceAuthorityUnavailable');
    });
  });

  describe('unknown', () => {
    it.each<[string, unknown]>([
      ['a plain error', new Error(LEAKY)],
      ["the mailbox's own refusal", new AgentMailboxRefusedError(LEAKY)],
      ['a type error', new TypeError(LEAKY)],
      ['a thrown string', LEAKY],
      ['a thrown object', { message: LEAKY, code: 'ECONNREFUSED', status: 401 }],
      ['null', null],
      ['undefined', undefined],
    ])('%s', (_name, err) => {
      expect(classifyMailboxOpenFailure(err)).toBe('unknown');
    });
    it('an answer that is not the shape expected', async () => {
      const err = await thrownBy(() => z.email().max(254).parse(LEAKY));
      expect(describeMailboxOpenFailure(err)).toMatch(/^category=unknown class=[A-Za-z$_]+$/);
    });
    it('a file that could not be read keeps its code but is not called a database failure', () => {
      const err = Object.assign(new Error(`ENOENT: no such file or directory, open '/srv/${MAILBOX_ID}'`), { code: 'ENOENT', syscall: 'open' });
      expect(describeMailboxOpenFailure(err)).toBe('category=unknown class=Error code=ENOENT');
    });
    it('an error that cannot even be inspected', () => {
      const hostile = new Proxy(new Error(LEAKY), { get() { throw new Error(LEAKY); }, getPrototypeOf() { throw new Error(LEAKY); } });
      expect(describeMailboxOpenFailure(hostile)).toBe('category=unknown');
    });
  });
});

describe('the log text', () => {
  it('carries nothing from an error that is full of secrets, in any category', async () => {
    class NamedAfterAnAddress extends Error {}
    Object.defineProperty(NamedAfterAnAddress, 'name', { value: ADDRESS });
    const port = await closedPort();
    const errors: unknown[] = [
      await refreshFailure(400, { error: 'invalid_grant', error_description: LEAKY }),
      await refreshFailure(401, { error: 'invalid_client', error_description: LEAKY }),
      await refreshFailure(400, { error: LEAKY, error_description: LEAKY }),
      await refreshFailure(400, { error: ACCESS_TOKEN }),
      await refreshFailure(500, LEAKY),
      await apiFailure(401, apiError(401, 'UNAUTHENTICATED')),
      await apiFailure(403, apiError(403, 'PERMISSION_DENIED')),
      await thrownBy(() => googleClient((() => fetch(`http://127.0.0.1:${port}/${MAILBOX_ID}?token=${ACCESS_TOKEN}`)) as typeof fetch).refreshAccessToken()),
      postgresError('42P01'),
      Object.assign(postgresError('23505'), { detail: LEAKY, where: LEAKY, table: MAILBOX_ID }),
      // A code is only ever logged when it has the shape of one.
      Object.assign(postgresError('42P01'), { code: MAILBOX_ID }),
      Object.assign(new Error(LEAKY), { code: REFRESH_TOKEN, status: ACCESS_TOKEN, cause: new Error(LEAKY) }),
      Object.assign(new Error(LEAKY), { code: 'ECONNREFUSED', address: ADDRESS, cause: Object.assign(new Error(LEAKY), { code: CLIENT_SECRET }) }),
      Object.assign(new Error(LEAKY), { name: ADDRESS }),
      new NamedAfterAnAddress(LEAKY),
      new GoogleConfigError(LEAKY),
      new AgentMailboxRefusedError(LEAKY),
      new AggregateError([new Error(LEAKY)], LEAKY),
      new DOMException(LEAKY, 'TimeoutError'),
      new DOMException(LEAKY, ADDRESS),
      LEAKY,
      { message: LEAKY, code: REFRESH_TOKEN },
    ];
    const seen = new Set<string>();
    for (const err of errors) {
      const line = describeMailboxOpenFailure(err);
      expect(line).toMatch(LINE);
      for (const secret of FORBIDDEN) expect(line).not.toContain(secret);
      seen.add(line.split(' ')[0]!);
    }
    expect([...seen].sort()).toEqual(['category=client-configuration', 'category=database', 'category=provider', 'category=token', 'category=unknown']);
  });
});

describe('agentMailbox, when it cannot open the mailbox', () => {
  const identity = () => {
    vi.stubEnv('LARES_AGENT_NAME', 'agent-x');
    vi.stubEnv('LARES_AGENT_INCARNATION', '11111111-1111-4111-8111-111111111111');
  };
  /** A pool whose every lookup fails the way it is told to. Never reached by a real query. */
  const failingPool = (fail: () => unknown) => ({ query: async () => { throw fail(); } }) as never;

  it('still answers `unavailable` and nothing more, and logs the kind once', async () => {
    identity();
    const logs: string[] = [];
    const open = () => agentMailbox('email-triage', { pool: failingPool(() => postgresError('42P01')), log: line => { logs.push(line); } });
    expect(await open()).toEqual({ ok: false, reason: 'unavailable' });
    expect(logs).toEqual([
      'email-triage: agent mailbox could not be opened: category=database class=DatabaseError code=42P01',
      'email-triage: agent mailbox unavailable (unavailable): Google did not accept the connection just now',
    ]);
    for (const secret of FORBIDDEN) expect(logs.join('\n')).not.toContain(secret);
    // A steady failure stays quiet.
    expect(await open()).toEqual({ ok: false, reason: 'unavailable' });
    expect(logs).toHaveLength(2);
  });

  it('logs again when the kind of failure changes', async () => {
    identity();
    const logs: string[] = [];
    let failure: unknown = postgresError('42P01');
    const open = () => agentMailbox('email-triage', { pool: failingPool(() => failure), log: line => { logs.push(line); } });
    await open();
    failure = new Error(LEAKY);
    expect(await open()).toEqual({ ok: false, reason: 'unavailable' });
    expect(logs).toHaveLength(3);
    expect(logs[2]).toBe('email-triage: agent mailbox could not be opened: category=unknown class=Error');
  });

  it('keeps one job quiet without silencing another', async () => {
    identity();
    const logs: string[] = [];
    const open = (job: string) => agentMailbox(job, { pool: failingPool(() => postgresError('42P01')), log: line => { logs.push(line); } });
    await open('email-triage'); await open('morning-brief'); await open('email-triage');
    expect(logs.filter(line => line.includes('could not be opened'))).toEqual([
      'email-triage: agent mailbox could not be opened: category=database class=DatabaseError code=42P01',
      'morning-brief: agent mailbox could not be opened: category=database class=DatabaseError code=42P01',
    ]);
  });
});
