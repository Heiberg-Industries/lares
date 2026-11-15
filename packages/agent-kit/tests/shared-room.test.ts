import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { privateOnlyTool, privateToolAllowed } from '../src/private-console-surface.js';
import { CONSOLE_SESSION_AUTHENTICATOR } from '../src/door-authority.js';
import {
  chatKindOf, startedIn, sharedRoomAllows, sharedRoomRefusal, assertSharedRoomAllows, SHARED_ROOM_ALLOWED,
  SHARED_ROOM_REFUSED, SHARED_ROOM_UNAVAILABLE,
} from '../src/shared-room.js';

const slack = (channel_id?: string) => ({ authenticator: 'slack-webhook', attributes: { user_id: 'U0OWNER', ...(channel_id ? { channel_id } : {}) } });
const telegram = (chat_type?: string) => ({ authenticator: 'telegram-webhook', attributes: { user_id: '1001', ...(chat_type ? { chat_type } : {}) } });
const console_ = { authenticator: 'lares-console', principalType: 'user', principalId: 'member-a', attributes: { lares_member_id: 'member-a' } };
const schedule = { authenticator: 'app', principalId: 'eve:app', principalType: 'runtime', attributes: {} };
const started = (initiator: unknown, current: unknown = initiator) => ({ session: { auth: { initiator, current } } });

describe('where a conversation started', () => {
  it('Slack: a direct message is a channel id starting with D; any other channel is a shared room', () => {
    expect(startedIn(started(slack('D0DIRECT')))).toBe('private-chat');
    expect(startedIn(started(slack('C0CHANNEL')))).toBe('shared-room');
    // A private channel (and an older private group) is still read by everyone in it.
    expect(startedIn(started(slack('C0PRIVATECHANNEL')))).toBe('shared-room');
    expect(startedIn(started(slack('G0GROUP')))).toBe('shared-room');
    expect(startedIn(started(slack()))).toBe('shared-room');
  });

  it('Telegram: a private chat is private; a group or a chat with no type is a shared room', () => {
    expect(startedIn(started(telegram('private')))).toBe('private-chat');
    expect(startedIn(started(telegram('group')))).toBe('shared-room');
    expect(startedIn(started(telegram('supergroup')))).toBe('shared-room');
    expect(startedIn(started(telegram()))).toBe('shared-room');
  });

  it('is read from the initiator, which an answered card does not change', () => {
    expect(startedIn(started(slack('C0ROOM'), slack('D0DIRECT')))).toBe('shared-room');
    expect(startedIn(started(slack('D0DIRECT'), slack('C0ROOM')))).toBe('private-chat');
    // An approval answer carries the initiator as `session.initiator`.
    expect(startedIn({ session: { initiator: slack('C0ROOM') } })).toBe('shared-room');
    expect(startedIn({ session: { initiator: slack('D0DIRECT') } })).toBe('private-chat');
  });

  it('fails closed: a door conversation with no initiator is a shared room', () => {
    expect(startedIn(started(null, slack('D0DIRECT')))).toBe('shared-room');
    expect(startedIn(started(undefined, telegram('private')))).toBe('shared-room');
  });

  it('fails closed: a door without a row is a shared room', () => {
    for (const authenticator of ['discord-interaction', 'teams-activity', 'photon-imessage', 'example-webhook', 'something-new']) {
      expect(startedIn(started({ authenticator, attributes: { user_id: 'U0OWNER' } })), authenticator).toBe('shared-room');
    }
    expect(startedIn(started({ attributes: {} }))).toBe('shared-room');
    // eve's development-server sign-in is granted from a run-time flag, not from the build, so it fails closed too.
    expect(startedIn(started({ authenticator: 'local-dev', principalId: 'local-dev', principalType: 'local-dev', attributes: {} }))).toBe('shared-room');
  });

  it('web chat and a schedule-started conversation are not a door', () => {
    // The module writes the console's authenticator out (it has no imports); it is the same value.
    expect(console_.authenticator).toBe(CONSOLE_SESSION_AUTHENTICATOR);
    expect(startedIn(started(console_))).toBe('not-a-door');
    // The route password alone (no member named) is web chat too.
    expect(startedIn(started({ authenticator: 'http-basic', attributes: {} }))).toBe('not-a-door');
    expect(startedIn(started(schedule))).toBe('not-a-door');
    // A schedule card answered from a direct message: still the schedule's conversation.
    expect(startedIn(started(schedule, slack('D0DIRECT')))).toBe('not-a-door');
    expect(startedIn(started(null, console_))).toBe('not-a-door');
    expect(startedIn(started(null, null))).toBe('not-a-door');
    expect(startedIn({})).toBe('not-a-door');
    expect(startedIn(undefined)).toBe('not-a-door');
  });

  it('reads one identity the same way, for a door that has a message and no session yet', () => {
    expect(chatKindOf(slack('D0DIRECT'))).toBe('private-chat');
    expect(chatKindOf(slack('C0CHANNEL'))).toBe('shared-room');
    expect(chatKindOf(telegram('private'))).toBe('private-chat');
    expect(chatKindOf(null)).toBe('not-a-door');
  });
});

describe('what a shared room may use', () => {
  it('allows the public material and the read-only looks the owner chose', () => {
    for (const name of ['set_language', 'lares_read_public_doc', 'agent-kit__transit_plan', 'lares-docs',
      'twenty_lookup', 'twenty_get_person', 'twenty_company_for_person', 'deadline_list', 'remind_list']) {
      expect(sharedRoomAllows(name), name).toBe(true);
    }
    expect([...SHARED_ROOM_ALLOWED].sort()).toEqual(['agent-kit__transit_plan', 'deadline_list', 'lares-docs', 'lares_read_public_doc',
      'remind_list', 'set_language', 'twenty_company_for_person', 'twenty_get_person', 'twenty_lookup']);
  });

  it('allows nothing else: private reads, writes, card tools, other skills, and a name that does not exist', () => {
    for (const name of ['gmail_read', 'gmail_send', 'gmail_signature', 'calendar_list_events', 'remember', 'save_note', 'deadline_add',
      'facts_list', 'memory_used', 'identity_my_addresses', 'voice_guide', 'digest_run', 'agent-kit__signals_recent',
      'commercial_who_to_contact', 'sales-outreach', 'signals', 'person_lookup', 'agent-kit__vault_search',
      'vault_list', 'vault_read', 'vault_search', 'vault_write', 'studio_ideate', 'no_such_tool', '']) {
      expect(sharedRoomAllows(name), name).toBe(false);
    }
  });

  it('sends the person to a direct message only for a tool a direct message has', () => {
    expect(SHARED_ROOM_REFUSED).toBe('That is not available in a shared room. Ask me in a direct message.');
    expect(SHARED_ROOM_UNAVAILABLE).toBe('That is not available in a shared room.');
    expect(sharedRoomRefusal(true)).toBe(SHARED_ROOM_REFUSED);
    expect(sharedRoomRefusal(false)).toBe(SHARED_ROOM_UNAVAILABLE);
  });

  it('refuses an unlisted name only in a conversation started in a shared room', () => {
    expect(() => assertSharedRoomAllows(started(slack('C0ROOM')), 'remember', true)).toThrow(SHARED_ROOM_REFUSED);
    expect(() => assertSharedRoomAllows(started(slack('C0ROOM')), 'tracks_list', false)).toThrow(SHARED_ROOM_UNAVAILABLE);
    expect(() => assertSharedRoomAllows(started(slack('C0ROOM')), 'tracks_list', false)).not.toThrow(SHARED_ROOM_REFUSED);
    expect(() => assertSharedRoomAllows(started(slack('C0ROOM')), 'set_language', true)).not.toThrow();
    expect(() => assertSharedRoomAllows(started(slack('D0DIRECT')), 'remember', true)).not.toThrow();
    expect(() => assertSharedRoomAllows(started(console_), 'remember', true)).not.toThrow();
    expect(() => assertSharedRoomAllows(started(schedule), 'remember', true)).not.toThrow();
  });

  it('has no imports, so the console browser code may read it through conversation-too-long', () => {
    const source = readFileSync(new URL('../src/shared-room.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import /m);
  });

  it('leaves the private console lists as they are', () => {
    expect(privateToolAllowed('chief-of-staff', 'agent-kit__vault_search', { callerIsOwner: true })).toBe(false);
    expect(privateToolAllowed('chief-of-staff', 'person_lookup', { callerIsOwner: true })).toBe(false);
    expect(privateOnlyTool('person_lookup')).toBe(false);
  });
});
