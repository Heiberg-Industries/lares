import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwentyTracksHome, parseTwentyOpportunitySchema, type TwentyTracksClient } from '../lib/twenty-tracks.js';

// Synthetic API-shaped fixtures exercise the adapter contract; they are not live Twenty evidence.
const fields = {
  data: { fields: [
    { name: 'brand', objectMetadata: { nameSingular: 'opportunity' }, options: [
      { id: 'b1', value: 'ALPHA', label: 'Alpha', position: 0 },
      { id: 'b2', value: 'BETA', label: 'Beta', position: 1 },
    ] },
    { name: 'stage', objectMetadata: { nameSingular: 'opportunity' }, options: [
      { id: 's2', value: 'MEETING', label: 'Meeting', position: 1 },
      { id: 's1', value: 'NEW', label: 'New', position: 0 },
      { id: 's3', value: 'DONE', label: 'Done', position: 2 },
    ] },
  ] },
};
const settings = JSON.stringify([
  { id: 'ALPHA', description: 'First workflow', closingSteps: ['DONE'] },
  { id: 'BETA', description: 'Second workflow', closingSteps: ['DONE'] },
]);

function client(overrides: Partial<TwentyTracksClient> = {}): TwentyTracksClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/metadata/fields') return fields;
      if (path.startsWith('/opportunities?')) return { data: { opportunities: [
        { id: 'open-1', brand: 'ALPHA', stage: 'MEETING', pointOfContactId: 'person-1', createdAt: '2026-10-20T12:00:00Z' },
        { id: 'closed-1', brand: 'ALPHA', stage: 'DONE', pointOfContactId: 'person-1', createdAt: '2026-10-19T12:00:00Z' },
      ] } };
      if (path === '/opportunities/open-1') return { data: { opportunity: { id: 'open-1', brand: 'ALPHA', stage: 'MEETING' } } };
      throw new Error(`unexpected GET ${path}`);
    }) as TwentyTracksClient['get'],
    post: vi.fn(async () => ({ data: { opportunity: { id: 'created-1' } } })) as TwentyTracksClient['post'],
    patch: vi.fn(async () => ({})) as TwentyTracksClient['patch'],
    now: () => new Date('2026-10-26T12:00:00Z'),
    ...overrides,
  };
}

describe('Twenty Tracks adapter', () => {
  afterEach(() => { delete process.env.CRM_BRANDS; });

  it('parses option values in the metadata-defined order', () => {
    const schema = parseTwentyOpportunitySchema(fields);
    expect(schema.stage.options.map((option) => option.value)).toEqual(['NEW', 'MEETING', 'DONE']);
  });

  it('lists only live metadata tracks and requires exact configured closers', async () => {
    process.env.CRM_BRANDS = settings;
    const api = client();
    const home = new TwentyTracksHome(api);
    await expect(home.listTracks()).resolves.toMatchObject([
      { id: 'ALPHA', name: 'Alpha', purpose: 'First workflow', steps: ['NEW', 'MEETING', 'DONE'], closingSteps: ['DONE'] },
      { id: 'BETA', name: 'Beta', purpose: 'Second workflow' },
    ]);
    await home.listTracks();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a closing option is missing or stale', async () => {
    process.env.CRM_BRANDS = JSON.stringify([{ id: 'ALPHA', description: 'one', closingSteps: ['WON'] }]);
    await expect(new TwentyTracksHome(client()).listTracks()).rejects.toThrow(/exact current stage option values: NEW, MEETING, DONE/);
  });

  it('fails closed when local annotations refer to a track removed from Twenty', async () => {
    process.env.CRM_BRANDS = JSON.stringify([
      { id: 'ALPHA', description: 'one', closingSteps: ['DONE'] },
      { id: 'REMOVED', description: 'stale', closingSteps: ['DONE'] },
    ]);
    await expect(new TwentyTracksHome(client()).listTracks()).rejects.toThrow(/no longer matches a current brand option/);
  });

  it('lists only open items and filters by the exact track and person', async () => {
    process.env.CRM_BRANDS = settings;
    const api = client();
    const items = await new TwentyTracksHome(api).listItems('ALPHA', { personId: 'person-1' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'open-1', trackId: 'ALPHA', step: 'MEETING', who: { personId: 'person-1' } });
    expect(api.get).toHaveBeenLastCalledWith('/opportunities?filter=brand%5Beq%5D%3AALPHA&filter=pointOfContactId%5Beq%5D%3Aperson-1&limit=100');
  });

  it('routes a create through metadata validation and the existing approval-gated caller', async () => {
    process.env.CRM_BRANDS = settings;
    const api = client();
    const home = new TwentyTracksHome(api);
    await expect(home.createOpportunity({ name: 'Alpha intro', brand: 'ALPHA', stage: 'MEETING', pointOfContactId: 'person-1' })).resolves.toMatchObject({ id: 'created-1' });
    await expect(home.createOpportunity({ name: 'bad', brand: 'ALPHA', stage: 'MISSING' })).rejects.toThrow('Twenty track or step is unavailable');
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('rechecks the current item track before applying an exact live step', async () => {
    process.env.CRM_BRANDS = settings;
    const api = client();
    const home = new TwentyTracksHome(api);
    await expect(home.setOpportunityStage('open-1', 'DONE')).resolves.toBeUndefined();
    await expect(home.setOpportunityStage('open-1', 'MISSING')).rejects.toThrow('Twenty track or step is unavailable');
    expect(api.patch).toHaveBeenCalledTimes(1);
  });
});
