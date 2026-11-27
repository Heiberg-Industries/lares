'use client';
import { Select } from "@lares/ui/primitives/select";
import { useEffect, useRef, useState } from 'react';
import { credentialStatusSchema, type CredentialStatus } from '@lares/agent-kit/credential-lifecycle';
import type {
  ClippingAddPropertiesResult, ClippingImportResult, ClippingMode, ClippingSchemaResult, ClippingTestResult,
} from '@lares/agent-kit/clipping-console';
import type { CredentialView } from '../lib/credentials';
import type {
  ClippingOutcome, ClippingRequestKind, ClippingRequestView, ClippingSourceView, ClippingView,
} from '../lib/clipping';
import { Notice, RunStatus, type RunStatusProps } from '@lares/ui/patterns';
import { Button } from '@lares/ui/primitives/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lares/ui/primitives/card';
import { Input } from '@lares/ui/primitives/input';
import { NOTION_KEY_UPDATED } from './NotionConnection';
import { useKeepFresh } from '../lib/use-keep-fresh';

const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'never');
const at = (iso: string | null) => (iso ? `on ${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC` : undefined);

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
  refused: 'Check the Notion key under 1. Connect.',
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
  unavailable: 'Clipping status unavailable.',
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

/** Where clipping is, for the status line at the top of the card. Pure. */
export function clippingRunStatus(live: Extract<ClippingView, { unavailable: false }>): RunStatusProps {
  const waiting = CARD_KINDS.map((k) => live.requests[k]).find((r) => r?.status === 'pending' || r?.status === 'claimed');
  if (waiting) return waiting.status === 'claimed'
    ? { state: 'running', why: 'The chief of staff is working on your request.' }
    : { state: 'requested', why: 'The chief of staff picks this up within a minute.' };
  if (live.sourceCount > 1) return { state: 'skipped', why: 'More than one Notion source is set up, so none is read.' };
  const s = live.source;
  if (!s) return { state: 'skipped', why: 'No database is chosen yet. Paste its link under Database.' };
  if (!s.outcome) return { state: 'waiting', why: 'Not fetched yet. The next digest, or Import now, fetches it.' };
  if (s.outcome === 'ok') {
    const c = s.lastCounts;
    return { state: 'finished', when: at(s.lastAttemptAt), why: typeof c['imported'] === 'number' ? `Last fetch brought in ${c['imported']} new link${c['imported'] === 1 ? '' : 's'}.` : undefined };
  }
  if (s.outcome === 'not-configured') return { state: 'skipped', when: at(s.lastAttemptAt), why: s.detail ?? OUTCOME_LABEL['not-configured'] };
  return { state: 'failed', when: at(s.lastAttemptAt), why: failureText(s.outcome, s.detail) };
}
const CARD_KINDS: ClippingRequestKind[] = ['schema', 'test', 'import', 'add-properties'];

export function ClippingCard({ initial, credential }: { initial: ClippingView; credential: CredentialView }) {
  const [view, setView] = useState<ClippingView>(initial);
  const [cred, setCred] = useState<CredentialView>(credential);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const inFlight = useRef(false);

  const live = view.unavailable ? null : view;
  const status: CredentialStatus | null = cred.kind === 'status' ? cred.status : null;

  // The Notion key or who may use it changed on the same page: take the status it got back.
  useEffect(() => {
    const onKey = (event: Event) => {
      const parsed = credentialStatusSchema.safeParse((event as CustomEvent).detail);
      if (parsed.success) setCred({ kind: 'status', status: parsed.data });
    };
    window.addEventListener(NOTION_KEY_UPDATED, onKey);
    return () => window.removeEventListener(NOTION_KEY_UPDATED, onKey);
  }, []);

  // ---- polling: every 5 s while a request is waiting, then stop --------------------------------
  useKeepFresh(!!live?.busy, poll);
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

  // ---- what to show ------------------------------------------------------------------------------
  const source = live?.source ?? null;
  const req = (k: ClippingRequestKind) => live?.requests[k];
  const schemaReq = req('schema');
  const schema = schemaReq?.status === 'done' && isSchema(schemaReq.result) ? schemaReq.result : null;
  const agent = live?.chiefOfStaff.kind === 'one' ? live.chiefOfStaff.name : null;

  const keyLine = !status || status.state === 'unavailable' ? 'Notion key: status unavailable.'
    : !status.activeRevision ? 'Notion is not connected yet. Connect it under 1. Connect.'
    : agent && (status.grants ?? []).some((g) => g.agent === agent && !g.stale) || agent && status.consumers.some((c) => c.name === agent && c.category === 'owned-agent')
      ? 'The chief of staff may use Notion, so clipping can run.'
      : 'No chief of staff may use Notion yet. Switch one on under 2. Which agents may use Notion.';

  return <Card role="region" aria-labelledby="clipping-heading">
    <CardHeader>
      <CardTitle id="clipping-heading" role="heading" aria-level={2}>Clipping</CardTitle>
      <CardDescription>Links you save in a Notion database are brought into the inbox, and the digest files them. Only links are copied, never the pages.</CardDescription>
    </CardHeader>
    <CardContent className="lares-stack">
    {!live ? <Notice>{messages.unavailable}</Notice> : <>
      <RunStatus label="Clipping" {...clippingRunStatus(live)} />
      <p>{keyLine}</p>
      <SourceChoice live={live} busy={busy} onChoose={(mode) => void act({ action: 'set-choice', mode })} />

      <h3 className="lares-section-title">Database</h3>
      <MappingPicker key={`${schemaReq?.id ?? 'none'}:${source?.dataSourceId ?? ''}`} schema={schema} source={source} busy={busy}
        link={link} setLink={setLink} wait={requestWait(schemaReq, 'Reading the database…')}
        onRead={() => void act({ action: 'read-database', link })}
        onSave={(m) => void act({ action: 'save-mapping', ...m }, 'Columns saved.')} />

      <h3 className="lares-section-title">Optional columns</h3>
      <p className="lares-muted">Adds Status, For and Origin to your Notion database, only where they are missing. Existing columns are never changed.</p>
      <div className="lares-inline-form"><Button variant="outline" disabled={busy || !source} onClick={() => void act({ action: 'add-properties' })}>Add Status, For and Origin columns</Button></div>
      <RequestResult req={req('add-properties')} wait="Adding the columns…"
        done={(r) => isAdd(r) ? addSentence(r) : null} />

      <h3 className="lares-section-title">Test</h3>
      <p className="lares-muted">Reads one page of rows and shows what would be imported. Writes nothing.</p>
      <div className="lares-inline-form"><Button variant="outline" disabled={busy || !source} onClick={() => void act({ action: 'test' })}>Test</Button></div>
      <RequestResult req={req('test')} wait="Testing…"
        done={(r) => isTest(r) ? testSentence(r) : null} />

      <h3 className="lares-section-title">Import</h3>
      <div className="lares-inline-form"><Button disabled={busy || !source} onClick={() => void act({ action: 'import' })}>Import now</Button></div>
      <RequestResult req={req('import')} wait="Importing…"
        done={(r, q) => isImport(r) ? `Imported ${r.imported} at ${when(q.finishedAt)}.` : null} />

      <h3 className="lares-section-title">Last fetch</h3>
      <p>{sourceSentence(source, live.sourceCount)}</p>
    </>}
    {message && <Notice>{message}</Notice>}
    </CardContent>
  </Card>;
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
  return line ? <Notice>{line}</Notice> : null;
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
      <Select value={value} disabled={busy} onChange={(e) => set(e.target.value)}>
        {optional ? <option value="">None</option> : <option value="">Choose a column</option>}
        {cols(types).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
    </label>;
  return <div className="lares-stack">
    {source && <p>Saved columns: URL is {nameOf(source.urlPropertyId) ?? 'a column you picked earlier'}.</p>}
    <label className="lares-field-label" htmlFor="clipping-link">Paste a Notion database link</label>
    <div className="lares-inline-form">
      <Input id="clipping-link" value={link} maxLength={2048} disabled={busy} onChange={(e) => setLink(e.target.value)} autoComplete="off" />
      <Button variant="outline" disabled={busy || link.trim() === ''} onClick={onRead}>Read database</Button>
    </div>
    {wait && <Notice>{wait}</Notice>}
    {schema && <div className="lares-stack">
      {schema.dataSources.length > 1 && <label className="lares-field-label">Data source
        <Select value={dsId} disabled={busy} onChange={(e) => { setDsId(e.target.value); setUrl(''); setNote(''); setTags(''); setSaved(''); }}>
          {schema.dataSources.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select></label>}
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
