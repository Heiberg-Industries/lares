'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@lares/ui/primitives/button';
import { Input } from '@lares/ui/primitives/input';
import { Check, ChevronDown, ArrowUpRight } from '@lares/ui/icons';
import { Field } from '@lares/ui/patterns';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@lares/ui/primitives/dialog';
import * as Menu from '@lares/ui/primitives/dropdown-menu';
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
  async function send(body: object) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await fetch('/api/agent-mailbox', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ...body }) });
      const json = await result.json();
      if (!result.ok || json.ok !== true || !json.view) { setMessage(typeof json.message === 'string' ? json.message : OUTCOME_UNKNOWN); return; }
      setView(json.view as AgentMailboxViewDTO);
    } catch { setMessage(OUTCOME_UNKNOWN); }
    finally { setBusy(false); }
  }
  function pick(value: string) {
    if (value === NONE) return void send({ operation: 'clear' });
    const option = view.options.find(o => o.resourceBindingId === value);
    if (option) void send({ operation: 'choose', accountId: option.accountId, resourceBindingId: option.resourceBindingId });
  }
  const selected = view.state === 'working' ? view.chosen?.resourceBindingId ?? NONE : NONE;
  const chooser = (label: string, variant: 'default' | 'outline' = 'outline') => <Menu.Root>
    <Menu.Trigger asChild><Button variant={variant} disabled={busy}>{label} <ChevronDown aria-hidden="true" /></Button></Menu.Trigger>
    <Menu.Content aria-label="Works on">
      <Menu.Label>Works on</Menu.Label>
      <Menu.Item onSelect={() => pick(NONE)}>None{selected === NONE && <Check aria-hidden="true" />}</Menu.Item>
      {view.options.map(o => <Menu.Item key={o.resourceBindingId} onSelect={() => pick(o.resourceBindingId)}>
        {o.address}{o.canDraft ? '' : ' (read only)'}{selected === o.resourceBindingId && <Check aria-hidden="true" />}</Menu.Item>)}
    </Menu.Content>
  </Menu.Root>;
  const canChoose = view.options.length > 0;
  const workingLabel = view.state === 'working' && view.chosen ? `Works on ${view.chosen.address}` : 'Choose a mailbox';
  return <section className="lares-service-list" aria-labelledby="agent-mailbox-heading"><div className="lares-service-row">
    <div className="lares-service-text">
      <h2 id="agent-mailbox-heading" className="lares-service-name">{view.title}</h2>
      <p className="lares-service-line">{view.sentence}</p>
      {message && <p role="status" className="lares-service-line">{message}</p>}
    </div>
    {view.state === 'no-gmail-permission' && <Link href={`/agents/${encodeURIComponent(name)}/edit`}>Edit agent →</Link>}
    {view.state === 'no-account' && <Dialog>
      <DialogTrigger asChild><Button>Connect Google <ArrowUpRight aria-hidden="true" /></Button></DialogTrigger>
      <DialogContent>
        <DialogTitle>Connect Google</DialogTitle>
        <DialogDescription>You will go to Google to say yes, then come back here.</DialogDescription>
        <GoogleForm fields={{ intent: 'new' }}>
          <Field label="Google address"><Input name="email" type="email" required placeholder="name@example.com" /></Field>
          <Button type="submit">Continue</Button>
        </GoogleForm>
      </DialogContent>
    </Dialog>}
    {canChoose && (view.state === 'choose' || view.state === 'working') && chooser(workingLabel)}
    {view.state === 'paused' && <>
      {view.confirm && <Button disabled={busy} onClick={() => void send({ operation: 'confirm' })}>Confirm</Button>}
      {view.reconnect && <GoogleForm fields={{ intent: 'reconnect', accountId: view.reconnect.accountId, generation: view.reconnect.generation }}>
        <Button type="submit" variant="outline">Reconnect</Button>
      </GoogleForm>}
      {chooser(view.confirm ? 'Choose another' : 'Choose again')}
    </>}
  </div></section>;
}
