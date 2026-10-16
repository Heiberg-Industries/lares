// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NOTION_CREDENTIAL_CHANGED, NotionCredential } from '../components/NotionCredential';
import type { CredentialStatus } from '@lares/agent-kit/credential-lifecycle';
const active = '11111111-1111-4111-8111-111111111111', candidate = '22222222-2222-4222-8222-222222222222';
function status(change: Partial<CredentialStatus> = {}): CredentialStatus {
  return { slot: 'notion:shared', revision: 1, activeRevision: active, candidateRevision: null, state: 'applied', phase: 'applied', guidance: null,
    test: null, consumers: [{ name: 'example', category: 'owned-agent', incarnation: active }], activation: [], rollback: [], inventoryRevision: 'a'.repeat(64), ...change };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('render performs no fetch/provider call and separates stored key, test and activation evidence', () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  const html = renderToStaticMarkup(<NotionCredential initial={{ kind: 'status', status: status({ state: 'pending-apply', phase: 'pending-apply', candidateRevision: candidate,
    test: { revision: candidate, outcome: 'passed', at: '2026-10-08T12:00:00.000Z' } }) }} />);
  expect(html).toContain('Current key: stored'); expect(html).toContain('passed'); expect(html).toContain('2026-10-08T12:00:00.000Z');
  expect(html).toContain('Activation'); expect(html).toContain('Rollback'); expect(html).toContain('does not prove access to pages');
  expect(request).not.toHaveBeenCalled(); expect(html).not.toContain(active); expect(html).not.toContain(candidate);
});
it('submits the password value once, immediately clears it and never persists it in HTML or URL', async () => {
  let resolve!: (value: Response) => void;
  const request = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(r => { resolve = r; })); vi.stubGlobal('fetch', request);
  render(<NotionCredential initial={{ kind: 'status', status: status() }} />);
  const input = screen.getByLabelText('New Notion internal connection key') as HTMLInputElement;
  expect(input.type).toBe('password'); fireEvent.change(input, { target: { value: 'synthetic-secret-only' } });
  fireEvent.submit(input.closest('form')!); fireEvent.submit(input.closest('form')!);
  expect(input.value).toBe(''); expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]![0]).toBe('/api/credentials/notion');
  expect(document.body.innerHTML).not.toContain('synthetic-secret-only'); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  resolve(Response.json({ ok: true, status: status({ state: 'test-failed', phase: 'test-failed', candidateRevision: candidate, test: { revision: candidate, outcome: 'refused', at: '2026-10-08T12:00:00.000Z' } }) }));
  await waitFor(() => expect(screen.getByText(/Last identity test/).textContent).toContain('refused'));
  expect(screen.getByText('Current key: stored.')).toBeTruthy(); expect(request).toHaveBeenCalledOnce();
});
it('requires the complete affected list/restart checkbox before sending Apply', async () => {
  const request = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ ok: true, status: status() })); vi.stubGlobal('fetch', request);
  render(<NotionCredential initial={{ kind: 'status', status: status({ state: 'pending-apply', phase: 'pending-apply', candidateRevision: candidate, test: { revision: candidate, outcome: 'passed', at: '2026-10-08T12:00:00.000Z' } }) }} />);
  fireEvent.click(screen.getByText('Apply replacement')); expect(request).not.toHaveBeenCalled();
  const button = screen.getByText('Confirm Apply') as HTMLButtonElement; expect(button.disabled).toBe(true);
  expect(screen.getByRole('group', { name: 'Confirm runtime restart' }).textContent).toContain('example');
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(JSON.parse(String(request.mock.calls[0]![1].body))).toMatchObject({ operation: 'apply', expectedActiveRevision: active, inventoryRevision: 'a'.repeat(64), confirmRestart: true });
});
it('retains known evidence after an unknown result and permits only an explicit status refresh', async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, code: 'outcome-unknown' }, { status: 503 })).mockResolvedValueOnce(Response.json({ ok: true, status: status({ state: 'recovery-required', phase: 'applying', guidance: 'inspect-journal' }) }));
  vi.stubGlobal('fetch', request); render(<NotionCredential initial={{ kind: 'status', status: status() }} />);
  fireEvent.click(screen.getByText('Test current key'));
  await waitFor(() => expect(screen.getByText(/The result is unknown/)).toBeTruthy());
  expect(screen.getByText('Current key: stored.')).toBeTruthy(); expect(screen.queryByText('Test current key')).toBeNull(); expect(request).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('Refresh credential status'));
  await waitFor(() => expect(screen.getByText(/Recovery required\. Ask/)).toBeTruthy()); expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][1].method).toBeUndefined();
});
it.each(['prepare-managed-slot', 'review-consumers', 'inspect-journal'] as const)('shows %s guidance without editable secret controls', guidance => {
  const html = renderToStaticMarkup(<NotionCredential initial={{ kind: 'status', status: status({ state: guidance === 'inspect-journal' ? 'recovery-required' : 'host-administration-required', guidance }) }} />);
  expect(html).not.toContain('type="password"'); expect(html).not.toContain('Test current key'); expect(html).toContain('host operator'); expect(html).toContain('Provider revocation is not implemented');
});
it('renders unavailable status as unavailable, never as empty configured evidence', () => {
  const html = renderToStaticMarkup(<NotionCredential initial={{ kind: 'unavailable' }} />);
  expect(html).toContain('Credential status unavailable'); expect(html).not.toContain('none stored'); expect(html).not.toContain('none pending');
});
it('reads its status again when another card says it changed the credential (a clipping switch)', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ ok: true, status: status({ revision: 2, grants: [{ agent: 'example', purposes: ['clipping'] }] }) }));
  vi.stubGlobal('fetch', request); render(<NotionCredential initial={{ kind: 'status', status: status() }} />);
  expect(request).not.toHaveBeenCalled();
  window.dispatchEvent(new Event(NOTION_CREDENTIAL_CHANGED));
  await waitFor(() => expect(screen.getByText('Status refreshed.')).toBeTruthy());
  expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][1].method).toBeUndefined();
});
