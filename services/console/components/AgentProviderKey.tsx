'use client';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@lares/ui/primitives/button';
import { Input } from '@lares/ui/primitives/input';
import { providerKeyStatusSchema, type ProviderKeyView } from '../lib/provider-key-schema';

const messages: Record<string, string> = {
  'sign-in-required': 'Sign in again before changing this.',
  'owner-required': 'Only the designated owner can change an agent’s own model key.',
  'origin-refused': 'This request was refused. Open the console at its configured address.',
  'invalid-request': 'The key was not accepted. It must be one line of printable characters with no spaces.',
  'unavailable-before-send': 'The keeper could not be reached. Nothing was changed. Try again.',
  'outcome-unknown': 'The result is not certain. Reload this page to see whether the key was saved or removed.',
  'request-refused': 'The change was refused. Reload this page and try again.',
};
const when = (iso: string) => iso.slice(0, 10);

export function AgentProviderKey({ name, initial }: { name: string; initial: ProviderKeyView }) {
  const [view, setView] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false), field = useRef<HTMLInputElement>(null), pending = useRef('');
  const status = view.kind === 'status' ? view.status : null;
  async function send(body: object) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await fetch('/api/provider-key', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await result.json(); const parsed = providerKeyStatusSchema.safeParse(json.status);
      if (!result.ok || json.ok !== true || !parsed.success) { setMessage(messages[json.code] ?? messages['outcome-unknown']); return; }
      setView({ kind: 'status', status: parsed.data }); setMessage('Saved.');
    } catch { setMessage(messages['outcome-unknown']); }
    finally { setBusy(false); setConfirming(false); pending.current = ''; }
  }
  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!field.current?.value) return;
    pending.current = field.current.value; field.current.value = ''; setConfirming(true);
  }
  return <section className="lares-surface lares-surface-compact lares-stack" aria-labelledby="provider-key-heading">
    <h2 id="provider-key-heading" className="lares-section-title">Own model key</h2>
    {status
      ? <p>{status.own ? `Uses its own key, set on ${status.setAt ? when(status.setAt) : 'an earlier date'}.` : 'Uses the installation’s key.'}</p>
      : <p role="status">The key status is unavailable. Reload this page to try again.</p>}
    <p className="lares-muted">Chats with this agent are paid for with this key instead of the installation’s key. The key is not tested: if it is wrong, this agent’s chats are refused until you replace or remove it. No restart is needed. Lares’s spending limits apply whichever key pays. Only the designated owner can change this.</p>
    {status && !confirming && <form onSubmit={ask} className="lares-stack" autoComplete="off">
      <label className="lares-field-label" htmlFor="provider-key-field">{status.own ? 'New key for this agent' : 'Key for this agent'}</label>
      <Input id="provider-key-field" ref={field} type="password" autoComplete="new-password" required maxLength={4096} disabled={busy} />
      <Button disabled={busy} type="submit">Save and use this key</Button>
    </form>}
    {confirming && <div className="lares-stack" role="group" aria-label="Confirm the new key">
      <p>From now on, {name}’s chats use this key. Nothing checks that it works.</p>
      <div className="lares-inline-form">
        <Button disabled={busy} onClick={() => void send({ operation: 'save', name, key: pending.current })}>Yes, use this key</Button>
        <Button variant="outline" disabled={busy} onClick={() => { pending.current = ''; setConfirming(false); }}>Cancel</Button>
      </div>
    </div>}
    {status?.own && !confirming && <Button variant="outline" disabled={busy} onClick={() => void send({ operation: 'remove', name })}>Remove (go back to the installation’s key)</Button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
