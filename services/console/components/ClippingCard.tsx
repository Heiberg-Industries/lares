'use client';
import { useEffect, useRef, useState } from 'react';
import {
  CREDENTIAL_SLOT, credentialStatusSchema, type CredentialGrantPreview, type CredentialMutation, type CredentialStatus,
} from '@lares/agent-kit/credential-lifecycle';
import type {
  ClippingAddPropertiesResult, ClippingImportResult, ClippingMode, ClippingSchemaResult, ClippingTestResult,
} from '@lares/agent-kit/clipping-console';
import type { CredentialView } from '../lib/credentials';
import type {
  ClippingOutcome, ClippingRequestKind, ClippingRequestView, ClippingSourceView, ClippingView,
} from '../lib/clipping';
import { Button } from '@lares/ui/primitives/button';
import { Input } from '@lares/ui/primitives/input';
import { NOTION_CREDENTIAL_CHANGED } from './NotionCredential';

const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'never');

const MODE_LABEL: Record<ClippingMode, string> = { notion: 'Notion', karakeep: 'Karakeep', both: 'Both (changeover)' };

/** One short label per outcome. The engine's own sentence (the `detail`) follows it when there is one. */
const OUTCOME_LABEL: Record<ClippingOutcome, string> = {
  ok: 'Working',
  'not-configured': 'Not set up yet',
  'unsupported-source': 'Not read: only one shared Notion source is supported',
  refused: 'Notion refused the key',
  'not-shared': 'Not shared with your Lares connection',
  'schema-mismatch': 'The database no longer fits',
  'rate-limited': 'Notion is limiting requests',
  unavailable: 'Notion could not be reached',
  timeout: 'Notion did not answer in time',
  incomplete: "Notion's answer was incomplete",
  'key-unreadable': 'The Notion key could not be read',
  'local-error': 'Lares could not read its own records',
};
const FIX: Partial<Record<ClippingOutcome, string>> = {
  refused: 'Check the Notion key above.',
  'not-shared': 'In Notion, open the database, choose the three dots, then Connections, and add your Lares connection.',
  'schema-mismatch': 'Read the database again and pick the columns again.',
};

const failureText = (outcome: ClippingOutcome | null, detail: string | null): string => {
  const label = outcome ? OUTCOME_LABEL[outcome] : 'Failed';
  const fix = outcome ? FIX[outcome] : undefined;
  return [detail && detail !== label ? `${label}. ${detail}` : `${label}.`, fix].filter(Boolean).join(' ');
};

const messages: Record<string, string> = {
  'sign-in-required': 'Sign in again before changing clipping.',
  'origin-refused': 'This request was refused. Open the console at its configured address.',
  'invalid-request': 'The request was invalid. Reload the page and try again.',
  busy: 'The last request of this kind is still waiting. Give the chief of staff a minute.',
  'no-source': 'Save the columns first.',
  'no-schema': 'Read the database first, then pick its columns.',
  'mapping-mismatch': 'Those columns do not match what the chief of staff last read. Read the database again.',
  'more-than-one-source': 'More than one Notion source is set up on this installation. Only one is supported for now; ask the host operator.',
  'chief-of-staff-not-found': 'There is not exactly one chief of staff to switch on.',
  'request-refused': 'The keeper refused this request. Check the Notion key above, then try again.',
  'unavailable-before-send': 'The keeper could not be reached. Nothing was changed.',
  'outcome-unknown': 'The result is unknown: the request may have run. Check the Notion key card above before trying again.',
  administrator: "Only the installation's credential administrator can switch this.",
  unavailable: 'Clipping status unavailable.',
  'administrator-required': "Only the installation's credential administrator can switch this.",
};

const isSchema = (r: ClippingRequestView['result']): r is ClippingSchemaResult => !!r && 'dataSources' in r;
const isTest = (r: ClippingRequestView['result']): r is ClippingTestResult => !!r && 'wouldImport' in r;
const isImport = (r: ClippingRequestView['result']): r is ClippingImportResult => !!r && 'imported' in r && !('wouldImport' in r);
const isAdd = (r: ClippingRequestView['result']): r is ClippingAddPropertiesResult => !!r && 'conflicts' in r;

/** The wait/failed lines every request kind shares; null when the request finished well. */
function requestWait(req: ClippingRequestView | undefined, what: string): string | null {
  if (!req) return null;
  if (req.status === 'pending') return `${what} (the chief of staff picks this up within a minute).`;
  if (req.status === 'claimed') return `${what} (the chief of staff is working on it).`;
  if (req.status === 'unavailable') return req.detail ?? 'The chief of staff did not pick this up.';
  if (req.status === 'failed') return failureText(req.outcome, req.detail);
  return null;
}

export function testSentence(r: ClippingTestResult): string {
  const lead = r.wouldImport === 0
    ? 'Would import nothing new.'
    : `Would import ${r.wouldImport} link${r.wouldImport === 1 ? '' : 's'} (${r.fromUrlColumn} from the URL column, ${r.fromTitle} from the title).`;
  const extra = [
    r.withoutLink > 0 ? `${r.withoutLink} row${r.withoutLink === 1 ? ' has' : 's have'} no link and would be skipped.` : '',
    r.alreadyImported > 0 ? `${r.alreadyImported} already imported.` : '',
    r.more ? 'There are more rows than this test read.' : '',
    r.recent && r.recent.checked > 0
      ? `Of the ${r.recent.checked} most recently edited row${r.recent.checked === 1 ? '' : 's'}: ${r.recent.fromUrlColumn} with the link in the URL column, ${r.recent.fromTitle} with the link only in the title, ${r.recent.withoutLink} without a link.`
      : '',
    ...(r.warnings ?? []),
  ].filter(Boolean);
  return [lead, ...extra].join(' ');
}

function sourceSentence(s: ClippingSourceView | null, count: number): string {
  if (count > 1) return 'More than one Notion source is set up. Only one is supported for now, so none is read.';
  if (!s) return 'No clipping source is saved yet.';
  if (!s.outcome) return `Not fetched yet. ${s.detail ?? ''}`.trim();
  const total = `Imported ${s.importedTotal} in total.`;
  if (s.outcome === 'ok') {
    const c = s.lastCounts;
    const last = typeof c['imported'] === 'number'
      ? ` Last pass: ${c['imported']} imported, ${c['updated'] ?? 0} updated, ${c['trashed'] ?? 0} removed, ${c['noLink'] ?? 0} without a link.` : '';
    return `Last fetch: ok at ${when(s.lastAttemptAt)}.${last} ${total}${s.detail ? ` ${s.detail}` : ''}`;
  }
  if (s.outcome === 'not-configured') return `Not fetched yet. ${s.detail ?? ''} ${total}`.replace(/\s+/g, ' ').trim();
  return `Last fetch failed at ${when(s.lastAttemptAt)}. ${failureText(s.outcome, s.detail)} Last good fetch: ${when(s.lastSuccessAt)}. ${total}`;
}

type Flow = { kind: 'on'; preview: CredentialGrantPreview } | { kind: 'off' } | null;

export function ClippingCard({ initial, credential }: { initial: ClippingView; credential: CredentialView }) {
  const [view, setView] = useState<ClippingView>(initial);
  const [cred, setCred] = useState<CredentialView>(credential);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [credMessage, setCredMessage] = useState('');
  const [link, setLink] = useState('');
  const [flow, setFlow] = useState<Flow>(null), [confirmed, setConfirmed] = useState(false);
  const inFlight = useRef(false);

  const live = view.unavailable ? null : view;
  const status: CredentialStatus | null = cred.kind === 'status' ? cred.status : null;

  // ---- polling: every 5 s while a request is waiting, then stop --------------------------------
  const polling = !!live?.busy;
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => { void poll(); }, 5000);
    return () => clearTimeout(timer);
  // `view` changes on every poll answer, which re-arms (or ends) the loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, view]);
  async function poll() {
    try {
      const res = await fetch('/api/clipping', { cache: 'no-store', credentials: 'same-origin' });
      const body = await res.json();
      setView(res.ok && body.ok === true && typeof body.view?.unavailable === 'boolean' ? body.view : { unavailable: true });
    } catch { setView({ unavailable: true }); }
  }

  // ---- the console's own actions ----------------------------------------------------------------
  async function act(action: Record<string, unknown>, okMessage = ''): Promise<unknown> {
    if (inFlight.current) return null;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      const res = await fetch('/api/clipping', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action),
      });
      const body = await res.json();
      if (!res.ok || body.ok !== true) { setMessage(messages[body.code as string] ?? messages.unavailable!); return null; }
      if (body.view && typeof body.view.unavailable === 'boolean') setView(body.view);
      setMessage(okMessage);
      return body;
    } catch { setMessage(messages.unavailable!); return null; }
    finally { inFlight.current = false; setBusy(false); }
  }

  // ---- the keeper switch (existing credentials route) --------------------------------------------
  async function credentialCall(command: CredentialMutation): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setCredMessage(''); setFlow(null); setConfirmed(false);
    try {
      const res = await fetch('/api/credentials/notion', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
      });
      const body = await res.json(); const parsed = credentialStatusSchema.safeParse(body.status);
      if (!res.ok || body.ok !== true || !parsed.success) {
        const code = typeof body.code === 'string' && messages[body.code] ? body.code : 'outcome-unknown';
        setCredMessage(messages[code]!); return false;
      }
      setCred({ kind: 'status', status: parsed.data });
      setCredMessage('Operation recorded. Review the result below.');
      // The Notion key card above holds its own copy of this status; tell it to read it again.
      window.dispatchEvent(new Event(NOTION_CREDENTIAL_CHANGED));
      return true;
    } catch { setCredMessage(messages['outcome-unknown']!); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function recheckCredential() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const res = await fetch('/api/credentials/notion', { cache: 'no-store', credentials: 'same-origin' });
      const body = await res.json(); const parsed = credentialStatusSchema.safeParse(body.status);
      if (res.ok && body.ok === true && parsed.success) { setCred({ kind: 'status', status: parsed.data }); setCredMessage('Credential status refreshed.'); }
      else setCredMessage(messages[body.code as string] ?? 'Credential status unavailable.');
    } catch { setCredMessage('Credential status unavailable.'); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const agent = live?.chiefOfStaff.kind === 'one' ? live.chiefOfStaff.name : null;
  const grants = status?.grants ?? [];
  const granted = !!agent && grants.some((g) => g.agent === agent && !g.stale);
  const byConfig = !!agent && !granted && !!status?.consumers.some((c) => c.name === agent && c.category === 'owned-agent');
  const staleGrants = grants.filter((g) => g.stale);
  const grantCommand = (operation: 'grant' | 'revoke', name: string, inventoryRevision: string): CredentialMutation | null => {
    if (!status || status.revision === null) return null;
    return {
      operation, slot: CREDENTIAL_SLOT, expectedRevision: status.revision, expectedActiveRevision: status.activeRevision,
      inventoryRevision, confirmRestart: true, agent: name, purpose: 'clipping',
    };
  };
  async function startOn() {
    const body = await act({ action: 'preview-grant' }) as { preview?: CredentialGrantPreview } | null;
    if (body?.preview) { setFlow({ kind: 'on', preview: body.preview }); setConfirmed(false); }
  }
  function confirmSwitch() {
    if (!flow || !confirmed || !agent) return;
    const command = flow.kind === 'on'
      ? grantCommand('grant', agent, flow.preview.inventoryRevision)
      : status?.inventoryRevision ? grantCommand('revoke', agent, status.inventoryRevision) : null;
    if (command) void credentialCall(command);
  }
  function removeStale(name: string) {
    if (!status?.inventoryRevision) return;
    const command = grantCommand('revoke', name, status.inventoryRevision);
    if (command) void credentialCall(command);
  }

  // ---- what to show ------------------------------------------------------------------------------
  const source = live?.source ?? null;
  const req = (k: ClippingRequestKind) => live?.requests[k];
  const schemaReq = req('schema');
  const schema = schemaReq?.status === 'done' && isSchema(schemaReq.result) ? schemaReq.result : null;

  const keyLine = !status ? 'Notion key: status unavailable.'
    : status.state === 'unavailable' ? 'Notion key: status unavailable.'
    : !status.activeRevision ? 'Notion key: not saved. Add it under Notion key above.'
    : status.test?.revision === status.activeRevision && status.test.outcome === 'passed' ? 'Notion key: working.'
    : 'Notion key: saved.';

  return <section className="lares-surface lares-surface-compact lares-stack" aria-labelledby="clipping-heading">
    <h2 id="clipping-heading" className="lares-section-title">Clipping</h2>
    <p className="lares-muted">Links you save in a Notion database are brought into the inbox, and the digest files them. Only links are copied, never the pages.</p>
    {!live ? <p role="status">{messages.unavailable}</p> : <>
      <SourceChoice live={live} busy={busy} onChoose={(mode) => void act({ action: 'set-choice', mode })} />
      <p>{keyLine}</p>

      <h3>Database</h3>
      <MappingPicker key={`${schemaReq?.id ?? 'none'}:${source?.dataSourceId ?? ''}`} schema={schema} source={source} busy={busy}
        link={link} setLink={setLink} wait={requestWait(schemaReq, 'Reading the database…')}
        onRead={() => void act({ action: 'read-database', link })}
        onSave={(m) => void act({ action: 'save-mapping', ...m }, 'Columns saved.')} />

      <h3>Optional columns</h3>
      <p className="lares-muted">Adds Status, For and Origin to your Notion database, only where they are missing. Existing columns are never changed.</p>
      <div className="lares-inline-form"><Button variant="outline" disabled={busy || !source} onClick={() => void act({ action: 'add-properties' })}>Add Status, For and Origin columns</Button></div>
      <RequestResult req={req('add-properties')} wait="Adding the columns…"
        done={(r) => isAdd(r) ? addSentence(r) : null} />

      <h3>Test</h3>
      <p className="lares-muted">Reads one page of rows and shows what would be imported. Writes nothing.</p>
      <div className="lares-inline-form"><Button variant="outline" disabled={busy || !source} onClick={() => void act({ action: 'test' })}>Test</Button></div>
      <RequestResult req={req('test')} wait="Testing…"
        done={(r) => isTest(r) ? testSentence(r) : null} />

      <h3>Switch</h3>
      <SwitchBlock status={status} credKind={cred.kind} live={live} agent={agent} granted={granted} byConfig={byConfig}
        busy={busy} flow={flow} confirmed={confirmed} setConfirmed={setConfirmed}
        onOn={() => void startOn()} onOff={() => { setFlow({ kind: 'off' }); setConfirmed(false); }}
        onCancel={() => { setFlow(null); setConfirmed(false); }} onConfirm={confirmSwitch}
        stale={staleGrants} onRemove={removeStale} onRecheck={() => void recheckCredential()} />
      {credMessage && <p role="status">{credMessage}</p>}

      <h3>Import</h3>
      <div className="lares-inline-form"><Button disabled={busy || !source} onClick={() => void act({ action: 'import' })}>Import now</Button></div>
      <RequestResult req={req('import')} wait="Importing…"
        done={(r, q) => isImport(r) ? `Imported ${r.imported} at ${when(q.finishedAt)}.` : null} />

      <h3>Last fetch</h3>
      <p>{sourceSentence(source, live.sourceCount)}</p>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}

function addSentence(r: ClippingAddPropertiesResult): string {
  const parts = [
    r.added.length ? `Added ${r.added.join(', ')}.` : 'Nothing to add.',
    r.present.length ? `Already there: ${r.present.join(', ')}.` : '',
    ...r.conflicts.map((c) => `${c.name} already exists as a ${c.found.replaceAll('_', '-')} column, so Lares left it alone.`),
  ];
  return parts.filter(Boolean).join(' ');
}

function RequestResult({ req, wait, done }: {
  req: ClippingRequestView | undefined; wait: string;
  done: (result: ClippingRequestView['result'], req: ClippingRequestView) => string | null;
}) {
  if (!req) return null;
  const line = requestWait(req, wait) ?? (req.status === 'done'
    ? (req.result ? done(req.result, req) : null) ?? 'The answer could not be read.' : null);
  return line ? <p role="status">{line}</p> : null;
}

function SourceChoice({ live, busy, onChoose }: {
  live: Extract<ClippingView, { unavailable: false }>; busy: boolean; onChoose: (m: ClippingMode) => void;
}) {
  const mode = live.choice?.mode ?? null;
  return <div className="lares-stack" role="group" aria-label="Clipping source">
    <p>Source: {mode ? MODE_LABEL[mode] : 'not chosen yet (every source that is set up runs)'}.</p>
    <div className="lares-inline-form">
      {(Object.keys(MODE_LABEL) as ClippingMode[]).map((m) =>
        <Button key={m} variant={m === mode ? 'default' : 'outline'} disabled={busy || m === mode} aria-pressed={m === mode} onClick={() => onChoose(m)}>{MODE_LABEL[m]}</Button>)}
    </div>
    {mode === 'karakeep' && <p className="lares-muted">Notion links are not imported while the source is Karakeep only.</p>}
    {mode === 'notion' && <p className="lares-muted">Karakeep bookmarks are not imported while the source is Notion only. Nothing in Karakeep is deleted.</p>}
  </div>;
}

function MappingPicker({ schema, source, busy, link, setLink, wait, onRead, onSave }: {
  schema: ClippingSchemaResult | null; source: ClippingSourceView | null; busy: boolean;
  link: string; setLink: (v: string) => void; wait: string | null;
  onRead: () => void;
  onSave: (m: { dataSourceId: string; urlPropertyId: string; notePropertyId: string | null; tagsPropertyId: string | null; savedPropertyId: string | null }) => void;
}) {
  const initialDs = schema?.dataSources.find((d) => d.id === source?.dataSourceId) ?? schema?.dataSources[0] ?? null;
  const [dsId, setDsId] = useState(initialDs?.id ?? '');
  const ds = schema?.dataSources.find((d) => d.id === dsId) ?? null;
  const same = !!source && source.dataSourceId === ds?.id;
  const [url, setUrl] = useState(same ? source!.urlPropertyId : schema?.suggested.urlId ?? '');
  const [note, setNote] = useState(same ? source!.notePropertyId ?? '' : '');
  const [tags, setTags] = useState(same ? source!.tagsPropertyId ?? '' : '');
  const [saved, setSaved] = useState(same ? source!.savedPropertyId ?? '' : '');
  const cols = (types: string[]) => (ds?.columns ?? []).filter((c) => types.includes(c.type));
  const nameOf = (id: string | null) => (id ? ds?.columns.find((c) => c.id === id)?.name ?? null : null);
  const pick = (label: string, value: string, set: (v: string) => void, types: string[], optional: boolean) =>
    <label className="lares-field-label">{label}
      <select className="lares-field" value={value} disabled={busy} onChange={(e) => set(e.target.value)}>
        {optional ? <option value="">None</option> : <option value="">Choose a column</option>}
        {cols(types).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>;
  return <div className="lares-stack">
    {source && <p>Saved columns: URL is {nameOf(source.urlPropertyId) ?? 'a column you picked earlier'}.</p>}
    <label className="lares-field-label" htmlFor="clipping-link">Paste a Notion database link</label>
    <div className="lares-inline-form">
      <Input id="clipping-link" value={link} maxLength={2048} disabled={busy} onChange={(e) => setLink(e.target.value)} autoComplete="off" />
      <Button variant="outline" disabled={busy || link.trim() === ''} onClick={onRead}>Read database</Button>
    </div>
    {wait && <p role="status">{wait}</p>}
    {schema && <div className="lares-stack">
      {schema.dataSources.length > 1 && <label className="lares-field-label">Data source
        <select className="lares-field" value={dsId} disabled={busy} onChange={(e) => { setDsId(e.target.value); setUrl(''); setNote(''); setTags(''); setSaved(''); }}>
          {schema.dataSources.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select></label>}
      <p>{ds ? `Found “${ds.name}” with ${ds.columns.length} columns.` : 'No data source chosen.'}</p>
      {ds && <>
        {pick('URL column', url, setUrl, ['url'], false)}
        {cols(['url']).length === 0 && <p className="lares-muted">This database has no URL column. Add one in Notion, then read the database again.</p>}
        {pick('Note column (optional)', note, setNote, ['rich_text'], true)}
        {pick('Tags column (optional)', tags, setTags, ['select', 'multi_select'], true)}
        {pick('Saved-at column (optional)', saved, setSaved, ['date', 'created_time'], true)}
        <div className="lares-inline-form">
          <Button disabled={busy || !url} onClick={() => onSave({ dataSourceId: ds.id, urlPropertyId: url, notePropertyId: note || null, tagsPropertyId: tags || null, savedPropertyId: saved || null })}>Save columns</Button>
        </div>
        {source && source.dataSourceId !== ds.id && <p className="lares-muted">This is a different database from the saved one. Saving starts the import afresh from now; links saved earlier are not imported.</p>}
        {!source && <p className="lares-muted">Saving starts from now: links saved before this are not imported.</p>}
      </>}
    </div>}
  </div>;
}

function SwitchBlock(p: {
  status: CredentialStatus | null; credKind: CredentialView['kind']; live: Extract<ClippingView, { unavailable: false }>;
  agent: string | null; granted: boolean; byConfig: boolean; busy: boolean; flow: Flow; confirmed: boolean;
  setConfirmed: (v: boolean) => void; onOn: () => void; onOff: () => void; onCancel: () => void; onConfirm: () => void;
  stale: { agent: string }[]; onRemove: (name: string) => void; onRecheck: () => void;
}) {
  const { status } = p;
  if (!status) {
    return <p role="status">{p.credKind === 'administrator-required' ? messages.administrator
      : p.credKind === 'sign-in-required' ? 'Sign in again before changing clipping.' : 'Credential status unavailable.'}</p>;
  }
  if (status.state === 'unavailable') return <p role="status">Credential status unavailable.</p>;
  if (!status.activeRevision) return <p role="status">No Notion key is saved yet. Add it under Notion key above.</p>;
  const chief = p.live.chiefOfStaff;
  const consumers = p.flow?.kind === 'on' ? p.flow.preview.consumers : status.consumers;
  return <div className="lares-stack">
    {chief.kind === 'none' && <p role="status">No chief of staff is set up, so there is nothing to switch on.</p>}
    {chief.kind === 'several' && <p role="status">More than one chief of staff is set up, so Lares cannot tell which one should read Notion. Ask the host operator.</p>}
    {p.agent && (p.granted
      ? <p>Clipping is switched on: the chief of staff receives the Notion key.</p>
      : p.byConfig
        ? <p>The chief of staff already receives the Notion key through this installation&apos;s own configuration, so there is no switch.</p>
        : <p>Clipping is switched off: the chief of staff does not receive the Notion key yet.</p>)}
    {p.agent && !p.byConfig && !p.flow && <div className="lares-inline-form">
      {p.granted
        ? <Button variant="outline" disabled={p.busy || !status.inventoryRevision} onClick={p.onOff}>Switch clipping off</Button>
        : <Button disabled={p.busy} onClick={p.onOn}>Switch clipping on</Button>}
      <Button variant="outline" disabled={p.busy} onClick={p.onRecheck}>Check credential status</Button>
    </div>}
    {p.agent && p.granted && !status.inventoryRevision && <p className="lares-muted">Check credential status to confirm the affected agents before switching off.</p>}
    {p.flow && <div className="lares-stack" role="group" aria-label="Confirm clipping switch">
      <p>{p.flow.kind === 'on' ? 'Switch clipping on' : 'Switch clipping off'} and restart every affected agent:</p>
      {consumers.length ? <ul>{consumers.map((c) => <li key={c.name}>{c.name}</li>)}</ul> : <p>No affected agents are recorded.</p>}
      <p className="lares-muted">Agents will stop and restart. This does not guarantee that current work has finished.</p>
      <label><input type="checkbox" checked={p.confirmed} onChange={(e) => p.setConfirmed(e.target.checked)} /> I confirm the complete list and these restarts.</label>
      <div className="lares-inline-form">
        <Button disabled={p.busy || !p.confirmed} onClick={p.onConfirm}>Confirm switch {p.flow.kind === 'on' ? 'on' : 'off'}</Button>
        <Button variant="outline" disabled={p.busy} onClick={p.onCancel}>Cancel</Button>
      </div>
    </div>}
    {p.stale.map((g) => <div key={g.agent} className="lares-inline-form">
      <p>The agent {g.agent} was switched on but no longer exists. Nothing restarts when you remove it.</p>
      <Button variant="outline" disabled={p.busy || !status.inventoryRevision} onClick={() => p.onRemove(g.agent)}>Remove</Button>
    </div>)}
  </div>;
}
