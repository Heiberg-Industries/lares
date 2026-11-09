// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentProviderKey } from '../components/AgentProviderKey';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const secret = 'sk-example-never-shown';
const none = { kind: 'status' as const, status: { name: 'writer', own: false } };
const own = { kind: 'status' as const, status: { name: 'writer', own: true, setAt: '2026-11-09T10:00:00.000Z', setBy: 'owner' as const } };
const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

it('says which key is used and explains the risks in plain words', () => {
  render(<AgentProviderKey name="writer" initial={none} />);
  const text = document.body.textContent ?? '';
  expect(text).toContain('Uses the installation’s key.');
  for (const part of ['is not tested', 'refused until you replace or remove it', 'No restart is needed', 'spending limits apply whichever key pays', 'Only the designated owner'])
    expect(text).toContain(part);
  expect(screen.getByLabelText('Key for this agent')).toHaveProperty('type', 'password');
  expect(screen.getByLabelText('Key for this agent')).toHaveProperty('value', '');
  expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
});

it('shows the date of an own key and offers to remove it', () => {
  render(<AgentProviderKey name="writer" initial={own} />);
  expect(document.body.textContent).toContain('Uses its own key, set on 2026-11-09.');
  expect(screen.getByRole('button', { name: /Remove \(go back to the installation’s key\)/ })).toBeTruthy();
});

it('asks for a confirmation before saving, sends the key once and never shows it again', async () => {
  const fetchMock = reply({ ok: true, status: own.status }); vi.stubGlobal('fetch', fetchMock);
  render(<AgentProviderKey name="writer" initial={none} />);
  await userEvent.type(screen.getByLabelText('Key for this agent'), secret);
  await userEvent.click(screen.getByRole('button', { name: 'Save and use this key' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Nothing checks that it works.');
  await userEvent.click(screen.getByRole('button', { name: 'Yes, use this key' }));
  await waitFor(() => expect(document.body.textContent).toContain('Uses its own key, set on 2026-11-09.'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
  expect(path).toBe('/api/provider-key');
  expect(JSON.parse(init.body)).toEqual({ operation: 'save', name: 'writer', key: secret });
  expect(document.body.innerHTML).not.toContain(secret);
});

it('cancelling sends nothing', async () => {
  const fetchMock = reply({ ok: true, status: own.status }); vi.stubGlobal('fetch', fetchMock);
  render(<AgentProviderKey name="writer" initial={none} />);
  await userEvent.type(screen.getByLabelText('Key for this agent'), secret);
  await userEvent.click(screen.getByRole('button', { name: 'Save and use this key' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.body.innerHTML).not.toContain(secret);
});

it('removes the own key and goes back to the installation’s key', async () => {
  vi.stubGlobal('fetch', reply({ ok: true, status: none.status }));
  render(<AgentProviderKey name="writer" initial={own} />);
  await userEvent.click(screen.getByRole('button', { name: /Remove/ }));
  await waitFor(() => expect(document.body.textContent).toContain('Uses the installation’s key.'));
});

it('shows a fixed message when the owner check refuses, and not an invented success', async () => {
  vi.stubGlobal('fetch', reply({ ok: false, code: 'owner-required' }, false));
  render(<AgentProviderKey name="writer" initial={none} />);
  await userEvent.type(screen.getByLabelText('Key for this agent'), secret);
  await userEvent.click(screen.getByRole('button', { name: 'Save and use this key' }));
  await userEvent.click(screen.getByRole('button', { name: 'Yes, use this key' }));
  await waitFor(() => expect(document.body.textContent).toContain('Only the designated owner can change an agent’s own model key.'));
  expect(document.body.textContent).toContain('Uses the installation’s key.');
});

it('says so when the status could not be read', () => {
  render(<AgentProviderKey name="writer" initial={{ kind: 'unavailable' }} />);
  expect(document.body.textContent).toContain('The key status is unavailable');
  expect(screen.queryByLabelText(/Key for this agent/)).toBeNull();
});
