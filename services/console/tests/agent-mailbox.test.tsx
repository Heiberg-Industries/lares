// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentMailbox } from '../components/AgentMailbox';
import type { AgentMailboxViewDTO } from '../lib/agent-mailbox';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const LINE = 'Sorts new mail and writes reply drafts in Gmail, can read your Drive files, and adds or changes calendar events only when you approve each one. It never sends.';
const options = [
  { accountId: 'acct-a', resourceBindingId: 'res-a', address: 'one@example.com', canDraft: true },
  { accountId: 'acct-b', resourceBindingId: 'res-b', address: 'two@example.com', canDraft: false },
];
const chosen = { accountId: 'acct-a', resourceBindingId: 'res-a', address: 'one@example.com' };
const view = (extra: Partial<AgentMailboxViewDTO>): AgentMailboxViewDTO =>
  ({ agent: 'writer', state: 'working', title: 'Mailbox', sentence: LINE, options, chosen, ...extra });
const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));
const hidden = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`form input[name="${name}"]`)].map(i => i.value);
const sent = (fetchMock: ReturnType<typeof reply>) => JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);

const open = async (name: RegExp | string) => { await userEvent.click(screen.getByRole('button', { name })); return screen.findByRole('menu'); };

it('shows the chosen mailbox on a button; its menu lists the owner’s accounts with a check on the chosen one, and None', async () => {
  render(<AgentMailbox name="writer" initial={view({})} />);
  expect(screen.getByText('Mailbox')).toBeTruthy(); expect(document.body.textContent).toContain(LINE);
  const menu = await open('Works on one@example.com');
  const items = within(menu).getAllByRole('menuitem');
  expect(items.map(i => i.textContent)).toEqual(['None', 'one@example.com', 'two@example.com (read only)']);
  expect(items[1].querySelector('svg')).toBeTruthy(); expect(items[2].querySelector('svg')).toBeNull();
});

it('with nothing chosen the button reads Choose a mailbox', () => {
  render(<AgentMailbox name="writer" initial={view({ state: 'choose', chosen: undefined })} />);
  expect(screen.getByRole('button', { name: 'Choose a mailbox' })).toBeTruthy();
});

it('choosing an account posts the account and its resource, then shows the saved view', async () => {
  const fetchMock = reply({ ok: true, view: view({ chosen: { ...chosen, accountId: 'acct-b', resourceBindingId: 'res-b', address: 'two@example.com' } }) }); vi.stubGlobal('fetch', fetchMock);
  render(<AgentMailbox name="writer" initial={view({ state: 'choose', chosen: undefined })} />);
  await userEvent.click(within(await open('Choose a mailbox')).getByRole('menuitem', { name: /two@example.com/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/agent-mailbox');
  expect(sent(fetchMock)).toEqual({ name: 'writer', operation: 'choose', accountId: 'acct-b', resourceBindingId: 'res-b' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Works on two@example.com' })).toBeTruthy());
});

it('None clears the choice', async () => {
  const fetchMock = reply({ ok: true, view: view({ state: 'choose', chosen: undefined }) }); vi.stubGlobal('fetch', fetchMock);
  render(<AgentMailbox name="writer" initial={view({})} />);
  await userEvent.click(within(await open('Works on one@example.com')).getByRole('menuitem', { name: 'None' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(sent(fetchMock)).toEqual({ name: 'writer', operation: 'clear' });
});

it('with no Google account, a Connect button opens a dialog that posts the address with the drafts permission', async () => {
  render(<AgentMailbox name="writer" initial={view({ state: 'no-account', sentence: 'No mailbox. Connect your Google account first, then choose it here.', options: [], chosen: undefined })} />);
  expect(document.body.textContent).toContain('No mailbox. Connect your Google account first, then choose it here.');
  await userEvent.click(screen.getByRole('button', { name: /^Connect Google/ }));
  const form = (await screen.findByRole('dialog')).querySelector('form')!;
  expect(form.getAttribute('action')).toBe('/api/accounts/google/start');
  expect(hidden('intent')).toEqual(['new']); expect(hidden('power')).toEqual(['read+mail-draft']);
  expect(form.querySelector('input[name="email"]')).toBeTruthy();
});

const reconnected = view({ state: 'paused', title: 'Mailbox paused', confirm: true, sentence: 'You reconnected one@example.com. Confirm that this agent may keep working on it.' });
it('after a reconnect, says so and Confirm posts the confirmation', async () => {
  const fetchMock = reply({ ok: true, view: view({}) }); vi.stubGlobal('fetch', fetchMock);
  render(<AgentMailbox name="writer" initial={reconnected} />);
  expect(screen.getByText('Mailbox paused')).toBeTruthy();
  expect(document.body.textContent).toContain('You reconnected one@example.com. Confirm that this agent may keep working on it.');
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(screen.getByText('Mailbox')).toBeTruthy());
  expect(sent(fetchMock)).toEqual({ name: 'writer', operation: 'confirm' });
});

it('"Choose another" opens the account menu', async () => {
  render(<AgentMailbox name="writer" initial={reconnected} />);
  expect(within(await open('Choose another')).getAllByRole('menuitem')).toHaveLength(3);
});

it('a read-only account offers Reconnect, which asks again with the drafts permission', () => {
  render(<AgentMailbox name="writer" initial={view({ state: 'paused', title: 'Mailbox paused', sentence: 'paused', reconnect: { accountId: 'acct-a', generation: 4 } })} />);
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  expect(hidden('intent')).toEqual(['reconnect']); expect(hidden('accountId')).toEqual(['acct-a']);
  expect(hidden('generation')).toEqual(['4']); expect(hidden('power')).toEqual(['read+mail-draft']);
  expect(screen.getByRole('button', { name: 'Choose again' })).toBeTruthy();
});

it('says so, with no control, when the setting could not be loaded', () => {
  render(<AgentMailbox name="writer" initial={view({ state: 'unavailable', sentence: 'The mailbox setting could not be loaded. Reload this page to try again.', options: [], chosen: undefined })} />);
  expect(document.body.textContent).toContain('The mailbox setting could not be loaded. Reload this page to try again.');
  expect(screen.queryByRole('button')).toBeNull();
});

it('shows no control to someone who is not the owner', () => {
  render(<AgentMailbox name="writer" initial={view({ state: 'not-yours', sentence: 'Only this agent’s owner can choose its mailbox.', options: [], chosen: undefined })} />);
  expect(document.body.textContent).toContain('Only this agent’s owner can choose its mailbox.');
  expect(screen.queryByRole('button')).toBeNull();
});

it('links to Edit agent when the definition has no Gmail permission', () => {
  render(<AgentMailbox name="writer" initial={view({ state: 'no-gmail-permission', sentence: 'no permission', options: [], chosen: undefined })} />);
  expect(screen.getByRole('link', { name: /Edit agent/ }).getAttribute('href')).toBe('/agents/writer/edit');
});

it('shows the refusal sentence and keeps the old state', async () => {
  vi.stubGlobal('fetch', reply({ ok: false, code: 'scopes-not-draft', message: 'refused sentence' }, false));
  render(<AgentMailbox name="writer" initial={view({})} />);
  await userEvent.click(within(await open('Works on one@example.com')).getByRole('menuitem', { name: /two@example.com/ }));
  await waitFor(() => expect(document.body.textContent).toContain('refused sentence'));
  expect(screen.getByRole('button', { name: 'Works on one@example.com' })).toBeTruthy();
});
