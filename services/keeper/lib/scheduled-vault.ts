/**
 * `vault.scheduled`: how a scheduled job (the nightly memory cycle, the clipping drain) reads and
 * saves notes in the Vault when the Vault is keeper's custody and the agent has no folder of its own.
 *
 * It gets the same checks a model-called tool gets (ADR 0017, "Operational rules"), in the same order
 * as the scheduled Tracks read beside it: a signed runtime request, a ready agent with a valid applied
 * definition, the owner read from the agent's access record (never from the request), the owner's
 * current use of the agent, the agent's own `vault` grant for the area (a write needs a write grant),
 * exactly one active area the owner may use or edit. Then two checks only a job needs: the schedule
 * must be named in `scheduled-vault-policy.ts`, and the path must be one that schedule may touch.
 *
 * There is no card and no person in the turn, so every write carries a job authority
 * (`origin: 'job'`, the schedule as the job, a fresh run id) and is stamped `lares_origin: agent`.
 */
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { authorityTransaction, type AuthorityPool } from '@lares/agent-kit/console-turn-authority';
import { parseDefinition } from '@lares/agent-kit/definition';
import { canWriteVaultArea, grantedVaultAreas } from '@lares/agent-kit/manifest';
import { currentMember } from '@lares/agent-kit/member-store';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { GuardedVaultFiles, type VaultFilesBackings } from '@lares/agent-kit/vault-files';
import { NoteNotFoundError, visibleTo, type Reader } from '@lares/agent-kit/notes-store';
import { vaultWriteBindingSchema } from '@lares/agent-kit/authority-contract';
import { serializeFrontmatter } from '@lares/agent-kit/vault-git';
import {
  SCHEDULED_VAULT_LIST_DEFAULT, SCHEDULED_VAULT_LIST_MAX, SCHEDULED_VAULT_MAX_BODY_BYTES, isScheduledVaultSchedule,
  scheduledMessageOk, scheduledPathAllowed, scheduledPrefixAllowed, scheduledVaultRule, scheduledVerbatimRefusal, type ScheduledVaultOperation,
} from '@lares/agent-kit/scheduled-vault-policy';
import { loadVaultStorageInventory, verifyVaultStorageMetadata } from '@lares/agent-box/lib/vault-storage.js';

/**
 * How long keeper works on one scheduled operation before it gives up. A write is a commit plus a
 * push to the area's local bare origin, which takes tens of milliseconds on the box; the 1.7 s every
 * other runtime operation gets leaves no room for a slow disk or a Vault with many files, so this gets
 * the outside-call bound (8 s). The agent side waits 10 s, the socket's own limit, so keeper always
 * answers or refuses first.
 */
export const SCHEDULED_VAULT_DEADLINE_MS = 8000;

const OPERATIONS: readonly string[] = ['list', 'read', 'write', 'write-verbatim', 'move', 'remove'];
const refuse = (reason: string): never => { throw new Error(reason); };
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

export interface ScheduledVaultContext {
  pool: AuthorityPool; agent: string; incarnation: string; input: Record<string, unknown>;
  deadlineAtMs: number; assertNotAborted: () => void;
  /** Test seam: where the area folders and bare origins live, instead of the box's real paths. */
  testPaths?: { root: string; originRoot: string };
}

export async function scheduledVault(c: ScheduledVaultContext): Promise<Record<string, unknown>> {
  const { input, agent, incarnation, assertNotAborted } = c;
  const { schedule, operation, area } = input;
  if (!isScheduledVaultSchedule(schedule) || typeof operation !== 'string' || !OPERATIONS.includes(operation) ||
      (area !== 'private' && area !== 'shared')) return refuse('scheduled');
  const op = operation as ScheduledVaultOperation, rule = scheduledVaultRule(schedule, area);
  if (!rule) return refuse('schedule');
  const path = input.path, destination = input.destination;

  // Everything that can be judged without the database is judged first.
  if (op === 'list') {
    if (!scheduledPrefixAllowed(rule, input.prefix)) refuse('prefix');
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 512)) refuse('cursor');
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > SCHEDULED_VAULT_LIST_MAX)) refuse('limit');
  } else if (op === 'read') {
    if (!scheduledPathAllowed(rule, 'read', path)) refuse('path');
  } else if (op === 'write') {
    const fm = input.frontmatter;
    if (!scheduledPathAllowed(rule, 'write', path) || !fm || typeof fm !== 'object' || Array.isArray(fm) ||
        !Object.entries(fm).every(([k, v]) => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(k) && [v].flat().every((x) =>
          x === null || x === undefined || typeof x === "boolean" || typeof x === "number" || (typeof x === "string" && !/[\r\n\x00-\x1f\x7f\u0085\u2028\u2029]/.test(x)))) ||
        typeof input.body !== 'string' || bytes(input.body) > SCHEDULED_VAULT_MAX_BODY_BYTES ||
        (input.message !== undefined && !scheduledMessageOk(input.message))) refuse('write');
  } else if (op === 'write-verbatim') {
    // The keeper judges the file itself (path, text, size, and the one origin it may carry); nothing is trusted from the caller.
    const why = scheduledVerbatimRefusal(rule, path, input.content);
    if (why) refuse(why);
    if (input.message !== undefined && !scheduledMessageOk(input.message)) refuse('The commit message must be one short line.');
  } else if (op === 'move') {
    if (!scheduledPathAllowed(rule, 'read', path) || !scheduledPathAllowed(rule, 'remove', path) ||
        !scheduledPathAllowed(rule, 'write', destination) || destination === path) refuse('move');
  } else if (!scheduledPathAllowed(rule, 'remove', path)) refuse('path');
  const mutating = op === 'write' || op === 'write-verbatim' || op === 'move' || op === 'remove';

  return await authorityTransaction(c.pool, async (db) => {
    await db.query("SELECT set_config('statement_timeout','1000ms',true)");
    await db.query("SELECT set_config('lock_timeout','500ms',true)");
    assertNotAborted();
    const rows = await db.query(`SELECT a.owner_member_id,a.organisation_id,r.applied_definition
      FROM agent_resources r JOIN agent_definitions d ON d.name=r.name JOIN agent_access a ON a.agent_name=r.name
      WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token
        AND r.state='ready' AND NOT r.pending AND d.status='valid' AND r.applied_definition IS NOT NULL
      FOR SHARE OF r,d,a`, [agent, incarnation]);
    if (rows.rows.length !== 1) return refuse('owner');
    const ownerId = String(rows.rows[0]!.owner_member_id), member = await currentMember(db as never, ownerId);
    if (!member || member.organisationId !== rows.rows[0]!.organisation_id) return refuse('member');
    if (!await new PgGrantStore().captureUse(ownerId, agent, { db: db as never })) return refuse('grant');
    let definition; try { definition = parseDefinition(rows.rows[0]!.applied_definition); } catch { return refuse('definition'); }
    if (!(mutating ? canWriteVaultArea(definition, area) : grantedVaultAreas(definition).includes(area))) return refuse('vault grant');
    const inventory = loadVaultStorageInventory(); await verifyVaultStorageMetadata(db as never, inventory, true); assertNotAborted();
    const areaRows = await db.query("SELECT id,revision FROM vault_areas WHERE organisation_id=$1 AND kind=$2 AND status='active' ORDER BY id LIMIT 513", [member.organisationId, area]);
    if (areaRows.rows.length > 512) return refuse('areas');
    const vault = new PgVaultStore(), matches = [] as { areaId: string; revision: number }[];
    for (const candidate of areaRows.rows) {
      assertNotAborted();
      if (!inventory.areas.some((a) => a.areaId === candidate.id && a.kind === area)) return refuse('inventory');
      const binding = await vault.vaultAreaBinding(ownerId, { areaId: String(candidate.id), expectedRevision: Number(candidate.revision), permission: mutating ? 'edit' : 'use' }, { db: db as never, requiredBackingKind: 'git' });
      if (binding) matches.push({ areaId: String(candidate.id), revision: Number(candidate.revision) });
    }
    if (matches.length !== 1) return refuse('area');
    const selected = matches[0]!, t = c.testPaths;
    const backings: VaultFilesBackings = new Map([[inventory.backing.id, { kind: 'git' as const, root: t?.root ?? '/srv',
      areas: new Map(inventory.areas.map((a) => [a.areaId, { origin: t ? join(t.originRoot, `${a.areaId}.git`) : a.origin }])) }]]);
    const files = new GuardedVaultFiles(vault, backings), ctx = { memberId: ownerId, areaId: selected.areaId, expectedRevision: selected.revision, db: db as never };
    const reader: Reader = { userId: ownerId, store: area === 'private' ? 'brain' : 'atlas' };
    const current = async (p: string) => { try { return await files.read(ctx, p); } catch (error) { if (error instanceof NoteNotFoundError) return undefined; throw error; } };
    const runId = randomUUID(), placeId = `scheduled:${schedule}`;
    const bind = (relativePath: string, expectedContentRevision: string | null) => vaultWriteBindingSchema.parse({
      areaId: selected.areaId, relativePath, expectedContentRevision, accessRevision: selected.revision, approvedOrigin: 'agent',
      authority: { origin: 'job', agentId: agent, turnId: runId, sessionId: `scheduled-${schedule}`, placeId,
        audience: { placeId, revision: 0, participants: [{ kind: 'member', memberId: ownerId }] }, policyRevision: 0,
        actingMemberId: ownerId, spokenByMemberId: null, jobId: schedule, runId } });

    if (op === 'list') {
      const prefix = input.prefix as string, cursor = typeof input.cursor === 'string' ? input.cursor : '', limit = Number(input.limit ?? SCHEDULED_VAULT_LIST_DEFAULT);
      const all = (prefix === '' ? await files.list(ctx) : await files.listUnder(ctx, prefix)).paths.sort(), after = all.filter((p) => p > cursor), page = after.slice(0, limit);
      assertNotAborted();
      return { paths: page, ...(after.length > limit ? { nextCursor: page[page.length - 1] } : {}) };
    }
    if (op === 'read') {
      const note = await current(path as string); assertNotAborted();
      if (!note || !visibleTo(note.content, reader)) return { found: false };
      if (input.probe === true) return { found: true, contentRevision: note.contentRevision };
      const size = bytes(note.content);
      if (size > SCHEDULED_VAULT_MAX_BODY_BYTES) return { found: true, tooLarge: true, bytes: size, contentRevision: note.contentRevision };
      return { found: true, path, content: note.content, contentRevision: note.contentRevision };
    }
    if (op === 'write') {
      const before = await current(path as string), frontmatter = input.frontmatter as Record<string, unknown>, body = input.body as string;
      // Writing what is already there is a no-op. A commit of nothing would fail, and a re-run of a pass is common.
      if (before && before.content === `${serializeFrontmatter({ ...frontmatter, lares_origin: 'agent' })}\n\n${body}`) return { path, unchanged: true };
      assertNotAborted();
      const written = await files.write(ctx, { binding: bind(path as string, before?.contentRevision ?? null), frontmatter, body, message: input.message as string | undefined });
      assertNotAborted(); return { path, commit: written.commit };
    }
    if (op === 'write-verbatim') {
      const before = await current(path as string), content = input.content as string;
      // The same file again is a no-op, not an empty commit.
      if (before && before.content === content) return { path, unchanged: true };
      assertNotAborted();
      const binding = vaultWriteBindingSchema.parse({ ...bind(path as string, before?.contentRevision ?? null), approvedOrigin: rule.verbatimOrigin });
      const written = await files.writeVerbatim(ctx, { binding, content, message: input.message as string | undefined });
      assertNotAborted(); return { path, commit: written.commit };
    }
    if (op === 'move') {
      const source = await current(path as string);
      if (!source) return refuse('not found');
      if (await current(destination as string)) return refuse('destination exists');
      assertNotAborted();
      const moved = await files.move(ctx, { binding: bind(path as string, source.contentRevision), destination: destination as string, expectedDestinationRevision: null, companion: null, expectedCompanionDestinationRevision: null });
      assertNotAborted(); return { path: destination, commit: moved.commit };
    }
    const target = await current(path as string);
    if (!target) return { removed: false };
    assertNotAborted();
    const removed = await files.remove(ctx, { binding: bind(path as string, target.contentRevision), companion: null });
    assertNotAborted(); return { removed: true, commit: removed.commit };
  }, { deadlineAtMs: c.deadlineAtMs });
}
