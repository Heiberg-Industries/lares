'use client';
// The Notion page's top line and its two steps: 1. Connect (the key), 2. Which agents may use Notion.
// Wording and layout only: every change is the same keeper call as before (credential.test_save,
// test_current, test_pending, discard, apply, disconnect, grant, revoke, through
// /api/credentials/notion; the read-only credential.preview_grant through its preview route). The
// keeper still decides what may happen: a key must pass its check before it can be started, the new
// key is kept apart from the one in use until then, a failed switch puts the previous key back by
// itself, and only the owner may do any of it. The words come from lib/notion-connection.ts.
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  CREDENTIAL_SLOT, credentialGrantPreviewSchema, credentialStatusSchema,
  type CredentialGrantPreview, type CredentialMutation, type CredentialStatus,
} from '@lares/agent-kit/credential-lifecycle';
import type { CredentialView } from '../lib/credentials';
import {
  checkLine, isConnected, isSwitching, listNames, notionUsers, shownName, switchWasUndone, topSentence,
  type NotionAgent,
} from '../lib/notion-connection';
import { useKeepFresh } from '../lib/use-keep-fresh';
import { Notice, Row, Rows } from '@lares/ui/patterns';
import { Button } from '@lares/ui/primitives/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lares/ui/primitives/card';
import { Input } from '@lares/ui/primitives/input';
import { Switch } from '@lares/ui/primitives/switch';

/** Fired after the key or who may use it changed, carrying the new status, so the other parts of the
 *  page (Clipping, People sync) show the same key. */
export const NOTION_KEY_UPDATED = 'lares:notion-key-updated';

const guidance = {
  'configure-administrator': 'Ask whoever runs your server to name one person who may change the Notion key.',
  'prepare-managed-slot': 'This server is not ready to keep a Notion key yet. On the server, run `lares update`, then reload this page. If it still is not ready, Notion is already used outside Lares here: see "Meetings and Notion" in the install guide.',
  'prepare-writable-storage': 'Ask whoever runs your server to prepare the protected place where Lares keeps keys.',
  'review-consumers': 'Something on this server uses the Notion key that Lares does not manage. Ask whoever runs your server to look at it.',
  'inspect-journal': 'A change to the key stopped half-way. Ask whoever runs your server to look at it before you change anything here.',
  'status-unavailable': 'Lares could not read the state of the key. Reload the page.',
} as const;

const messages: Record<string, string> = {
  'sign-in-required': 'Sign in again to connect Notion.',
  'administrator-required': "Only the installation's owner can connect Notion and choose who may use it.",
  'origin-refused': 'This request was refused. Open the console at its usual address.',
  'invalid-request': 'Something about that request was wrong. Reload the page and try again.',
  unavailable: 'Lares cannot read the state of the Notion connection right now. Reload the page in a minute.',
  'unavailable-before-send': 'Lares could not reach its server helper, so nothing was changed. Try again in a minute.',
  'outcome-unknown': 'Lares does not know whether that went through. Reload the page to see where things stand before trying again.',
  'request-refused': 'Lares refused that change. Reload the page to see where things stand.',
  'not-a-notion-agent': 'That agent cannot use Notion.',
};

type Confirm =
  | { kind: 'apply' } | { kind: 'disconnect' }
  | { kind: 'grant'; agent: string; preview: CredentialGrantPreview }
  | { kind: 'revoke'; agent: string };

const SHARE = 'In Notion, open each page or database an agent should use, choose the three dots, then Connections, and add your Lares connection. Agents can only read and write what you share this way.';

export function NotionConnection({ initial, agents, names, children }: {
  initial: CredentialView;
  /** The agents that may be given the key (every chief-of-staff agent that is not retired). */
  agents: NotionAgent[];
  /** Every agent's definition name → its display name, for the restart lists. */
  names: Record<string, string>;
  /** Clipping and People sync: folded below until both steps are done. */
  children?: ReactNode;
}) {
  const [view, setView] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [stale, setStale] = useState(false), [uncertain, setUncertain] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const token = useRef<HTMLInputElement>(null), inFlight = useRef(false);
  const status = view.kind === 'status' ? view.status : null;
  const editable = !!status && !status.guidance && status.state !== 'unavailable' && status.revision !== null && !uncertain && !stale;

  const take = (next: CredentialStatus) => {
    setView({ kind: 'status', status: next }); setStale(false); setUncertain(false);
    window.dispatchEvent(new CustomEvent<CredentialStatus>(NOTION_KEY_UPDATED, { detail: next }));
  };

  async function read(quiet: boolean) {
    if (inFlight.current) return;
    inFlight.current = true; if (!quiet) setBusy(true);
    try {
      const res = await fetch('/api/credentials/notion', { cache: 'no-store', credentials: 'same-origin' });
      const body = await res.json(); const parsed = credentialStatusSchema.safeParse(body.status);
      if (!res.ok || body.ok !== true || !parsed.success) { setMessage(messages[body.code] ?? messages.unavailable!); setStale(true); return; }
      take(parsed.data); setConfirm(null); if (!quiet) setMessage('');
    } catch { setMessage(messages.unavailable!); setStale(true); }
    finally { inFlight.current = false; if (!quiet) setBusy(false); }
  }
  // While the keeper is moving the key, the page asks again every few seconds and stops once it is done.
  useKeepFresh(!!status && isSwitching(status), () => read(true));

  async function submit(command: CredentialMutation) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage(''); setConfirm(null);
    try {
      const res = await fetch('/api/credentials/notion', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
      const body = await res.json(); const parsed = credentialStatusSchema.safeParse(body.status);
      if (!res.ok || body.ok !== true || !parsed.success) {
        const code = typeof body.code === 'string' && messages[body.code] ? body.code : 'outcome-unknown';
        setMessage(messages[code]!); setStale(true); if (code === 'outcome-unknown') setUncertain(true); return;
      }
      take(parsed.data);
    } catch { setMessage(messages['outcome-unknown']!); setUncertain(true); setStale(true); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const simple = (operation: 'test_current' | 'test_pending' | 'discard') => {
    if (status?.revision !== null && status?.revision !== undefined)
      void submit({ operation, slot: CREDENTIAL_SLOT, expectedRevision: status.revision });
  };
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!token.current || !status || status.revision === null || inFlight.current) return;
    const value = token.current.value; token.current.value = '';
    if (!value.trim()) return;
    void submit({ operation: 'test_save', slot: CREDENTIAL_SLOT, expectedRevision: status.revision, token: value });
  }
  async function preview(agent: string) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      const res = await fetch('/api/credentials/notion/preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent }) });
      const body = await res.json(); const parsed = credentialGrantPreviewSchema.safeParse(body.preview);
      if (!res.ok || body.ok !== true || !parsed.success) { setMessage(messages[body.code] ?? messages.unavailable!); return; }
      setConfirm({ kind: 'grant', agent, preview: parsed.data });
    } catch { setMessage(messages.unavailable!); }
    finally { inFlight.current = false; setBusy(false); }
  }
  /** A grant whose agent was deleted mounts nothing, so removing it restarts nothing: no confirmation. */
  function removeStale(agent: string) {
    if (!status || status.revision === null || !status.inventoryRevision || !editable) return;
    void submit({ operation: 'revoke', slot: CREDENTIAL_SLOT, expectedRevision: status.revision, expectedActiveRevision: status.activeRevision,
      confirmRestart: true, inventoryRevision: status.inventoryRevision, agent, purpose: 'clipping' });
  }
  function confirmed() {
    if (!confirm || !status || status.revision === null || !editable) return;
    const base = { slot: CREDENTIAL_SLOT, expectedRevision: status.revision, expectedActiveRevision: status.activeRevision, confirmRestart: true as const };
    if (confirm.kind === 'grant') {
      void submit({ operation: 'grant', ...base, inventoryRevision: confirm.preview.inventoryRevision, agent: confirm.agent, purpose: 'clipping' });
      return;
    }
    if (!status.inventoryRevision) return;
    if (confirm.kind === 'revoke') void submit({ operation: 'revoke', ...base, inventoryRevision: status.inventoryRevision, agent: confirm.agent, purpose: 'clipping' });
    else void submit({ operation: confirm.kind, ...base, inventoryRevision: status.inventoryRevision });
  }

  const canSwitch = editable && !!status?.inventoryRevision && status.consumers.every(c => (c.category === 'owned-agent' && c.incarnation) || c.category === 'managed-service');
  const connected = !!status && isConnected(status);
  // A key is in use: step 2 shows. Its switches wait while a new key is pending or a switch is going,
  // because the keeper changes who may use the key only while exactly one tested key is in use.
  const inUse = !!status && !!status.activeRevision && !status.guidance && status.state !== 'unavailable';
  const users = status ? notionUsers(status) : { granted: [], byConfig: [], stale: [] };
  const done = connected && users.granted.length + users.byConfig.length > 0;
  const top = status ? topSentence(status, names) : messages[view.kind] ?? messages.unavailable!;
  const candidateCheck = status?.candidateRevision && status.test?.revision === status.candidateRevision ? checkLine(status) : null;
  const activeCheck = status?.activeRevision && !status.candidateRevision && status.test?.revision === status.activeRevision ? checkLine(status) : null;
  const restartList = (list: { name: string }[]) => list.length
    ? <p>{listNames(list.map(c => shownName(c.name, names)))} {list.length === 1 ? 'restarts' : 'restart'} for a moment, so a conversation in progress is interrupted.</p>
    : <p>Nothing needs to restart.</p>;

  return <div className="lares-stack">
    <p className="lares-notion-top" role="status" aria-live="polite" data-testid="notion-top">{top}</p>
    {stale && <Notice tone="needs-you">What is shown below may be out of date. Reload the page to see where things stand.</Notice>}
    {status?.guidance && <Notice tone="needs-you">{guidance[status.guidance]}</Notice>}
    {status && switchWasUndone(status) && <Notice tone="needs-you">That did not work, so Lares went back to the previous key.</Notice>}
    {message && <Notice>{message}</Notice>}

    <Card role="region" aria-labelledby="notion-connect-heading">
      <CardHeader>
        <CardTitle id="notion-connect-heading" role="heading" aria-level={2}>1. Connect</CardTitle>
        <CardDescription>Notion is a general connection: agents read and write the pages and databases you share with it.</CardDescription>
      </CardHeader>
      <CardContent className="lares-stack">
        {status && editable && !status.candidateRevision && <form onSubmit={save} className="lares-stack" autoComplete="off">
          <label className="lares-field-label" htmlFor="notion-token">Notion key</label>
          <Input id="notion-token" ref={token} type="password" autoComplete="new-password" required maxLength={8192} disabled={busy} />
          <p className="lares-muted">{status.activeRevision
            ? 'Paste a new key to replace the one in use. The key in use keeps working until you choose Start using this key.'
            : 'Copy the key of your internal connection in Notion (Settings, Connections) and paste it here.'}</p>
          <div className="lares-inline-form"><Button disabled={busy} type="submit">Save and check</Button></div>
        </form>}
        {candidateCheck && <p data-testid="notion-check">New key: {candidateCheck}</p>}
        {activeCheck && <p data-testid="notion-check">{activeCheck}</p>}
        {(candidateCheck || activeCheck) && <p className="lares-muted">The check shows the key is valid. It does not show which pages the connection can read.</p>}
        {status && editable && status.candidateRevision && <div className="lares-inline-form">
          {status.state === 'pending-apply'
            ? <Button disabled={busy || !canSwitch} onClick={() => setConfirm({ kind: 'apply' })}>Start using this key</Button>
            : <Button variant="outline" disabled={busy} onClick={() => simple('test_pending')}>Check again</Button>}
          <Button variant="outline" disabled={busy} onClick={() => simple('discard')}>Remove this new key</Button>
        </div>}
        {status && editable && status.activeRevision && !status.candidateRevision && <div className="lares-stack">
          <div className="lares-inline-form">
            <Button variant="outline" disabled={busy} onClick={() => simple('test_current')}>Check the key again</Button>
            <Button variant="outline" disabled={busy || !canSwitch} onClick={() => setConfirm({ kind: 'disconnect' })}>Stop using Notion in Lares</Button>
          </div>
          <p className="lares-muted">Stopping takes the key out of Lares. The key still works in Notion until you delete the connection there.</p>
        </div>}
        {status && editable && !status.inventoryRevision && (status.activeRevision || status.candidateRevision) &&
          <p className="lares-muted">Reload the page so Lares knows what would restart, before you start or stop a key.</p>}
        {(confirm?.kind === 'apply' || confirm?.kind === 'disconnect') && status && <div className="lares-stack" role="group" aria-label="Confirm">
          <p>{confirm.kind === 'apply' ? 'Start using the new key?' : 'Stop using Notion in Lares?'}</p>
          {restartList(status.consumers)}
          <div className="lares-inline-form">
            <Button disabled={busy || !editable} onClick={confirmed}>{confirm.kind === 'apply' ? 'Yes, start using it' : 'Yes, stop using Notion'}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        </div>}
        <p className="lares-muted">{SHARE}</p>
      </CardContent>
    </Card>

    {inUse && <Card role="region" aria-labelledby="notion-agents-heading">
      <CardHeader>
        <CardTitle id="notion-agents-heading" role="heading" aria-level={2}>2. Which agents may use Notion</CardTitle>
        <CardDescription>An agent you switch on gets the Notion key: it reads your meeting notes, clips and anything else you shared with the connection. Switching restarts that agent for a moment. Only a chief of staff can use Notion.</CardDescription>
      </CardHeader>
      <CardContent className="lares-stack">
        {!connected && <p className="lares-muted">Start using the new key, or remove it, before you change who may use Notion.</p>}
        {agents.length === 0 && users.byConfig.length === 0 && <p>There is no chief-of-staff agent yet, so there is nobody to switch on.</p>}
        {(agents.length > 0 || users.byConfig.length > 0) && <Rows label="Agents that may use Notion">
          {agents.map(a => {
            const on = users.granted.includes(a.name), configured = users.byConfig.includes(a.name);
            return <Row key={a.name} title={a.displayName}
              description={configured ? "Uses Notion through this installation's own settings, so there is no switch here." : on ? 'May use Notion.' : 'May not use Notion.'}
              control={configured ? undefined : <Switch aria-label={`${a.displayName} may use Notion`} checked={on}
                disabled={busy || !editable || !connected || (on && !status?.inventoryRevision)}
                onCheckedChange={(next) => { if (next) void preview(a.name); else setConfirm({ kind: 'revoke', agent: a.name }); }} />} />;
          })}
          {users.byConfig.filter(n => !agents.some(a => a.name === n)).map(n =>
            <Row key={n} title={shownName(n, names)} description="Uses Notion through this installation's own settings, so there is no switch here." />)}
        </Rows>}
        {(confirm?.kind === 'grant' || confirm?.kind === 'revoke') && status && <div className="lares-stack" role="group" aria-label="Confirm">
          <p>{confirm.kind === 'grant' ? `Let ${shownName(confirm.agent, names)} use Notion?` : `Stop ${shownName(confirm.agent, names)} from using Notion?`}</p>
          {restartList(confirm.kind === 'grant' ? confirm.preview.consumers : status.consumers)}
          <div className="lares-inline-form">
            <Button disabled={busy || !editable} onClick={confirmed}>{confirm.kind === 'grant' ? 'Yes, switch it on' : 'Yes, switch it off'}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        </div>}
        {users.stale.map(name => <div key={name} className="lares-inline-form">
          <p>{shownName(name, names)} was switched on but no longer exists. Nothing restarts when you remove it.</p>
          <Button variant="outline" disabled={busy || !editable || !status?.inventoryRevision} onClick={() => removeStale(name)}>Remove</Button>
        </div>)}
      </CardContent>
    </Card>}

    {children && <details className="lares-stack" open={done} data-testid="notion-more">
      <summary>Clipping and People sync</summary>
      {children}
    </details>}

    <div className="lares-actions"><Button variant="outline" disabled={busy} onClick={() => void read(false)}>Reload status</Button></div>
  </div>;
}
