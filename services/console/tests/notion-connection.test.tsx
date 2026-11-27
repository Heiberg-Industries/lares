// @vitest-environment jsdom
// The Notion page's top line and its two steps. The wording is new; the calls are the keeper's, unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NOTION_KEY_UPDATED, NotionConnection } from '../components/NotionConnection';
import { checkLine, notionUsers, topSentence } from '../lib/notion-connection';
import type { CredentialStatus } from '@lares/agent-kit/credential-lifecycle';
import type { CredentialView } from '../lib/credentials';

const active = '11111111-1111-4111-8111-111111111111', candidate = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-08T12:00:00.000Z';
function status(change: Partial<CredentialStatus> = {}): CredentialStatus {
  return { slot: 'notion:shared', revision: 1, activeRevision: active, candidateRevision: null, state: 'applied', phase: 'applied', guidance: null,
    test: { revision: active, outcome: 'passed', at }, consumers: [{ name: 'chief', category: 'owned-agent', incarnation: active }],
    activation: [], rollback: [], inventoryRevision: 'a'.repeat(64), grants: [{ agent: 'chief', purposes: ['clipping'] }], ...change };
}
const none = (change: Partial<CredentialStatus> = {}) => status({ state: 'not-configured', phase: null, activeRevision: null, test: null, consumers: [], grants: [], ...change });
const pending = (outcome: 'passed' | 'refused' | 'unavailable' = 'passed') => status({
  state: outcome === 'passed' ? 'pending-apply' : 'test-failed', phase: outcome === 'passed' ? 'pending-apply' : 'test-failed',
  candidateRevision: candidate, test: { revision: candidate, outcome, at } });
const agents = [{ name: 'chief', displayName: 'Ada' }, { name: 'second', displayName: 'Bea' }];
const names = { chief: 'Ada', second: 'Bea' };
const of = (s: CredentialStatus): CredentialView => ({ kind: 'status', status: s });
const show = (v: CredentialView, children?: React.ReactNode) =>
  render(<NotionConnection initial={v} agents={agents} names={names}>{children}</NotionConnection>);
const markup = (v: CredentialView) => renderToStaticMarkup(<NotionConnection initial={v} agents={agents} names={names}><p>FOLDED</p></NotionConnection>)
  .replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const ok = (s: CredentialStatus) => Response.json({ ok: true, status: s });
const bodyOf = (f: ReturnType<typeof vi.fn>, i: number) => JSON.parse(String((f.mock.calls[i]![1] as RequestInit).body));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the top sentence', () => {
  it.each([
    ['not connected', none(), 'Notion is not connected yet.'],
    ['connected, named by display name', status(), 'Notion is connected; Ada may use it.'],
    ['connected through the installation\'s settings too', status({ consumers: [{ name: 'chief', category: 'owned-agent', incarnation: active }, { name: 'second', category: 'owned-agent', incarnation: active }] }), 'Notion is connected; Ada and Bea may use it.'],
    ['connected, nobody switched on', status({ grants: [], consumers: [] }), 'Notion is connected; no agent may use it yet.'],
    ['cannot reach Notion', status({ test: { revision: active, outcome: 'unavailable', at } }), 'Lares cannot reach Notion from your server: ask whoever runs your server to let it reach api.notion.com'],
    ['switching to a new key', status({ state: 'applying', phase: 'applying', candidateRevision: candidate }), 'Switching to the new key; Ada restarts for a moment.'],
    ['going back', status({ state: 'applying', phase: 'rolling-back', candidateRevision: candidate }), 'That did not work; going back to the previous key; Ada restarts for a moment.'],
    ['stopping', status({ state: 'disconnecting', phase: 'disconnecting' }), 'Stopping Notion in Lares; Ada restarts for a moment.'],
    ['not ready to keep a key', none({ state: 'host-administration-required', guidance: 'prepare-managed-slot' }), 'Notion is not connected yet: this server is not ready to keep a Notion key.'],
  ] as const)('%s', (_name, s, expected) => {
    expect(topSentence(s, names)).toContain(expected);
    expect(markup(of(s))).toContain(expected);
  });
  it('unreadable, or not the owner: says so, and claims nothing about the key', () => {
    expect(markup({ kind: 'unavailable' })).toContain('Lares cannot read the state of the Notion connection right now.');
    const admin = markup({ kind: 'administrator-required' });
    expect(admin).toContain("Only the installation's owner can connect Notion");
    expect(admin).not.toContain('Save and check'); expect(admin).not.toContain('2. Which agents');
  });
  it('who may use it: switched on here, through the installation\'s own settings, or switched on but gone', () => {
    expect(notionUsers(status({ consumers: [{ name: 'second', category: 'owned-agent', incarnation: active }], grants: [{ agent: 'chief', purposes: ['clipping'] }, { agent: 'gone', purposes: ['clipping'], stale: true }] })))
      .toEqual({ granted: ['chief'], byConfig: ['second'], stale: ['gone'] });
  });
});

describe('1. Connect', () => {
  it('one field, "Notion key", and one button, "Save and check"; the old words are gone', () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const t = markup(of(none()));
    expect(t).toContain('1. Connect'); expect(t).toContain('Notion key'); expect(t).toContain('Save and check');
    expect(t).toContain('Connections'); // what to share in Notion
    for (const word of ['Activation', 'Rollback', 'Replacement', 'Discard', 'Disconnect locally', 'credential administrator', 'Test and save'])
      for (const v of [of(none()), of(status()), of(pending()), of(pending('refused'))]) expect(markup(v)).not.toContain(word);
    expect(request).not.toHaveBeenCalled();
    expect(markup(of(none()))).not.toContain('2. Which agents may use Notion');
  });
  it.each([
    ['passed', 'Lares reached Notion with this key.'],
    ['refused', 'Notion refused this key — copy it again from Notion.'],
    ['unavailable', 'Your server could not reach Notion.'],
  ] as const)('the answer to a check is one plain line: %s', (outcome, line) => {
    expect(checkLine(pending(outcome))).toBe(line);
    const t = markup(of(pending(outcome)));
    expect(t).toContain(line);
    // Only a key that passed is called valid.
    expect(t.includes('The check shows the key is valid.')).toBe(outcome === 'passed');
  });
  it('sends the key once with the same keeper call as before, clears the field, and keeps it out of the page', async () => {
    let resolve!: (value: Response) => void;
    const request = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(r => { resolve = r; })); vi.stubGlobal('fetch', request);
    const told = vi.fn(); window.addEventListener(NOTION_KEY_UPDATED, told);
    show(of(none()));
    const input = screen.getByLabelText('Notion key') as HTMLInputElement;
    expect(input.type).toBe('password'); fireEvent.change(input, { target: { value: 'synthetic-secret-only' } });
    fireEvent.submit(input.closest('form')!); fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe(''); expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]![0]).toBe('/api/credentials/notion');
    expect(bodyOf(request as never, 0)).toEqual({ operation: 'test_save', slot: 'notion:shared', expectedRevision: 1, token: 'synthetic-secret-only' });
    expect(document.body.innerHTML).not.toContain('synthetic-secret-only'); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    resolve(ok(none({ state: 'test-failed', phase: 'test-failed', candidateRevision: candidate, test: { revision: candidate, outcome: 'refused', at } })));
    await waitFor(() => expect(screen.getByText(/Notion refused this key/)).toBeTruthy());
    expect(told).toHaveBeenCalledOnce(); window.removeEventListener(NOTION_KEY_UPDATED, told);
    expect(JSON.stringify((told.mock.calls[0]![0] as CustomEvent).detail)).not.toContain('synthetic-secret-only');
  });
  it('a key that did not pass cannot be started: only Check again and Remove this new key', () => {
    const t = markup(of(pending('refused')));
    expect(t).not.toContain('Start using this key'); expect(t).toContain('Check again'); expect(t).toContain('Remove this new key');
    expect(t).not.toContain('Save and check'); // the new key stays apart: no second one until this one is started or removed
  });
  it('Start using this key asks once, names what restarts, then sends apply with the inventory it showed', async () => {
    const request = vi.fn(async () => ok(status({ revision: 2 }))); vi.stubGlobal('fetch', request);
    show(of(pending()));
    fireEvent.click(screen.getByText('Start using this key')); expect(request).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Confirm' });
    expect(group.textContent).toContain('Ada restarts for a moment');
    fireEvent.click(screen.getByText('Yes, start using it'));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(bodyOf(request as never, 0)).toEqual({ operation: 'apply', slot: 'notion:shared', expectedRevision: 1, expectedActiveRevision: active,
      confirmRestart: true, inventoryRevision: 'a'.repeat(64) });
  });
  it('Remove this new key sends discard; Check again sends test_pending', async () => {
    const request = vi.fn(async () => ok(status())); vi.stubGlobal('fetch', request);
    show(of(pending('refused')));
    fireEvent.click(screen.getByText('Check again'));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(bodyOf(request as never, 0)).toEqual({ operation: 'test_pending', slot: 'notion:shared', expectedRevision: 1 });
    cleanup(); request.mockClear(); show(of(pending('refused')));
    fireEvent.click(screen.getByText('Remove this new key'));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(bodyOf(request as never, 0)).toEqual({ operation: 'discard', slot: 'notion:shared', expectedRevision: 1 });
  });
  it('Stop using Notion in Lares says the key still works in Notion, confirms, then sends disconnect', async () => {
    const request = vi.fn(async () => ok(none())); vi.stubGlobal('fetch', request);
    show(of(status()));
    expect(screen.getByText(/The key still works in Notion until you delete the connection there/)).toBeTruthy();
    fireEvent.click(screen.getByText('Stop using Notion in Lares')); expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Yes, stop using Notion'));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(bodyOf(request as never, 0)).toMatchObject({ operation: 'disconnect', inventoryRevision: 'a'.repeat(64), confirmRestart: true });
  });
  it('starting and stopping wait for an inventory revision', () => {
    vi.stubGlobal('fetch', vi.fn());
    show(of({ ...pending(), inventoryRevision: null }));
    expect((screen.getByText('Start using this key') as HTMLButtonElement).disabled).toBe(true);
  });
  it('a failed switch says Lares went back to the previous key', () => {
    expect(markup(of(status({ rollback: [{ name: 'chief', revision: active, state: 'complete' }] })))).toContain('That did not work, so Lares went back to the previous key.');
    expect(markup(of(status()))).not.toContain('went back');
  });
  it('while it switches, the page asks again every few seconds and stops once it is done', async () => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockResolvedValueOnce(ok(status({ state: 'applying', phase: 'applying', candidateRevision: candidate })))
      .mockResolvedValue(ok(status()));
    vi.stubGlobal('fetch', request);
    show(of(status({ state: 'applying', phase: 'applying', candidateRevision: candidate })));
    expect(screen.getByTestId('notion-top').textContent).toContain('Switching to the new key; Ada restarts for a moment.');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('notion-top').textContent).toBe('Notion is connected; Ada may use it.');
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('an unknown result keeps what is known, offers no change, and only an explicit reload asks again', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, code: 'outcome-unknown' }, { status: 503 })).mockResolvedValueOnce(ok(status()));
    vi.stubGlobal('fetch', request); show(of(status()));
    fireEvent.click(screen.getByText('Check the key again'));
    await waitFor(() => expect(screen.getByText(/Lares does not know whether that went through/)).toBeTruthy());
    expect(screen.queryByText('Check the key again')).toBeNull(); expect(request).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Reload status'));
    await waitFor(() => expect(screen.getByText('Check the key again')).toBeTruthy());
    expect((request.mock.calls[1]![1] as RequestInit).method).toBeUndefined();
  });
  it.each(['prepare-managed-slot', 'review-consumers', 'inspect-journal'] as const)('%s guidance: plain words and no key field', guidance => {
    const t = markup(of(none({ state: guidance === 'inspect-journal' ? 'recovery-required' : 'host-administration-required', guidance })));
    expect(t).not.toContain('Save and check');
    expect(t).toContain(guidance === 'prepare-managed-slot' ? 'lares update' : 'whoever runs your server');
  });
});

describe('2. Which agents may use Notion', () => {
  it('shows once step 1 is done, one switch per agent, by display name', () => {
    vi.stubGlobal('fetch', vi.fn());
    show(of(status()));
    expect(screen.getByText('2. Which agents may use Notion')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Ada may use Notion' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('switch', { name: 'Bea may use Notion' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
  });
  it('switching on previews first, names what restarts, then grants with the PREVIEW revision', async () => {
    const preview = { agent: 'second', purpose: 'clipping', inventoryRevision: 'b'.repeat(64), consumers: [
      { name: 'chief', category: 'owned-agent', incarnation: active }, { name: 'second', category: 'owned-agent', incarnation: active }] };
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, preview }))
      .mockResolvedValueOnce(ok(status({ revision: 2, grants: [{ agent: 'chief', purposes: ['clipping'] }, { agent: 'second', purposes: ['clipping'] }] })));
    vi.stubGlobal('fetch', request);
    show(of(status()));
    fireEvent.click(screen.getByRole('switch', { name: 'Bea may use Notion' }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]![0]).toBe('/api/credentials/notion/preview'); expect(bodyOf(request, 0)).toEqual({ agent: 'second' });
    const group = await screen.findByRole('group', { name: 'Confirm' });
    expect(group.textContent).toContain('Let Bea use Notion?'); expect(group.textContent).toContain('Ada and Bea restart for a moment');
    fireEvent.click(screen.getByText('Yes, switch it on'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]![0]).toBe('/api/credentials/notion');
    expect(bodyOf(request, 1)).toEqual({ operation: 'grant', slot: 'notion:shared', expectedRevision: 1, expectedActiveRevision: active,
      confirmRestart: true, inventoryRevision: 'b'.repeat(64), agent: 'second', purpose: 'clipping' });
    await waitFor(() => expect(screen.getByTestId('notion-top').textContent).toBe('Notion is connected; Ada and Bea may use it.'));
  });
  it('switching off confirms with the current inventory, then revokes; Cancel sends nothing', async () => {
    const request = vi.fn(async () => ok(status({ revision: 2, grants: [] }))); vi.stubGlobal('fetch', request);
    show(of(status()));
    fireEvent.click(screen.getByRole('switch', { name: 'Ada may use Notion' }));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel')); expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: 'Ada may use Notion' }));
    fireEvent.click(screen.getByText('Yes, switch it off'));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(bodyOf(request as never, 0)).toMatchObject({ operation: 'revoke', agent: 'chief', purpose: 'clipping', inventoryRevision: 'a'.repeat(64), confirmRestart: true, expectedRevision: 1 });
  });
  it('stays in view while a new key waits, with its switches paused until the new key is started or removed', () => {
    vi.stubGlobal('fetch', vi.fn());
    show(of(pending()));
    expect(screen.getByText(/Start using the new key, or remove it, before you change who may use Notion/)).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Ada may use Notion' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Bea may use Notion' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('an agent that reads the key through the installation\'s own settings has no switch', () => {
    vi.stubGlobal('fetch', vi.fn());
    show(of(status({ grants: [] })));
    expect(screen.queryByRole('switch', { name: 'Ada may use Notion' })).toBeNull();
    expect(screen.getByText(/Uses Notion through this installation's own settings/)).toBeTruthy();
  });
  it('a refused preview shows its sentence and opens no confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: false, code: 'request-refused' }, { status: 409 })));
    show(of(status()));
    fireEvent.click(screen.getByRole('switch', { name: 'Bea may use Notion' }));
    await waitFor(() => expect(screen.getByText(/Lares refused that change/)).toBeTruthy());
    expect(screen.queryByRole('group', { name: 'Confirm' })).toBeNull();
  });
  it('a switched-on agent that no longer exists is removed without a restart list', async () => {
    const request = vi.fn(async () => ok(status())); vi.stubGlobal('fetch', request);
    show(of(status({ grants: [{ agent: 'chief', purposes: ['clipping'] }, { agent: 'gone', purposes: ['clipping'], stale: true }] })));
    expect(screen.getByText(/gone was switched on but no longer exists/)).toBeTruthy();
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(bodyOf(request as never, 0)).toMatchObject({ operation: 'revoke', agent: 'gone', inventoryRevision: 'a'.repeat(64) });
  });
});

describe('Clipping and People sync', () => {
  it('are folded until both steps are done, and open once they are', () => {
    vi.stubGlobal('fetch', vi.fn());
    for (const s of [none(), status({ grants: [], consumers: [] })]) {
      show(of(s), <p>FOLDED</p>);
      expect((screen.getByTestId('notion-more') as HTMLDetailsElement).open).toBe(false);
      cleanup();
    }
    show(of(status()), <p>FOLDED</p>);
    expect((screen.getByTestId('notion-more') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText('FOLDED')).toBeTruthy();
  });
});
