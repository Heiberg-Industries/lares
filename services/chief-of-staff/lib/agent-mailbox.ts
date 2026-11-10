/**
 * The mailbox this agent works on, for scheduled jobs (no person in a session).
 *
 * The agent's owner chooses one of their own connected Google accounts (the stored choice is
 * `agent_account_bindings`, kit `PgAgentMailboxStore`). `agentMailbox(job)` turns that choice into
 * clients a job can use, or says plainly why it cannot:
 *
 *   1. who we are and whether we may act: managed identity, agent ready, definition valid, runtime
 *      controlled, and the owner read from `agent_access` (never from input or the environment);
 *   2. the stored choice still holds (`PgAgentMailboxStore.check`: member active, account ok,
 *      same generation, same owner, draft-capable scopes, still granted);
 *   3. one bounded refresh inside the account store's locked transaction, token identity checked,
 *      a rotated refresh token saved, then COMMIT. The custody lock is held for that setup only and
 *      is never held while a job runs: the returned clients carry an access token and nothing else.
 *
 * DRAFTS ONLY. A compose-scoped token can send mail at Google's end, so the refusal below is the
 * only guard: `send` is replaced on both the client and the message layer, and every write the
 * calendar offers is refused. `draft` and `updateDraftRaw` re-run the credential-free check first;
 * if the choice no longer holds, the draft is refused.
 *
 * DRIVE, READ ONLY. When the verified token also carries `drive.readonly` (the "read + drafts" consent
 * since Drive reading joined it), the mailbox carries a Drive reader that can fetch a file's details,
 * export a Google document and download a file, and nothing else; each use rechecks the choice first.
 * An account connected earlier has no such scope and gets `drive: null`.
 */
import { google } from 'googleapis';
import type { Pool } from 'pg';
import { z } from 'zod';
import { PgAccountStore } from '@lares/agent-kit/account-store';
import { rotateAccountCredential } from '@lares/agent-kit/account-credentials';
import { PgAgentMailboxStore, type AgentMailboxBinding, type AgentMailboxReason } from '@lares/agent-kit/agent-mailbox-store';
import { getPool } from '@lares/agent-kit/db';
import { managedIdentity } from '@lares/agent-kit/door-authority';
import type { AgentDefinition } from '@lares/agent-kit/definition';
import { buildOAuth2Client, decryptSecret, readTokenEncKey } from '@lares/agent-kit/google-auth';
import { validateGooglePersonalScopes } from '@lares/agent-kit/personal-consent';
import { encryptSecret } from '@lares/agent-box/lib/crypto.js';
import { thisAgent } from './definition.js';
import type { DriveApi } from './google-drive.js';
import { personalOrgConfig } from './google-orgs.js';
import {
  bindPersonalGoogleDeadline, makeCalendarClient, makeGmailClient, personalCalendarApi, personalGmailApi,
  wrapCalendarApi, wrapGmailApi, type CalendarClient, type GmailClient,
} from './google.js';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const CALENDAR_WRITE_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar'];
/** The single refresh, identity check and profile read must finish inside this. */
const SETUP_MS = 15_000;
/** How long a job may keep using its clients (an access token lives about an hour). */
const DEFAULT_WORK_MS = 10 * 60_000;

/** Why no mailbox is available. The stored-choice reasons come from the kit; the rest are ours. */
export type AgentMailboxRefusalReason = AgentMailboxReason | 'not-managed' | 'agent-not-ready' | 'unavailable';

export class AgentMailboxRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentMailboxRefusedError'; }
}

export interface AgentMailbox {
  ok: true;
  /** The mailbox address; the key for voice and triage rows. */
  mailbox: string;
  /** The agent's owner at the moment the mailbox was opened (the binding owner). */
  ownerMemberId: string;
  /** Reads, and drafts. `send` always refuses. */
  gmail: GmailClient;
  /** Reads always. Event writes work only when the account's consent includes calendar.events (or calendar). */
  calendar: CalendarClient;
  /** Reads files (details, export, download) only; null when the account's consent has no Drive permission. */
  drive: DriveApi | null;
  /** Is the stored choice still usable right now? Credential-free, holds no lock. */
  recheck(): Promise<boolean>;
}
export type AgentMailboxResult = AgentMailbox | { ok: false; reason: AgentMailboxRefusalReason };

export interface AgentMailboxDeps {
  pool?: Pool;
  /** Test seam: the HTTP layer for the refresh, token check and Gmail/Calendar calls. */
  fetch?: typeof fetch;
  definition?: () => Promise<AgentDefinition>;
  /** How long the returned clients may be used. */
  workMs?: number;
  log?: (line: string) => void;
}

const SAY: Record<AgentMailboxRefusalReason, string> = {
  none: 'no mailbox has been chosen for this agent',
  'member-inactive': "the owner's membership is no longer active",
  'account-not-ok': "the chosen account was disconnected or needs to be connected again",
  'generation-changed': 'the chosen account was reconnected; the owner must confirm the choice again',
  'owner-changed': 'the agent has a new owner; the new owner must choose a mailbox',
  'scopes-not-draft': 'the chosen account may read but not write drafts; connect it again with drafts',
  'not-granted': "this agent's definition no longer allows a personal mailbox",
  'not-managed': 'this process is not a managed agent',
  'agent-not-ready': 'the agent is not ready or its definition is not valid',
  unavailable: 'Google did not accept the connection just now',
};

/** One line per CHANGE of reason, per job. A steady refusal is quiet until it changes or clears. */
const lastSaid = new Map<string, string>();
export function resetAgentMailboxLogForTests(): void { lastSaid.clear(); }
function sayOnce(job: string, reason: AgentMailboxRefusalReason | null, log: (line: string) => void): void {
  if (reason === null) { lastSaid.delete(job); return; }
  if (lastSaid.get(job) === reason) return;
  lastSaid.set(job, reason);
  log(`${job}: agent mailbox unavailable (${reason}): ${SAY[reason]}`);
}
/** Same once-per-change rule for any other plain notice a caller needs to make (the triage ping). */
export function noteOnce(key: string, text: string, log: (line: string) => void = console.log): void {
  if (lastSaid.get(key) === text) return;
  lastSaid.set(key, text);
  log(text);
}

export async function loadOwner(pool: Pool, agent: string, incarnation: string): Promise<string | null> {
  const { rows } = await pool.query<{ owner_member_id: string }>(
    `SELECT x.owner_member_id FROM agent_resources r
       JOIN agent_definitions d ON d.name=r.name
       JOIN agent_access x ON x.agent_name=r.name
      WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token
        AND NOT r.pending AND r.state='ready' AND d.status='valid'`, [agent, incarnation]);
  return rows[0]?.owner_member_id ?? null;
}

const refuse = (what: string): never => { throw new AgentMailboxRefusedError(what); };

export async function agentMailbox(job: string, deps: AgentMailboxDeps = {}): Promise<AgentMailboxResult> {
  const log = deps.log ?? console.log;
  const no = (reason: AgentMailboxRefusalReason): AgentMailboxResult => { sayOnce(job, reason, log); return { ok: false, reason }; };
  try {
    const identity = managedIdentity();
    if (!identity) return no('not-managed');
    const pool = deps.pool ?? getPool();
    const owner = await loadOwner(pool, identity.name, identity.incarnation);
    if (!owner) return no('agent-not-ready');
    const definition = await (deps.definition ?? (async () => (await thisAgent(undefined)).loaded.definition))();
    const store = new PgAgentMailboxStore(pool);
    const first = await store.check(identity.name, definition);
    if (!first.ok) return no(first.reason);
    const binding = first.binding;
    if (binding.ownerMemberId !== owner) return no('owner-changed');

    const opened = await openClients(pool, binding, deps);
    // The same choice, still: an unchanged revision and generation, and everything else rechecked.
    const recheck = async (): Promise<boolean> => {
      try {
        const now = await store.check(identity.name, definition);
        return now.ok && now.binding.revision === binding.revision && now.binding.accountGeneration === binding.accountGeneration &&
          now.binding.ownerMemberId === owner;
      } catch { return false; }
    };
    const stillOrRefuse = async (notDone = 'the draft was not written'): Promise<void> => {
      if (!(await recheck())) refuse(`The agent's mailbox choice no longer holds; ${notDone}`);
    };
    const gmail: GmailClient = {
      ...opened.gmail,
      send: async () => refuse('This agent writes drafts only; send it from Gmail'),
      draft: async input => { await stillOrRefuse(); return opened.gmail.draft(input); },
      updateDraftRaw: async (id, raw, threadId) => { await stillOrRefuse(); return opened.gmail.updateDraftRaw(id, raw, threadId); },
    };
    // Event writes: only with the scope the verified token carries, and only while the choice still holds.
    // (The tools gate each one behind the owner's approval before they ever get here.)
    const writable = async (): Promise<void> => {
      if (!opened.calendarWrites) refuse('To add calendar events, reconnect Google on Your accounts');
      await stillOrRefuse('the event was not changed');
    };
    const calendar: CalendarClient = {
      ...opened.calendar,
      insertEvent: async o => { await writable(); return opened.calendar.insertEvent(o); },
      updateEvent: async o => { await writable(); return opened.calendar.updateEvent(o); },
      deleteEvent: async o => { await writable(); return opened.calendar.deleteEvent(o); },
    };
    const drive: DriveApi | null = opened.drive && {
      files: {
        get: (async (...args: Parameters<DriveApi['files']['get']>) => { await stillOrRefuse('the file was not read'); return (opened.drive!.files.get as (...a: unknown[]) => unknown)(...args); }) as DriveApi['files']['get'],
        export: (async (...args: Parameters<DriveApi['files']['export']>) => { await stillOrRefuse('the file was not read'); return (opened.drive!.files.export as (...a: unknown[]) => unknown)(...args); }) as DriveApi['files']['export'],
      },
    };
    sayOnce(job, null, log);
    return { ok: true, mailbox: opened.mailbox, ownerMemberId: owner, gmail, calendar, drive, recheck };
  } catch (err) {
    // Provider, key, client-config or database trouble. Say it plainly, once; no stack, no detail.
    void err;
    return no('unavailable');
  }
}

/** Steps 3 to 5: one refresh inside the locked transaction; the transaction ends before this returns. */
async function openClients(pool: Pool, binding: AgentMailboxBinding, deps: AgentMailboxDeps) {
  return new PgAccountStore(pool).withPersonalResourceCredential(binding.ownerMemberId,
    { accountId: binding.accountId, generation: binding.accountGeneration, resourceBindingId: binding.resourceBindingId },
    'mailbox', async ({ account, resource }, credential, db) => {
      if (account.connectorId !== 'google' || account.providerAccount.issuer !== GOOGLE_ISSUER ||
        resource.externalId !== account.providerAccount.subject) refuse('Chosen account is not a verified Google mailbox');
      validateGooglePersonalScopes(credential.scopes, 'read+mail-draft');
      const cfg = personalOrgConfig(credential.orgId), key = readTokenEncKey();
      const refresh = decryptSecret(credential.refreshTokenEnc, key);
      const setup = AbortSignal.timeout(SETUP_MS);
      const work = AbortSignal.timeout(deps.workMs ?? DEFAULT_WORK_MS);
      const client = (token: string, signal: AbortSignal) => {
        const auth = buildOAuth2Client(cfg, token);
        if (deps.fetch) auth.transporter.defaults = { ...auth.transporter.defaults, fetchImplementation: deps.fetch };
        bindPersonalGoogleDeadline(auth, signal);
        auth.transporter.interceptors.request.add({ resolved: async o => ({ ...o, redirect: 'error', maxRedirects: 0 }) });
        return auth;
      };
      const auth = client(refresh, setup);
      let refreshes = 0, rotated: string | undefined;
      auth.on('tokens', t => { if (t.refresh_token && t.refresh_token !== refresh) rotated = t.refresh_token; });
      auth.transporter.interceptors.request.add({ resolved: async o => {
        if (String(o.url) === String(auth.endpoints.oauth2TokenUrl) && ++refreshes !== 1) refuse('More than one refresh');
        return o;
      } });
      const { credentials } = await auth.refreshAccessToken();
      const access = credentials.access_token;
      if (typeof access !== 'string' || !access) refuse('No access token');
      const info = await auth.getTokenInfo(access as string);
      if (info.sub !== account.providerAccount.subject || info.aud !== cfg.clientId ||
        !Number.isFinite(info.expiry_date) || (info.expiry_date as number) <= Date.now()) refuse('Token does not match the chosen account');
      validateGooglePersonalScopes(info.scopes, 'read+mail-draft');
      if (JSON.stringify([...new Set(info.scopes)].sort()) !== JSON.stringify([...new Set(credential.scopes)].sort())) refuse('Token scopes differ from consent');

      // Overwrite ALL refresh material: this client has an access token, no refresh token and no expiry,
      // so it can never refresh or replay a request. The profile read uses the short setup deadline;
      // the clients handed to the job use the longer work deadline.
      const probeAuth = client('', setup); probeAuth.setCredentials({ access_token: access as string });
      const probe = await personalGmailApi(cfg, probeAuth, access as string).users.getProfile({ userId: 'me' });
      const mailbox = z.email().max(254).parse(probe.data.emailAddress);
      if (mailbox !== credential.emailAddress) refuse('Mailbox address differs from the connected account');

      if (rotated) {
        await rotateAccountCredential(db, { id: account.id, ownerMemberId: binding.ownerMemberId, connectorId: account.connectorId,
          generation: account.generation }, credential, encryptSecret(rotated, key));
      }
      const jobAuth = client('', work); jobAuth.setCredentials({ access_token: access as string });
      const gmailMessages = wrapGmailApi(personalGmailApi(cfg, jobAuth, access as string), mailbox);
      const gmail = makeGmailClient({ ...gmailMessages, send: async () => refuse('This agent writes drafts only; send it from Gmail') });
      const calendar = makeCalendarClient(wrapCalendarApi(personalCalendarApi(cfg, jobAuth, access as string)));
      const drive = info.scopes.includes(DRIVE_READONLY)
        ? { files: google.drive({ version: 'v3', auth: jobAuth }).files } as DriveApi : null;
      const calendarWrites = CALENDAR_WRITE_SCOPES.some(sc => info.scopes.includes(sc));
      return { mailbox, gmail, calendar, drive, calendarWrites };
    });
}
