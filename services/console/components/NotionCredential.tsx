'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CREDENTIAL_SLOT, credentialStatusSchema, type CredentialStatus, type CredentialMutation } from '@lares/agent-kit/credential-lifecycle';
import type { CredentialView } from '../lib/credentials';
import { Button } from '@lares/ui/primitives/button';
import { Input } from '@lares/ui/primitives/input';
import { StatePill } from './StatePill';

const guidance = {
  'configure-administrator': 'Ask the host operator to configure one credential administrator.',
  'prepare-managed-slot': 'Ask the host operator to prepare the managed Notion slot. Existing external key files are not adopted here.',
  'prepare-writable-storage': 'Ask the host operator to prepare protected writable credential storage.',
  'review-consumers': 'Ask the host operator to review every consumer. Unmanaged services and external bindings cannot be changed here.',
  'inspect-journal': 'Recovery required. Ask the host operator to inspect the recorded operation and explicitly recover it before another change.',
  'status-unavailable': 'Status unavailable. Refresh status before making a change.',
} as const;
const messages: Record<string, string> = {
  'sign-in-required': 'Sign in again before managing credentials.',
  'administrator-required': 'The installation credential administrator is required. Ask the host operator to check this account and the administrator configuration.',
  'origin-refused': 'This request was refused. Open the console at its configured address.',
  'invalid-request': 'The request was invalid. Refresh status before trying again.',
  'unavailable': 'Credential status unavailable. Other connection evidence remains shown separately.',
  'unavailable-before-send': 'Keeper could not be reached. No credential change was sent. Refresh status before trying again.',
  'outcome-unknown': 'The result is unknown: the request may have run. Refresh status to inspect the existing operation. Do not submit the change again.',
  'request-refused': 'Keeper refused this request. Refresh status and review the current key, pending change and affected consumers.',
};
const progress = (items: CredentialStatus['activation']) => items.length
  ? <ul>{items.map(p => <li key={p.name}>{p.name}: {p.state}</li>)}</ul> : <p className="lares-muted">No runtime progress recorded.</p>;

/** Fired by another card (Clipping) after it changed this credential, so this card reads it again. */
export const NOTION_CREDENTIAL_CHANGED = 'lares:notion-credential-changed';

export function NotionCredential({ initial }: { initial: CredentialView }) {
  const [view, setView] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(false), [stale, setStale] = useState(false), [confirm, setConfirm] = useState<'apply' | 'disconnect' | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const token = useRef<HTMLInputElement>(null), inFlight = useRef(false);
  const status = view.kind === 'status' ? view.status : null;
  const editable = !!status && !status.guidance && status.state !== 'unavailable' && status.revision !== null && !uncertain && !stale;
  async function refresh() {
    if (inFlight.current) return; inFlight.current = true; setBusy(true);
    try {
      const result = await fetch('/api/credentials/notion', { cache: 'no-store', credentials: 'same-origin' });
      const body = await result.json(); const parsed = credentialStatusSchema.safeParse(body.status);
      if (!result.ok || body.ok !== true || !parsed.success) { setMessage(messages[body.code] ?? messages.unavailable); setStale(true); return; }
      setView({ kind: 'status', status: parsed.data }); setUncertain(false); setStale(false); setConfirm(null); setConfirmed(false); setMessage('Status refreshed.');
    } catch { setMessage(messages.unavailable); setStale(true); }
    finally { inFlight.current = false; setBusy(false); }
  }
  useEffect(() => {
    const onChanged = () => { void refresh(); };
    window.addEventListener(NOTION_CREDENTIAL_CHANGED, onChanged);
    return () => window.removeEventListener(NOTION_CREDENTIAL_CHANGED, onChanged);
  });
  async function submit(command: CredentialMutation) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage(''); setConfirm(null); setConfirmed(false);
    try {
      const result = await fetch('/api/credentials/notion', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
      const body = await result.json(); const parsed = credentialStatusSchema.safeParse(body.status);
      if (!result.ok || body.ok !== true || !parsed.success) {
        const code = typeof body.code === 'string' && messages[body.code] ? body.code : 'outcome-unknown';
        setMessage(messages[code]); setStale(true); if (code === 'outcome-unknown') setUncertain(true); return;
      }
      setView({ kind: 'status', status: parsed.data }); setMessage('Operation recorded. Review the result below.');
    } catch { setMessage(messages['outcome-unknown']); setUncertain(true); setStale(true); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const command = (operation: 'test_current' | 'test_pending' | 'discard') => {
    if (status?.revision !== null && status?.revision !== undefined)
      void submit({ operation, slot: CREDENTIAL_SLOT, expectedRevision: status.revision });
  };
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!token.current || !status || status.revision === null || inFlight.current) return;
    const value = token.current.value; token.current.value = '';
    void submit({ operation: 'test_save', slot: CREDENTIAL_SLOT, expectedRevision: status.revision, token: value });
  }
  const activate = () => {
    if (!confirm || !confirmed || !status || status.revision === null || !status.inventoryRevision || !editable) return;
    void submit({ operation: confirm, slot: CREDENTIAL_SLOT, expectedRevision: status.revision,
      expectedActiveRevision: status.activeRevision, inventoryRevision: status.inventoryRevision, confirmRestart: true });
  };
  const canActivate = editable && !!status?.inventoryRevision && status.consumers.every(c => c.category === 'owned-agent' && c.incarnation);
  return <section className="lares-surface lares-surface-compact lares-stack" aria-labelledby="notion-credential-heading">
    <h2 id="notion-credential-heading" className="lares-section-title">Notion key</h2>
    <p className="lares-muted">One installation key for a Notion internal connection. Testing reads its identity; it does not prove access to pages or content.</p>
    {stale && <p role="status">Current status unavailable. The last observed credential evidence is retained below.</p>}
    {status ? <>
      <StatePill state={status.state} />
      <p>Current key: {status.activeRevision ? 'stored' : status.state === 'unavailable' ? 'unavailable' : 'none stored'}.</p>
      <p>Replacement: {status.candidateRevision ? 'saved pending change' : status.state === 'unavailable' ? 'unavailable' : 'none pending'}.</p>
      <p>Last identity test: {status.test ? <>{status.test.outcome} for the {status.test.revision === status.candidateRevision ? 'replacement' : 'current key'} · <time dateTime={status.test.at}>{status.test.at}</time></> : status.state === 'unavailable' ? 'unavailable' : 'no test recorded'}.</p>
      <h3>Activation</h3>{progress(status.activation)}
      <h3>Rollback</h3>{progress(status.rollback)}
      {status.guidance && <p role="status">{guidance[status.guidance]}</p>}
      <details><summary>Affected consumers ({status.consumers.length})</summary>
        <p className="lares-muted">Keeper evidence of configured consumers, separate from the connection catalogue and agent permissions.</p>
        <ul>{status.consumers.map(c => <li key={`${c.name}:${c.category}`}>{c.name} · {c.category.replaceAll('-', ' ')}</li>)}</ul>
      </details>
      {editable && <>
        {!status.candidateRevision && <form onSubmit={save} className="lares-stack" autoComplete="off">
          <label className="lares-field-label" htmlFor="notion-token">New Notion internal connection key</label>
          <Input id="notion-token" ref={token} type="password" autoComplete="new-password" required maxLength={8192} disabled={busy} />
          <p className="lares-muted">Test and save leaves the current key and running agents unchanged. Apply is a separate action.</p>
          <Button disabled={busy} type="submit">Test and save replacement</Button>
        </form>}
        <div className="lares-inline-form">
          {status.activeRevision && !status.candidateRevision && <Button variant="outline" disabled={busy} onClick={() => command('test_current')}>Test current key</Button>}
          {status.candidateRevision && <><Button variant="outline" disabled={busy} onClick={() => command('test_pending')}>Test pending key</Button><Button variant="outline" disabled={busy} onClick={() => command('discard')}>Discard replacement</Button></>}
          {status.state === 'pending-apply' && <Button disabled={busy || !canActivate} onClick={() => { setConfirm('apply'); setConfirmed(false); }}>Apply replacement</Button>}
          {status.activeRevision && <Button variant="outline" disabled={busy || !canActivate} onClick={() => { setConfirm('disconnect'); setConfirmed(false); }}>Disconnect locally</Button>}
        </div>
        {!status.inventoryRevision && <p className="lares-muted">Refresh credential status to confirm the affected consumers before Apply or Disconnect.</p>}
      </>}
      {confirm && <div className="lares-stack" role="group" aria-label="Confirm runtime restart">
        <p>{confirm === 'apply' ? 'Apply the tested replacement' : 'Remove the Notion binding locally'} and restart every affected agent:</p>
        {status.consumers.length ? <ul>{status.consumers.map(c => <li key={c.name}>{c.name}</li>)}</ul> : <p>No affected agents are recorded.</p>}
        <p className="lares-muted">Agents will stop and restart. This does not guarantee that current work has finished.</p>
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I confirm the complete consumer list and these restarts.</label>
        <div className="lares-inline-form"><Button disabled={busy || !confirmed || !editable} onClick={activate}>Confirm {confirm === 'apply' ? 'Apply' : 'local Disconnect'}</Button><Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button></div>
      </div>}
    </> : <p role="status">{messages[view.kind]}</p>}
    <p className="lares-muted">Provider revocation is not implemented for this token type. Local Disconnect removes its use and stored values in Lares; revoke it separately in Notion.</p>
    {message && <p role="status">{message}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh credential status</Button>
  </section>;
}
