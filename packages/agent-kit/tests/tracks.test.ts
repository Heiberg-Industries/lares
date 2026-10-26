import { expect, it } from 'vitest';
import { VaultTracksHome, type TrackFileWriter } from '../src/tracks.js';
import { serializeFrontmatter } from '../src/vault-git.js';

function fixture() {
  const files = new Map<string, { content: string; contentRevision: string }>(); let revision = 0;
  const writer: TrackFileWriter = {
    async list() { return [...files.keys()]; },
    async read(path) { const file = files.get(path); return file ? { path, ...file } : undefined; },
    async write(input) {
      if ((files.get(input.path)?.contentRevision ?? null) !== input.expectedContentRevision) throw new Error('stale file');
      for (const [path, expected] of Object.entries(input.relatedContentRevisions ?? {}))
        if ((files.get(path)?.contentRevision ?? null) !== expected) throw new Error('stale related file');
      files.set(input.path, { content: `${serializeFrontmatter(input.frontmatter)}\n\n${input.body}`, contentRevision: `r${++revision}` });
    },
  };
  return { files, home: new VaultTracksHome(writer, () => '2026-10-26', () => `item-${++revision}`) };
}

it('round trips quoted and punctuated steps using the same frontmatter encoder as Vault writes', async () => {
  const { home } = fixture();
  const track = { id: 'quotes', name: 'Quotes', purpose: 'Round trip', steps: ['Start, now', 'Say "hello"', 'Bracket [x]'], closingSteps: ['Bracket [x]'] };
  await home.createTrack(track);
  expect((await home.listTracks())[0]).toEqual(track);
});

it('refuses step removal when a closed item still uses that step', async () => {
  const { home } = fixture();
  await home.createTrack({ id: 'closed', name: 'Closed', purpose: 'Keep history', steps: ['Open', 'Done'], closingSteps: ['Done'] });
  await home.addItem('closed', { personId: 'person-1' }, 'Done', 'Completed', 'signal-1');
  await expect(home.setSteps('closed', ['Open'], ['Open'])).rejects.toThrow('A tracked item uses a step that would be removed');
});

it('includes the parent track revision when moving an item', async () => {
  const { home, files } = fixture();
  await home.createTrack({ id: 'move', name: 'Move', purpose: 'Revision check', steps: ['Open', 'Doing'], closingSteps: ['Doing'] });
  const item = await home.addItem('move', { personId: 'person-1' }, 'Open', 'Started', 'signal-1');
  const originalWrite = files.get.bind(files);
  const itemPath = `tracks/move/items/${item.id}.md`, trackPath = 'tracks/move/track.md';
  const itemRevision = originalWrite(itemPath)!.contentRevision;
  const trackRevision = originalWrite(trackPath)!.contentRevision;
  await home.moveItem(item.id, 'Doing', 'Moved', 'signal-2');
  expect(originalWrite(itemPath)!.contentRevision).not.toBe(itemRevision);
  expect(originalWrite(trackPath)!.contentRevision).toBe(trackRevision);
});

it('checks every retained item revision when changing steps', async () => {
  const { home, files } = fixture();
  await home.createTrack({ id: 'steps', name: 'Steps', purpose: 'Revision check', steps: ['Open', 'Doing', 'Done'], closingSteps: ['Done'] });
  const item = await home.addItem('steps', { personId: 'person-1' }, 'Open', 'Started', 'signal-1');
  const itemPath = `tracks/steps/items/${item.id}.md`, before = files.get(itemPath)!.contentRevision;
  await home.setSteps('steps', ['Open', 'Doing', 'Done', 'Paused'], ['Done']);
  expect(files.get(itemPath)!.contentRevision).toBe(before);
});
