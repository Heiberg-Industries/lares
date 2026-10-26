import { randomUUID } from 'node:crypto';

/** Vendor-neutral workflow contract for tracks (ADR-0024). */
export interface Track {
  id: string;
  name: string;
  purpose: string;
  steps: string[];
  closingSteps: string[];
}

export interface TrackWho { personId?: string; organisationId?: string }
export type FindWhoResult =
  | { state: 'found'; who: TrackWho }
  | { state: 'empty' }
  | { state: 'failed'; reason: string }
  | { state: 'not_applicable' };

export interface TrackItem {
  id: string;
  trackId: string;
  who: TrackWho;
  step: string;
  since: string;
  note: string;
  sourceSignal: string;
}

export interface TracksHome {
  listTracks(): Promise<Track[]>;
  findWho(query: string): Promise<FindWhoResult>;
  listItems(trackId: string, who?: TrackWho): Promise<TrackItem[]>;
  addItem(trackId: string, who: TrackWho, step: string, note: string, sourceSignal: string): Promise<TrackItem>;
  moveItem(itemId: string, step: string, note: string, sourceSignal: string): Promise<TrackItem>;
  createTrack(track: Track): Promise<Track>;
  setSteps(trackId: string, steps: string[], closingSteps: string[]): Promise<Track>;
}

export interface TrackFile {
  path: string;
  content: string;
  contentRevision: string;
}
export interface TrackFileWriter {
  list(): Promise<string[]>;
  read(path: string): Promise<TrackFile | undefined>;
  write(input: { path: string; expectedContentRevision: string | null; frontmatter: Record<string, unknown>; body: string;
    relatedContentRevisions?: Record<string, string | null> }): Promise<void>;
}

const validId = (s: string) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(s);
const clean = (s: string, max = 500) => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\r\n\0]/.test(s);
function frontmatter(raw: string): Map<string, string> {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') throw new Error('Track file is invalid');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('Track file is invalid');
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  return fields;
}
function decodeList(value: string | undefined): string[] {
  if (!value?.startsWith('[') || !value.endsWith(']')) throw new Error('Track steps are invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Track steps are invalid'); }
  if (!Array.isArray(parsed) || parsed.some(s => typeof s !== 'string')) throw new Error('Track steps are invalid');
  if (parsed.some(v => !clean(v, 80))) throw new Error('Track steps are invalid');
  return parsed;
}
function parseTrack(id: string, raw: string): Track {
  const f = frontmatter(raw);
  if (f.get('type') !== 'track') throw new Error('Track file is invalid');
  const track = { id, name: f.get('name') ?? '', purpose: f.get('purpose') ?? '', steps: decodeList(f.get('steps')), closingSteps: decodeList(f.get('closing_steps')) };
  validateTrack(track);
  return track;
}
function validateTrack(track: Track): void {
  if (!validId(track.id) || !clean(track.name, 120) || !clean(track.purpose, 500) || !track.steps.length ||
      track.steps.some(s => !clean(s, 80)) || new Set(track.steps).size !== track.steps.length ||
      !track.closingSteps.length || track.closingSteps.some(s => !track.steps.includes(s))) throw new Error('Track definition is invalid');
}
function trackPath(id: string): string {
  if (!validId(id)) throw new Error('Track id is invalid');
  return `tracks/${id}/track.md`;
}
function whoValid(who: TrackWho): boolean {
  return !!who && (typeof who.personId === 'string' || typeof who.organisationId === 'string') &&
    (who.personId === undefined || clean(who.personId, 160)) && (who.organisationId === undefined || clean(who.organisationId, 160));
}
function parseItem(id: string, trackId: string, raw: string): TrackItem {
  const f = frontmatter(raw), who: TrackWho = {};
  if (f.get('person')) who.personId = f.get('person');
  if (f.get('organisation')) who.organisationId = f.get('organisation');
  const item = { id, trackId, who, step: f.get('step') ?? '', since: f.get('since') ?? '', note: f.get('note') ?? '', sourceSignal: f.get('source_signal') ?? '' };
  if (f.get('type') !== 'track-item' || !whoValid(who) || !clean(item.step, 80) || !/^\d{4}-\d{2}-\d{2}$/.test(item.since) ||
      Number.isNaN(Date.parse(`${item.since}T00:00:00Z`)) || !clean(item.note, 500) || !clean(item.sourceSignal, 200)) throw new Error('Track item is invalid');
  return item;
}

/** Tracks are stored only below the shared Vault area's tracks/ directory. */
export class VaultTracksHome implements TracksHome {
  constructor(private readonly files: TrackFileWriter, private readonly today: () => string = () => new Date().toISOString().slice(0, 10), private readonly newId: () => string = () => randomUUID()) {}
  async listTracks(): Promise<Track[]> {
    const paths = await this.files.list(), result: Track[] = [];
    for (const path of paths.filter(p => /^tracks\/[a-z0-9][a-z0-9-]{0,62}\/track\.md$/.test(p))) {
      const file = await this.files.read(path);
      if (!file) continue;
      result.push(parseTrack(path.split('/')[1]!, file.content));
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  async findWho(_query: string): Promise<FindWhoResult> { return { state: 'not_applicable' }; }
  async readTarget(path: string): Promise<TrackFile | undefined> {
    if (!/^tracks\/[a-z0-9][a-z0-9-]{0,62}\/(?:track\.md|items\/[a-z0-9][a-z0-9-]{0,62}\.md)$/.test(path)) throw new Error('Track target is invalid');
    return this.files.read(path);
  }
  async findItemPath(itemId: string): Promise<string | undefined> {
    if (!validId(itemId)) throw new Error('Track item id is invalid');
    return (await this.files.list()).find(path => /^tracks\/[a-z0-9][a-z0-9-]{0,62}\/items\/[a-z0-9][a-z0-9-]{0,62}\.md$/.test(path) && path.endsWith(`/items/${itemId}.md`));
  }
  async listItems(trackId: string, who?: TrackWho): Promise<TrackItem[]> {
    const trackFile = await this.files.read(trackPath(trackId));
    if (!trackFile) return [];
    const track = parseTrack(trackId, trackFile.content);
    const paths = await this.files.list(), result: TrackItem[] = [];
    for (const path of paths.filter(p => new RegExp(`^tracks/${trackId}/items/[a-z0-9][a-z0-9-]{0,62}\\.md$`).test(p))) {
      const file = await this.files.read(path); if (!file) continue;
      const item = parseItem(path.split('/').at(-1)!.slice(0, -3), trackId, file.content);
      if (!track.closingSteps.includes(item.step) && (!who || (who.personId === undefined || who.personId === item.who.personId) && (who.organisationId === undefined || who.organisationId === item.who.organisationId))) result.push(item);
    }
    return result.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
  }
  async createTrack(track: Track): Promise<Track> {
    validateTrack(track);
    const path = trackPath(track.id);
    if (await this.files.read(path)) throw new Error('Track already exists');
    await this.files.write({ path, expectedContentRevision: null, frontmatter: { type: 'track', name: track.name, purpose: track.purpose, steps: track.steps, closing_steps: track.closingSteps }, body: '' });
    return track;
  }
  async setSteps(trackId: string, steps: string[], closingSteps: string[]): Promise<Track> {
    const path = trackPath(trackId), file = await this.files.read(path);
    if (!file) throw new Error('Track not found');
    const prior = parseTrack(trackId, file.content), next = { ...prior, steps, closingSteps };
    validateTrack(next);
    const paths = await this.files.list(), related: Record<string, string | null> = {};
    for (const itemPath of paths.filter(p => new RegExp(`^tracks/${trackId}/items/[a-z0-9][a-z0-9-]{0,62}\\.md$`).test(p))) {
      const itemFile = await this.files.read(itemPath); if (!itemFile) continue;
      const item = parseItem(itemPath.split('/').at(-1)!.slice(0, -3), trackId, itemFile.content);
      if (!steps.includes(item.step)) throw new Error('A tracked item uses a step that would be removed');
      related[itemPath] = itemFile.contentRevision;
    }
    await this.files.write({ path, expectedContentRevision: file.contentRevision, relatedContentRevisions: related, frontmatter: { type: 'track', name: next.name, purpose: next.purpose, steps, closing_steps: closingSteps }, body: '' });
    return next;
  }
  async addItem(trackId: string, who: TrackWho, step: string, note: string, sourceSignal: string): Promise<TrackItem> {
    const trackFile = await this.files.read(trackPath(trackId));
    if (!trackFile) throw new Error('Track not found');
    const track = parseTrack(trackId, trackFile.content);
    if (!whoValid(who) || !track.steps.includes(step) || !clean(note, 500) || !clean(sourceSignal, 200)) throw new Error('Track item input is invalid');
    const id = this.newId(); if (!validId(id)) throw new Error('Track item id is invalid');
    const path = `tracks/${trackId}/items/${id}.md`, item = { id, trackId, who, step, since: this.today(), note, sourceSignal };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.since) || Number.isNaN(Date.parse(`${item.since}T00:00:00Z`))) throw new Error('Track date is invalid');
    await this.files.write({ path, expectedContentRevision: null, relatedContentRevisions: { [trackPath(trackId)]: trackFile.contentRevision },
      frontmatter: { type: 'track-item', ...(who.personId ? { person: who.personId } : {}), ...(who.organisationId ? { organisation: who.organisationId } : {}), step, since: item.since, note, source_signal: sourceSignal }, body: '' });
    return item;
  }
  async moveItem(itemId: string, step: string, note: string, sourceSignal: string): Promise<TrackItem> {
    if (!validId(itemId)) throw new Error('Track item id is invalid');
    for (const track of await this.listTracks()) {
      const path = `tracks/${track.id}/items/${itemId}.md`, file = await this.files.read(path);
      if (!file) continue;
      if (!track.steps.includes(step) || !clean(note, 500) || !clean(sourceSignal, 200)) throw new Error('Track item input is invalid');
      const prior = parseItem(itemId, track.id, file.content), next = { ...prior, step, since: this.today(), note, sourceSignal };
      const parent = await this.files.read(trackPath(track.id));
      if (!parent) throw new Error('Track not found');
      const currentTrack = parseTrack(track.id, parent.content);
      if (!currentTrack.steps.includes(step)) throw new Error('Track item input is invalid');
      await this.files.write({ path, expectedContentRevision: file.contentRevision, relatedContentRevisions: { [trackPath(track.id)]: parent.contentRevision }, frontmatter: { type: 'track-item', ...(prior.who.personId ? { person: prior.who.personId } : {}), ...(prior.who.organisationId ? { organisation: prior.who.organisationId } : {}), step, since: next.since, note, source_signal: sourceSignal }, body: '' });
      return next;
    }
    throw new Error('Track item not found');
  }
}
