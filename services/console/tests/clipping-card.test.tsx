// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClippingCard, testSentence } from '../components/ClippingCard';
import type { CredentialStatus } from '@lares/agent-kit/credential-lifecycle';
import type { CredentialView } from '../lib/credentials';
import type { ClippingRequestView, ClippingSourceView, ClippingView } from '../lib/clipping';

const active = '11111111-1111-4111-8111-111111111111';
const incarnation = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-09T11:00:00.000Z';

function status(change: Partial<CredentialStatus> = {}): CredentialStatus {
  return { slot: 'notion:shared', revision: 4, activeRevision: active, candidateRevision: null, state: 'applied', phase: 'applied', guidance: null,
    test: { revision: active, outcome: 'passed', at: T }, consumers: [], activation: [], rollback: [], inventoryRevision: 'a'.repeat(64), ...change };
}
const cred = (change: Partial<CredentialStatus> = {}): CredentialView => ({ kind: 'status', status: status(change) });
const granted = { grants: [{ agent: 'chief', purposes: ['clipping' as const] }], consumers: [{ name: 'chief', category: 'owned-agent' as const, incarnation }] };

const source = (over: Partial<ClippingSourceView> = {}): ClippingSourceView => ({
  id: 's1', dataSourceId: 'ds-1', urlPropertyId: 'u1', notePropertyId: null, tagsPropertyId: null, savedPropertyId: null,
  importSince: T, outcome: 'ok', detail: null, lastAttemptAt: T, lastSuccessAt: T, importedTotal: 12, lastCounts: { imported: 3, updated: 1, trashed: 0, noLink: 2 }, ...over,
});
const schemaResult = {
  databaseId: 'db', suggested: { titleId: 'title', urlId: 'u1' },
  dataSources: [{ id: 'ds-1', name: 'Read later', columns: [
    { id: 'title', name: 'Name', type: 'title' }, { id: 'u1', name: 'Link', type: 'url' }, { id: 'n1', name: 'Note', type: 'rich_text' },
    { id: 't1', name: 'Tags', type: 'multi_select' }, { id: 'x1', name: 'Pages', type: 'number' },
  ] }],
};
const request = (kind: ClippingRequestView['kind'], over: Partial<ClippingRequestView> = {}): ClippingRequestView => ({
  id: `r-${kind}`, kind, status: 'done', outcome: 'ok', detail: null, createdAt: T, finishedAt: T, result: null, ...over,
});
const view = (over: Partial<Extract<ClippingView, { unavailable: false }>> = {}): ClippingView => ({
  unavailable: false, source: null, sourceCount: 0, requests: {}, choice: null, chiefOfStaff: { kind: 'one', name: 'chief' }, busy: false, ...over,
});
const text = (v: ClippingView, c: CredentialView = cred()) =>
  renderToStaticMarkup(<ClippingCard initial={v} credential={c} />).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const html = (v: ClippingView, c: CredentialView = cred()) => renderToStaticMarkup(<ClippingCard initial={v} credential={c} />);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('every state has its own sentence', () => {
  it('unreadable: "Clipping status unavailable." and nothing else is claimed', () => {
    const t = text({ unavailable: true });
    expect(t).toContain('Clipping status unavailable.');
    expect(t).not.toContain('No clipping source'); expect(t).not.toContain('Switch clipping'); expect(t).not.toContain('Import now');
  });

  describe('source choice', () => {
    it.each([
      [null, 'Source: not chosen yet'],
      ['notion', 'Source: Notion.'],
      ['karakeep', 'Source: Karakeep.'],
      ['both', 'Source: Both (changeover).'],
    ] as const)('%s', (mode, expected) => {
      const t = text(view({ choice: mode ? { mode, setBy: 'o', setAt: T } : null }));
      expect(t).toContain(expected);
    });
    it('Karakeep only says Notion is not imported; Notion only says Karakeep is left alone', () => {
      expect(text(view({ choice: { mode: 'karakeep', setBy: 'o', setAt: T } }))).toContain('Notion links are not imported while the source is Karakeep only.');
      expect(text(view({ choice: { mode: 'notion', setBy: 'o', setAt: T } }))).toContain('Nothing in Karakeep is deleted.');
    });
  });

  describe('the Notion key line', () => {
    it('working / saved / not saved / unavailable', () => {
      expect(text(view())).toContain('Notion key: working.');
      expect(text(view(), cred({ test: null }))).toContain('Notion key: saved.');
      expect(text(view(), cred({ activeRevision: null, state: 'not-configured' }))).toContain('Notion key: not saved. Add it under Notion key above.');
      expect(text(view(), { kind: 'unavailable' })).toContain('Notion key: status unavailable.');
      expect(text(view(), cred({ state: 'unavailable' }))).toContain('Notion key: status unavailable.');
    });
  });

  describe('the database', () => {
    it('before anything is read: asks for a link, nothing else', () => {
      const t = text(view());
      expect(t).toContain('Paste a Notion database link'); expect(t).not.toContain('Reading the database');
      expect(t).not.toContain('URL column');
    });
    it.each([
      ['pending', 'Reading the database… (the chief of staff picks this up within a minute).'],
      ['claimed', 'Reading the database… (the chief of staff is working on it).'],
    ] as const)('%s', (s, expected) => {
      expect(text(view({ busy: true, requests: { schema: request('schema', { status: s, outcome: null, finishedAt: null }) } }))).toContain(expected);
    });
    it('not picked up in ten minutes', () => {
      expect(text(view({ requests: { schema: request('schema', { status: 'unavailable', outcome: null, detail: 'The chief of staff did not pick this up.' }) } })))
        .toContain('The chief of staff did not pick this up.');
    });
    it('not finished in ten minutes', () => {
      expect(text(view({ requests: { import: request('import', { status: 'unavailable', outcome: null, detail: 'The chief of staff did not finish this.' }) } })))
        .toContain('The chief of staff did not finish this.');
    });
    it('not shared with the connection, with how to fix it', () => {
      const t = text(view({ requests: { schema: request('schema', { status: 'failed', outcome: 'not-shared', detail: 'The clipping database is not shared with the Lares connection.' }) } }));
      expect(t).toContain('Not shared with your Lares connection.'); expect(t).toContain('three dots, then Connections');
    });
    it('Notion refused the key', () => {
      const t = text(view({ requests: { schema: request('schema', { status: 'failed', outcome: 'refused', detail: 'Notion refused the connection key.' }) } }));
      expect(t).toContain('Notion refused the key.'); expect(t).toContain('Check the Notion key above.');
    });
    it.each([
      ['rate-limited', 'Notion is limiting requests'], ['unavailable', 'Notion could not be reached'], ['timeout', 'Notion did not answer in time'],
      ['key-unreadable', 'The Notion key could not be read'], ['local-error', 'Lares could not read its own records'],
      ['schema-mismatch', 'The database no longer fits'], ['incomplete', "Notion's answer was incomplete"],
    ] as const)('failure %s has its own label', (outcome, label) => {
      expect(text(view({ requests: { schema: request('schema', { status: 'failed', outcome, detail: null }) } }))).toContain(`${label}.`);
    });
    it('read: columns to pick, the URL column pre-selected, and saving starts from now', () => {
      const v = view({ requests: { schema: request('schema', { result: schemaResult }) } });
      const t = text(v);
      expect(t).toContain('Found “Read later” with 5 columns.'); expect(t).toContain('starts from now');
      const h = html(v);
      expect(h).toMatch(/<option value="u1" selected="">Link<\/option>/);
      expect(h).toContain('>Save columns<');
      // Only columns of the right type are offered for each role.
      expect(h.match(/<option value="x1"/g)).toBeNull();
    });
    it('read, no URL column: says so', () => {
      const none = { ...schemaResult, suggested: { titleId: 'title', urlId: null }, dataSources: [{ ...schemaResult.dataSources[0]!, columns: [{ id: 'title', name: 'Name', type: 'title' }] }] };
      expect(text(view({ requests: { schema: request('schema', { result: none }) } }))).toContain('This database has no URL column.');
    });
    it('a saved source names its URL column when the last read lists it', () => {
      expect(text(view({ source: source(), sourceCount: 1, requests: { schema: request('schema', { result: schemaResult }) } }))).toContain('Saved columns: URL is Link.');
    });
    it('a finished read whose answer cannot be read says so instead of showing nothing', () => {
      expect(text(view({ requests: { schema: request('schema', { result: null }) } }))).not.toContain('Found');
    });
  });

  describe('test', () => {
    it('needs a saved source', () => {
      expect(html(view())).toMatch(/<button[^>]*disabled=""[^>]*>Test<\/button>/);
      expect(html(view({ source: source(), sourceCount: 1 }))).not.toMatch(/<button[^>]*disabled=""[^>]*>Test<\/button>/);
    });
    const base = { wouldImport: 0, fromUrlColumn: 0, fromTitle: 0, withoutLink: 0, alreadyImported: 0, more: false };
    it('would import N, from where', () => {
      expect(text(view({ requests: { test: request('test', { result: { ...base, wouldImport: 3, fromUrlColumn: 2, fromTitle: 1 } }) } })))
        .toContain('Would import 3 links (2 from the URL column, 1 from the title).');
      expect(testSentence({ ...base, wouldImport: 1, fromUrlColumn: 1 })).toBe('Would import 1 link (1 from the URL column, 0 from the title).');
      expect(testSentence({ ...base, recent: { checked: 5, fromUrlColumn: 4, fromTitle: 0, withoutLink: 1 } }))
        .toBe('Would import nothing new. Of the 5 most recently edited rows: 4 with the link in the URL column, 0 with the link only in the title, 1 without a link.');
    });
    it('would import nothing new', () => {
      expect(text(view({ requests: { test: request('test', { result: base }) } }))).toContain('Would import nothing new.');
    });
    it('names rows without a link, already imported, more rows, and warnings', () => {
      expect(testSentence({ ...base, wouldImport: 2, fromUrlColumn: 2, withoutLink: 3, alreadyImported: 4, more: true, warnings: ['The tags column was removed or changed type; importing without it.'] }))
        .toBe('Would import 2 links (2 from the URL column, 0 from the title). 3 rows have no link and would be skipped. 4 already imported. There are more rows than this test read. The tags column was removed or changed type; importing without it.');
    });
    it('failure and waiting', () => {
      expect(text(view({ requests: { test: request('test', { status: 'failed', outcome: 'schema-mismatch', detail: 'The URL column was removed or changed type.' }) } })))
        .toContain('The database no longer fits. The URL column was removed or changed type.');
      expect(text(view({ busy: true, requests: { test: request('test', { status: 'pending', outcome: null }) } }))).toContain('Testing…');
    });
  });

  describe('add columns', () => {
    it('added, already there, and a conflict that was left alone', () => {
      const t = text(view({ source: source(), sourceCount: 1, requests: { 'add-properties': request('add-properties', { result: {
        added: ['For'], present: ['Origin'], conflicts: [{ name: 'Status', found: 'rich_text', wanted: 'select' }] } }) } }));
      expect(t).toContain('Added For.'); expect(t).toContain('Already there: Origin.');
      expect(t).toContain('Status already exists as a rich-text column, so Lares left it alone.');
    });
    it('nothing to add', () => {
      expect(text(view({ requests: { 'add-properties': request('add-properties', { result: { added: [], present: ['Status', 'For', 'Origin'], conflicts: [] } }) } }))).toContain('Nothing to add.');
    });
  });

  describe('import', () => {
    it('imported N at a time', () => {
      expect(text(view({ requests: { import: request('import', { finishedAt: '2026-10-09T11:30:00.000Z', result: { imported: 4 } }) } }))).toContain('Imported 4 at 2026-10-09 11:30 UTC.');
    });
    it('a failure is a failure sentence, never "Imported 0"', () => {
      const t = text(view({ source: source({ outcome: 'timeout', detail: 'Notion did not answer in time.' }), sourceCount: 1, requests: { import: request('import', { status: 'failed', outcome: 'timeout', detail: 'Notion did not answer in time.' }) } }));
      expect(t).toContain('Notion did not answer in time.'); expect(t).not.toContain('Imported 0');
    });
  });

  describe('last fetch', () => {
    it('no source', () => expect(text(view())).toContain('No clipping source is saved yet.'));
    it('never fetched', () => expect(text(view({ source: source({ outcome: null, lastAttemptAt: null, lastSuccessAt: null, importedTotal: 0 }), sourceCount: 1 }))).toContain('Not fetched yet.'));
    it('ok: when, the last pass and the total', () => {
      const t = text(view({ source: source(), sourceCount: 1 }));
      expect(t).toContain('Last fetch: ok at 2026-10-09 11:00 UTC.'); expect(t).toContain('3 imported, 1 updated, 0 removed, 2 without a link.'); expect(t).toContain('Imported 12 in total.');
    });
    it('a failure says it failed, names the last good fetch, and shows no counts as if they were new', () => {
      const t = text(view({ source: source({ outcome: 'refused', detail: 'Notion refused the connection key.', lastAttemptAt: '2026-10-09T12:00:00.000Z' }), sourceCount: 1 }));
      expect(t).toContain('Last fetch failed at 2026-10-09 12:00 UTC.'); expect(t).toContain('Notion refused the key.');
      expect(t).toContain('Last good fetch: 2026-10-09 11:00 UTC.'); expect(t).not.toMatch(/0 new|Last pass/);
    });
    it('a failure before any success says never', () => {
      expect(text(view({ source: source({ outcome: 'not-shared', detail: 'x', lastSuccessAt: null, importedTotal: 0 }), sourceCount: 1 }))).toContain('Last good fetch: never.');
    });
    it('not configured is not a failure and not "ok"', () => {
      const t = text(view({ source: source({ outcome: 'not-configured', detail: 'No Notion key is connected.', lastSuccessAt: null }), sourceCount: 1 }));
      expect(t).toContain('Not fetched yet. No Notion key is connected.'); expect(t).not.toContain('Last fetch: ok');
    });
    it('more than one source is named', () => expect(text(view({ source: source(), sourceCount: 2 }))).toContain('More than one Notion source is set up.'));
  });

  describe('the switch', () => {
    const saved = { source: source(), sourceCount: 1 };
    it('off: offers to switch on', () => {
      const t = text(view(saved)); expect(t).toContain('Clipping is switched off: the chief of staff does not receive the Notion key yet.'); expect(t).toContain('Switch clipping on');
      expect(t).not.toContain('Switch clipping off');
    });
    it('on: offers to switch off', () => {
      const t = text(view(saved), cred(granted)); expect(t).toContain('Clipping is switched on: the chief of staff receives the Notion key.'); expect(t).toContain('Switch clipping off');
      expect(t).not.toContain('Switch clipping on');
    });
    it('on through the installation configuration: no switch', () => {
      const t = text(view(saved), cred({ consumers: granted.consumers }));
      expect(t).toContain("already receives the Notion key through this installation's own configuration"); expect(t).not.toContain('Switch clipping');
    });
    it('not the administrator: the fixed sentence and no switch', () => {
      const t = text(view(saved), { kind: 'administrator-required' });
      expect(t).toContain("Only the installation's credential administrator can switch this."); expect(t).not.toContain('Switch clipping');
    });
    it('credential status unavailable, or signed out', () => {
      expect(text(view(saved), { kind: 'unavailable' })).toContain('Credential status unavailable.');
      expect(text(view(saved), cred({ state: 'unavailable' }))).toContain('Credential status unavailable.');
      expect(text(view(saved), { kind: 'sign-in-required' })).toContain('Sign in again');
    });
    it('no key saved: the fixed sentence and no switch', () => {
      const t = text(view(saved), cred({ activeRevision: null, state: 'not-configured' }));
      expect(t).toContain('No Notion key is saved yet. Add it under Notion key above.'); expect(t).not.toContain('Switch clipping');
    });
    it('no chief of staff, or several: explained, switch hidden', () => {
      const none = text(view({ ...saved, chiefOfStaff: { kind: 'none' } }));
      expect(none).toContain('No chief of staff is set up'); expect(none).not.toContain('Switch clipping');
      const many = text(view({ ...saved, chiefOfStaff: { kind: 'several' } }));
      expect(many).toContain('More than one chief of staff is set up'); expect(many).not.toContain('Switch clipping');
    });
    it('a stale grant is shown as stale with a plain Remove', () => {
      const t = text(view(saved), cred({ grants: [{ agent: 'gone', purposes: ['clipping'], stale: true }] }));
      expect(t).toContain('The agent gone was switched on but no longer exists. Nothing restarts when you remove it.'); expect(t).toContain('Remove');
    });
    it('switching off is disabled until the keeper has given an inventory revision', () => {
      expect(html(view(saved), cred({ ...granted, inventoryRevision: null }))).toMatch(/<button[^>]*disabled=""[^>]*>Switch clipping off<\/button>/);
    });
  });
});

describe('render makes no network call', () => {
  it('no fetch from rendering, even while a request is waiting', () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    renderToStaticMarkup(<ClippingCard initial={view({ busy: true, requests: { schema: request('schema', { status: 'pending', outcome: null }) } })} credential={cred()} />);
    expect(f).not.toHaveBeenCalled();
  });
});

const json = (body: unknown, status = 200) => Response.json(body, { status });
const bodyOf = (f: ReturnType<typeof vi.fn>, n: number) => JSON.parse(String((f.mock.calls[n]![1] as RequestInit).body));

describe('polling', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('polls every 5 seconds while a request is waiting, then stops', async () => {
    const waiting = view({ busy: true, requests: { import: request('import', { status: 'claimed', outcome: null, finishedAt: null }) } });
    const finished = view({ source: source(), sourceCount: 1, requests: { import: request('import', { result: { imported: 2 } }) } });
    const f = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, view: waiting }))
      .mockResolvedValueOnce(json({ ok: true, view: finished }))
      .mockResolvedValue(json({ ok: true, view: finished }));
    vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={waiting} credential={cred()} />);
    expect(f).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
    expect(f).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe('/api/clipping'); expect((f.mock.calls[0]![1] as RequestInit).method).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(f).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Imported 2 at/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f).toHaveBeenCalledTimes(2); // finished: no more polling
  });

  it('does not poll when nothing is waiting', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={view({ source: source(), sourceCount: 1 })} credential={cred()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f).not.toHaveBeenCalled();
  });

  it('a poll that fails shows unavailable and stops, never an empty success', async () => {
    const f = vi.fn().mockRejectedValue(new Error('network')); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={view({ busy: true, requests: { test: request('test', { status: 'pending', outcome: null }) } })} credential={cred()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(screen.getByText('Clipping status unavailable.')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an overdue request is not polled for ever', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={view({ busy: false, requests: { test: request('test', { status: 'unavailable', outcome: null, detail: 'The chief of staff did not pick this up.' }) } })} credential={cred()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('buttons', () => {
  const saved = view({ source: source(), sourceCount: 1 });

  it.each([
    ['Test', { action: 'test' }], ['Import now', { action: 'import' }],
    ['Add Status, For and Origin columns', { action: 'add-properties' }],
  ])('%s posts its one action', async (label, expected) => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, view: { ...saved, busy: true } })); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={saved} credential={cred()} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(f).toHaveBeenCalledOnce());
    expect(f.mock.calls[0]![0]).toBe('/api/clipping'); expect(bodyOf(f, 0)).toEqual(expected);
  });

  it('a double click sends one request', async () => {
    const f = vi.fn(() => new Promise<Response>(() => undefined)); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={saved} credential={cred()} />);
    fireEvent.click(screen.getByText('Import now')); fireEvent.click(screen.getByText('Import now'));
    expect(f).toHaveBeenCalledOnce();
  });

  it('a refused request shows its own sentence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: false, code: 'busy' }, 409)));
    render(<ClippingCard initial={saved} credential={cred()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByText(/still waiting/)).toBeTruthy());
  });

  it('Read database posts the pasted link', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, view: view({ busy: true, requests: { schema: request('schema', { status: 'pending', outcome: null }) } }) })); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={view()} credential={cred()} />);
    const read = screen.getByText('Read database') as HTMLButtonElement; expect(read.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Paste a Notion database link'), { target: { value: 'https://www.notion.so/Clips-0123456789abcdef0123456789abcdef' } });
    fireEvent.click(read);
    await waitFor(() => expect(f).toHaveBeenCalledOnce());
    expect(bodyOf(f, 0)).toEqual({ action: 'read-database', link: 'https://www.notion.so/Clips-0123456789abcdef0123456789abcdef' });
    await waitFor(() => expect(screen.getByText(/Reading the database…/)).toBeTruthy());
  });

  it('Save columns posts the picked columns', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, view: saved })); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={view({ requests: { schema: request('schema', { result: schemaResult }) } })} credential={cred()} />);
    fireEvent.change(screen.getByLabelText('Tags column (optional)'), { target: { value: 't1' } });
    fireEvent.click(screen.getByText('Save columns'));
    await waitFor(() => expect(f).toHaveBeenCalledOnce());
    expect(bodyOf(f, 0)).toEqual({ action: 'save-mapping', dataSourceId: 'ds-1', urlPropertyId: 'u1', notePropertyId: null, tagsPropertyId: 't1', savedPropertyId: null });
    await waitFor(() => expect(screen.getByText('Columns saved.')).toBeTruthy());
  });

  it('choosing a source posts it', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, view: view({ choice: { mode: 'both', setBy: 'o', setAt: T } }) })); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={view()} credential={cred()} />);
    fireEvent.click(screen.getByText('Both (changeover)'));
    await waitFor(() => expect(bodyOf(f, 0)).toEqual({ action: 'set-choice', mode: 'both' }));
    await waitFor(() => expect(screen.getByText(/Source: Both \(changeover\)\./)).toBeTruthy());
  });
});

describe('the switch confirms before restarting anything', () => {
  const saved = view({ source: source(), sourceCount: 1 });
  const preview = { agent: 'chief', purpose: 'clipping', inventoryRevision: 'b'.repeat(64), consumers: [
    { name: 'chief', category: 'owned-agent', incarnation }, { name: 'other-agent', category: 'owned-agent', incarnation }] };

  it('on: previews first, lists the agents it would restart, needs the checkbox, then grants with the PREVIEW revision', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, preview }))
      .mockResolvedValueOnce(json({ ok: true, status: status({ revision: 5, ...granted, inventoryRevision: 'c'.repeat(64) }) }));
    vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={saved} credential={cred()} />);
    fireEvent.click(screen.getByText('Switch clipping on'));
    await waitFor(() => expect(f).toHaveBeenCalledOnce());
    expect(f.mock.calls[0]![0]).toBe('/api/clipping'); expect(bodyOf(f, 0)).toEqual({ action: 'preview-grant' });
    const group = await screen.findByRole('group', { name: 'Confirm clipping switch' });
    expect(group.textContent).toContain('chief'); expect(group.textContent).toContain('other-agent'); expect(group.textContent).toContain('restart');
    const confirm = screen.getByText('Confirm switch on') as HTMLButtonElement; expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm); expect(f).toHaveBeenCalledOnce(); // nothing sent without the checkbox
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(confirm);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(f.mock.calls[1]![0]).toBe('/api/credentials/notion');
    expect(bodyOf(f, 1)).toEqual({
      operation: 'grant', slot: 'notion:shared', expectedRevision: 4, expectedActiveRevision: active,
      inventoryRevision: 'b'.repeat(64), confirmRestart: true, agent: 'chief', purpose: 'clipping',
    });
    await waitFor(() => expect(screen.getByText(/Clipping is switched on/)).toBeTruthy());
    expect(screen.getByText('Switch clipping off')).toBeTruthy();
  });

  it('Cancel sends nothing further', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, preview })); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={saved} credential={cred()} />);
    fireEvent.click(screen.getByText('Switch clipping on'));
    await screen.findByRole('group', { name: 'Confirm clipping switch' });
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('group', { name: 'Confirm clipping switch' })).toBeNull(); expect(f).toHaveBeenCalledOnce();
  });

  it('off: uses the status inventory revision, lists the current consumers, then revokes', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, status: status({ revision: 6 }) })); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={saved} credential={cred({ ...granted, consumers: [...granted.consumers, { name: 'other-agent', category: 'owned-agent', incarnation }] })} />);
    fireEvent.click(screen.getByText('Switch clipping off'));
    expect(f).not.toHaveBeenCalled(); // nothing is sent before the confirmation
    const group = screen.getByRole('group', { name: 'Confirm clipping switch' });
    expect(group.textContent).toContain('other-agent');
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByText('Confirm switch off'));
    await waitFor(() => expect(f).toHaveBeenCalledOnce());
    expect(bodyOf(f, 0)).toMatchObject({ operation: 'revoke', agent: 'chief', purpose: 'clipping', inventoryRevision: 'a'.repeat(64), confirmRestart: true, expectedRevision: 4 });
    await waitFor(() => expect(screen.getByText(/Clipping is switched off/)).toBeTruthy());
  });

  it('Remove on a stale grant revokes that agent', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, status: status({ grants: [] }) })); vi.stubGlobal('fetch', f);
    render(<ClippingCard initial={saved} credential={cred({ grants: [{ agent: 'gone', purposes: ['clipping'], stale: true }] })} />);
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(f).toHaveBeenCalledOnce());
    expect(bodyOf(f, 0)).toMatchObject({ operation: 'revoke', agent: 'gone', purpose: 'clipping', inventoryRevision: 'a'.repeat(64) });
    await waitFor(() => expect(screen.queryByText(/no longer exists/)).toBeNull());
  });

  it('a keeper refusal and an unknown result are told apart; the switch state does not change on either', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: false, code: 'request-refused' }, 409)));
    render(<ClippingCard initial={saved} credential={cred(granted)} />);
    fireEvent.click(screen.getByText('Switch clipping off')); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByText('Confirm switch off'));
    await waitFor(() => expect(screen.getByText(/The keeper refused this request/)).toBeTruthy());
    expect(screen.getByText(/Clipping is switched on/)).toBeTruthy();
    cleanup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: false, code: 'outcome-unknown' }, 503)));
    render(<ClippingCard initial={saved} credential={cred(granted)} />);
    fireEvent.click(screen.getByText('Switch clipping off')); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByText('Confirm switch off'));
    await waitFor(() => expect(screen.getByText(/The result is unknown/)).toBeTruthy());
  });

  it('a preview that fails shows its sentence and opens no confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: false, code: 'unavailable-before-send' }, 503)));
    render(<ClippingCard initial={saved} credential={cred()} />);
    fireEvent.click(screen.getByText('Switch clipping on'));
    await waitFor(() => expect(screen.getByText(/could not be reached/)).toBeTruthy());
    expect(screen.queryByRole('group', { name: 'Confirm clipping switch' })).toBeNull();
  });
});
