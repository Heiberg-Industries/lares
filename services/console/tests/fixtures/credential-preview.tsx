/** Local Vite screenshot fixture only; never a production route or provider test.
 * pnpm -C services/console exec vite --host 127.0.0.1
 * Open /tests/fixtures/credential-preview.html?state=applied|pending|failed|recovery|host|unavailable|unknown
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NotionCredential } from '../../components/NotionCredential';
import type { CredentialView } from '../../lib/credentials';
import type { CredentialStatus } from '@lares/agent-kit/credential-lifecycle';
import '@lares/ui/theme.css';
import '@lares/ui/console.css';
import '../../app/globals.css';

const active = '11111111-1111-4111-8111-111111111111', candidate = '22222222-2222-4222-8222-222222222222';
const state = new URLSearchParams(location.search).get('state') ?? 'applied';
const base: CredentialStatus = { slot: 'notion:shared', state: 'applied', phase: 'applied', guidance: null, revision: 1, activeRevision: active,
  candidateRevision: null, consumers: [{ name: 'example', category: 'owned-agent', incarnation: active }],
  test: { revision: active, outcome: 'passed', at: '2026-10-08T12:00:00.000Z' },
  activation: [{ name: 'example', revision: active, state: 'complete' }], rollback: [], inventoryRevision: 'a'.repeat(64) };
const cases: Record<string, CredentialView> = {
  applied: { kind: 'status', status: base },
  pending: { kind: 'status', status: { ...base, state: 'pending-apply', phase: 'pending-apply', candidateRevision: candidate, test: { ...base.test!, revision: candidate }, activation: [] } },
  failed: { kind: 'status', status: { ...base, state: 'test-failed', phase: 'test-failed', candidateRevision: candidate, test: { revision: candidate, outcome: 'refused', at: base.test!.at } } },
  recovery: { kind: 'status', status: { ...base, state: 'recovery-required', phase: 'recovery-required', guidance: 'inspect-journal', activation: [{ name: 'example', revision: candidate, state: 'failed' }], rollback: [{ name: 'example', revision: active, state: 'failed' }] } },
  host: { kind: 'status', status: { ...base, state: 'host-administration-required', guidance: 'review-consumers', consumers: [{ name: 'retained-sync', category: 'unmanaged-service', incarnation: null }] } },
  unavailable: { kind: 'unavailable' },
  unknown: { kind: 'status', status: base },
};
// Fixed synthetic response only: interaction cannot leave the local fixture or reach keeper.
globalThis.fetch = async () => Response.json({ ok: false, code: state === 'unknown' ? 'outcome-unknown' : 'request-refused' }, { status: 503 });
createRoot(document.getElementById('root')!).render(<main className="lares-page lares-operational" style={{ maxWidth: 840, margin: '0 auto', padding: 24 }}>
  <h1>Connections</h1><p className="lares-muted">Synthetic review data · no providers or installation credentials</p>
  <section className="lares-surface lares-surface-compact"><h2 className="lares-section-title">Google · example</h2>
    <p>Enrolled · 1 mailbox enrolled · provider health not tested</p><p className="lares-muted">Agent access: example</p></section>
  <NotionCredential initial={cases[state] ?? cases.unavailable} />
  <h2>Service sync status</h2><p>Independent recorded evidence: 7 items synced.</p>
</main>);
