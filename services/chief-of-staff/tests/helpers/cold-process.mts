/**
 * A FRESH process for the approval path: no module state, no memo, nothing a previous turn left behind.
 * eve 1.0 rebuilds dynamic tools from their definition after a restart (there are no persisted callback
 * descriptors any more), and an approved call is then run by the code below. The parent test approved a card in
 * the database; this process may know only the database and what eve hands the tool (`ctx.approval.responder`).
 * It does not import the catalogue (that needs the built kit); listing is tested in-process with a fresh memo.
 * Prints one JSON line.
 */
import { readFileSync } from 'node:fs';
import { closePool } from '@lares/agent-kit/db';
import { approvalResponderOf, requireApprovedExecution } from '@lares/agent-kit/approval-execution';
import { deadlineApprovalAdapter } from '../../lib/deadlines-store.js';
import { guardCatalogueExecution } from '../../lib/approvals.js';

const payload = JSON.parse(readFileSync(0, 'utf8'));
const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ran'; } catch (e) { return `refused: ${(e as Error).message.slice(0, 60)}`; } };
try {
  const out = {
    pid: process.pid,
    withResponder: await attempt(() => requireApprovedExecution(payload.context, 'deadline_dismiss', payload.input, { adapter: deadlineApprovalAdapter })),
    hasResponder: approvalResponderOf(payload.context) !== undefined,
    withoutResponder: await attempt(() => requireApprovedExecution({ ...payload.context, approval: undefined }, 'deadline_dismiss', payload.input, { adapter: deadlineApprovalAdapter })),
    guardWithoutResponder: await attempt(() => guardCatalogueExecution({ ...payload.context, approval: undefined }, 'deadline_dismiss', payload.input)),
  };
  process.stdout.write(JSON.stringify(out));
} finally { await closePool(); }
