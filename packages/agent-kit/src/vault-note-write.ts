/** One new private note from a private Console conversation, as both sides see it.
 *
 * The runtime raises the card and Keeper writes the file, so the note's path, its frontmatter
 * and what counts as a valid call live here, once. The native tool (`note-write-tools.ts`)
 * writes the same `_inbox/<slug>.md` shape into the runtime's own store; this one reaches the
 * member's private area in Keeper custody, and only through an exact approved card. */
import { payloadFingerprint } from './approval-ledger.js';

export const VAULT_NOTE_WRITE_TOOL = 'agent-kit__vault_write';
/** Labels for the two fingerprints the card carries and Keeper recomputes. */
export const VAULT_NOTE_WRITE_POLICY = 'vault-note-write-policy-v1';
export const VAULT_NOTE_TARGET = 'vault-note-target-v1';

export interface VaultNoteInput { area: 'private'; title: string; body: string; tags?: string[] }

// The same refusal GuardedVaultFiles applies to a frontmatter value, checked before any card.
const LINE_BREAK = /[\r\n\x00-\x1f\x7f\x85\u2028\u2029]/;
const MAX_TITLE = 200, MAX_BODY = 50_000, MAX_TAGS = 32, MAX_TAG = 64;

export function vaultNoteSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note';
}
export function vaultNotePath(title: string): string { return `_inbox/${vaultNoteSlug(title)}.md`; }

/** Throws on anything Keeper would not write: another area, an extra field, a line break in a
 *  frontmatter value or an oversized note. Refused here, a bad call never reaches a card. */
export function parseVaultNoteInput(raw: unknown): VaultNoteInput {
  const refuse = (): never => { throw new Error('Vault note is unavailable'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const i = raw as Record<string, unknown>;
  if (Object.keys(i).some((key) => !['area', 'title', 'body', 'tags'].includes(key))) refuse();
  if (i.area !== 'private' || typeof i.title !== 'string' || i.title.trim() === '' || i.title.length > MAX_TITLE ||
      LINE_BREAK.test(i.title) || typeof i.body !== 'string' || i.body.length > MAX_BODY) refuse();
  if (i.tags !== undefined && (!Array.isArray(i.tags) || i.tags.length > MAX_TAGS ||
      !i.tags.every((tag) => typeof tag === 'string' && tag.length <= MAX_TAG && !LINE_BREAK.test(tag)))) refuse();
  return i as unknown as VaultNoteInput;
}

/** What the native tool writes, less `lares_origin`: Keeper's writer stamps that from the card. */
export function vaultNoteFrontmatter(note: VaultNoteInput): Record<string, unknown> {
  return { title: note.title, type: 'note', source: 'agent', created: null, tags: note.tags ?? [] };
}

/** The fingerprint of the note as the card saw it: its current bytes, or none for a new note. */
export function vaultNoteTargetFingerprint(content: string | null): string {
  return payloadFingerprint(VAULT_NOTE_TARGET, content);
}
