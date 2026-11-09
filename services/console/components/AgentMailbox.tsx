'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@lares/ui/primitives/button';
import { Input } from '@lares/ui/primitives/input';
import { Select } from '@lares/ui/primitives/select';
import type { AgentMailboxViewDTO } from '../lib/agent-mailbox';

const OUTCOME_UNKNOWN = 'The result is not certain. Reload this page to see what was saved.';
const NONE = '';

/** The power asked for when connecting from here: read, plus writing drafts. It never sends. */
function GoogleForm({ children, fields }: { children: React.ReactNode; fields: Record<string, string | number> }) {
  return <form method="POST" action="/api/accounts/google/start" className="lares-inline-form">
    {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    <input type="hidden" name="power" value="read+mail-draft" />
    {children}
  </form>;
}

export function AgentMailbox({ name, initial }: { name: string; initial: AgentMailboxViewDTO }) {
  const [view, setView] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [choosing, setChoosing] = useState(false);
  async function send(body: object) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await fetch('/api/agent-mailbox', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ...body }) });
      const json = await result.json();
      if (!result.ok || json.ok !== true || !json.view) { setMessage(typeof json.message === 'string' ? json.message : OUTCOME_UNKNOWN); return; }
      setView(json.view as AgentMailboxViewDTO); setChoosing(false);
    } catch { setMessage(OUTCOME_UNKNOWN); }
    finally { setBusy(false); }
  }
  function pick(value: string) {
    if (value === NONE) return void send({ operation: 'clear' });
    const option = view.options.find(o => o.resourceBindingId === value);
    if (option) void send({ operation: 'choose', accountId: option.accountId, resourceBindingId: option.resourceBindingId });
  }
  const showSelect = view.options.length > 0 && (view.state === 'choose' || view.state === 'working' || (view.state === 'paused' && choosing));
  const selected = view.state === 'working' ? view.chosen?.resourceBindingId ?? NONE : NONE;
  return <section className="lares-surface lares-surface-compact lares-stack" aria-labelledby="agent-mailbox-heading">
    <h2 id="agent-mailbox-heading" className="lares-section-title">{view.title}</h2>
    <p>{view.sentence}</p>
    {view.state === 'no-gmail-permission' && <Link href={`/agents/${encodeURIComponent(name)}/edit`}>Edit agent →</Link>}
    {view.state === 'no-account' && <GoogleForm fields={{ intent: 'new' }}>
      <label className="lares-field-label" htmlFor="agent-mailbox-email">Google address</label>
      <Input id="agent-mailbox-email" name="email" type="email" required placeholder="name@domain.com" />
      <Button type="submit">Connect Google ↗</Button>
    </GoogleForm>}
    {showSelect && <div className="lares-inline-form">
      <label className="lares-field-label" htmlFor="agent-mailbox-select">Works on</label>
      <Select id="agent-mailbox-select" value={selected} disabled={busy} onChange={event => pick(event.target.value)}>
        <option value={NONE}>None</option>
        {view.options.map(o => <option key={o.resourceBindingId} value={o.resourceBindingId}>{o.address}{o.canDraft ? '' : ' (read only)'}</option>)}
      </Select>
    </div>}
    {view.state === 'paused' && <div className="lares-inline-form">
      {view.confirm && <Button disabled={busy} onClick={() => void send({ operation: 'confirm' })}>Confirm</Button>}
      {view.reconnect && <GoogleForm fields={{ intent: 'reconnect', accountId: view.reconnect.accountId, generation: view.reconnect.generation }}>
        <Button type="submit" variant="outline">Reconnect</Button>
      </GoogleForm>}
      {!choosing && <Button variant="outline" disabled={busy} onClick={() => setChoosing(true)}>{view.confirm ? 'Choose another' : 'Choose again'}</Button>}
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
