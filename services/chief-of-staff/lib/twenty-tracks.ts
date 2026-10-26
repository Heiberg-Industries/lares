import type { FindWhoResult, Track, TrackItem, TrackWho, TracksHome } from '@lares/agent-kit/tracks';
import { twentyGet, twentyPatch, twentyPost } from './twenty-client.js';
import { crmBrands } from './crm-brands.js';
import { twentyLookup } from '../catalogue/twenty_lookup.js';

const METADATA_TTL_MS = 30_000;

type SelectOption = { id: string; label: string; value: string; position: number };
type SelectField = { name: string; objectName: string; options: SelectOption[] };
type OpportunitySchema = { brand: SelectField; stage: SelectField };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseOptions(value: unknown, fieldName: string): SelectOption[] {
  if (!Array.isArray(value)) throw new Error(`Twenty ${fieldName} field has no select options`);
  const options = value.map((raw): SelectOption => {
    const option = record(raw);
    if (!option || typeof option.value !== 'string' || option.value.length === 0 ||
        typeof option.label !== 'string' || option.label.length === 0 ||
        typeof option.id !== 'string' || !Number.isFinite(option.position)) {
      throw new Error(`Twenty ${fieldName} field metadata is invalid`);
    }
    return { id: option.id, label: option.label, value: option.value, position: option.position as number };
  });
  if (options.length === 0 || new Set(options.map((o) => o.value)).size !== options.length) {
    throw new Error(`Twenty ${fieldName} field metadata is invalid`);
  }
  if (new Set(options.map((o) => o.position)).size !== options.length) {
    throw new Error(`Twenty ${fieldName} field metadata has ambiguous option positions`);
  }
  return options.sort((a, b) => a.position - b.position);
}

/** Parse only the opportunity SELECT fields needed by the adapter; fixtures are synthetic, not live evidence. */
export function parseTwentyOpportunitySchema(raw: unknown): OpportunitySchema {
  const data = record(record(raw)?.data);
  const fields = data?.fields;
  if (!Array.isArray(fields)) throw new Error('Twenty metadata response has no fields array');
  const selected = new Map<string, SelectField>();
  for (const rawField of fields) {
    const field = record(rawField);
    if (!field || typeof field.name !== 'string') continue;
    const objectMetadata = record(field.objectMetadata);
    const objectName = String(field.objectName ?? field.object ?? objectMetadata?.nameSingular ?? objectMetadata?.name ?? '').toLowerCase();
    if (objectName !== 'opportunity' && objectName !== 'opportunities') continue;
    if (field.name !== 'brand' && field.name !== 'stage') continue;
    selected.set(field.name, {
      name: field.name,
      objectName,
      options: parseOptions(field.options, field.name),
    });
  }
  const brand = selected.get('brand'), stage = selected.get('stage');
  if (!brand || !stage) throw new Error('Twenty opportunity metadata must contain brand and stage select fields');
  return { brand, stage };
}

function configuredClosers(env: Record<string, string | undefined> = process.env): Map<string, string[]> {
  const closers = new Map<string, string[]>();
  const raw = env.CRM_BRANDS;
  if (!raw) return closers;
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { return closers; }
  if (!Array.isArray(entries)) return closers;
  for (const entry of entries) {
    const item = record(entry);
    if (typeof item?.id !== 'string' || !Array.isArray(item.closingSteps) ||
        item.closingSteps.length === 0 || item.closingSteps.some((step) => typeof step !== 'string' || step.length === 0)) continue;
    closers.set(item.id, item.closingSteps as string[]);
  }
  return closers;
}

function mapTracks(schema: OpportunitySchema, env: Record<string, string | undefined> = process.env): Track[] {
  const annotations = crmBrands(env);
  const liveTrackValues = new Set(schema.brand.options.map((option) => option.value));
  for (const annotation of annotations) {
    if (!liveTrackValues.has(annotation.id)) {
      throw new Error(`Twenty track annotation "${annotation.id}" no longer matches a current brand option; current values: ${schema.brand.options.map((option) => option.value).join(', ')}`);
    }
  }
  const descriptions = new Map(annotations.map((brand) => [brand.id, brand.description]));
  const closingByTrack = configuredClosers(env);
  const stepValues = new Set(schema.stage.options.map((option) => option.value));
  return schema.brand.options.map((option) => {
    const closingSteps = closingByTrack.get(option.value);
    if (!closingSteps || closingSteps.some((step) => !stepValues.has(step))) {
      throw new Error(`Twenty track "${option.value}" needs closingSteps in CRM_BRANDS using exact current stage option values: ${schema.stage.options.map((s) => s.value).join(', ')}`);
    }
    return {
      id: option.value,
      name: option.label,
      purpose: descriptions.get(option.value) ?? '',
      steps: schema.stage.options.map((step) => step.value),
      closingSteps,
    };
  });
}

type TwentyOpportunity = {
  id: string;
  name?: string;
  stage?: string;
  brand?: string;
  pointOfContactId?: string | null;
  companyId?: string | null;
  createdAt?: string;
  description?: string;
};

function itemFromOpportunity(trackId: string, opportunity: TwentyOpportunity): TrackItem {
  const since = opportunity.createdAt?.slice(0, 10);
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) {
    throw new Error('Twenty opportunity has no valid creation date');
  }
  const who: TrackWho = {};
  if (opportunity.pointOfContactId) who.personId = opportunity.pointOfContactId;
  if (opportunity.companyId) who.organisationId = opportunity.companyId;
  return {
    id: opportunity.id,
    trackId,
    who,
    step: opportunity.stage ?? '',
    since,
    note: opportunity.description ?? opportunity.name ?? '',
    sourceSignal: `twenty:${opportunity.id}`,
  };
}

export interface TwentyTracksClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  now(): Date;
}

const defaultClient: TwentyTracksClient = { get: twentyGet, post: twentyPost, patch: twentyPatch, now: () => new Date() };

/** Twenty-backed Tracks home. Metadata supplies all track and step values; local settings only annotate them. */
export class TwentyTracksHome implements TracksHome {
  private schemaCache?: { expiresAt: number; value: Promise<OpportunitySchema> };

  constructor(private readonly client: TwentyTracksClient = defaultClient, private readonly env: Record<string, string | undefined> = process.env) {}

  private async schema(): Promise<OpportunitySchema> {
    if (this.schemaCache && this.schemaCache.expiresAt > this.client.now().getTime()) return this.schemaCache.value;
    const value = this.client.get<unknown>('/metadata/fields').then(parseTwentyOpportunitySchema);
    this.schemaCache = { expiresAt: this.client.now().getTime() + METADATA_TTL_MS, value };
    try { return await value; } catch (error) { this.schemaCache = undefined; throw error; }
  }

  async listTracks(): Promise<Track[]> { return mapTracks(await this.schema(), this.env); }

  async findWho(query: string): Promise<FindWhoResult> {
    try {
      const found = await twentyLookup(query);
      if (found.people[0]) return { state: 'found', who: { personId: found.people[0].id } };
      if (found.companies[0]) return { state: 'found', who: { organisationId: found.companies[0].id } };
      return { state: 'empty' };
    } catch (error) {
      return { state: 'failed', reason: error instanceof Error ? error.message : 'Twenty lookup failed' };
    }
  }

  async listItems(trackId: string, who?: TrackWho): Promise<TrackItem[]> {
    const track = (await this.listTracks()).find((candidate) => candidate.id === trackId);
    if (!track) throw new Error('Twenty track is unavailable');
    const filters = [`brand[eq]:${trackId}`];
    if (who?.personId) filters.push(`pointOfContactId[eq]:${who.personId}`);
    if (who?.organisationId) filters.push(`companyId[eq]:${who.organisationId}`);
    const path = `/opportunities?filter=${filters.map(encodeURIComponent).join('&filter=')}&limit=100`;
    const response = await this.client.get<{ data?: { opportunities?: TwentyOpportunity[] } }>(path);
    return (response.data?.opportunities ?? [])
      .filter((opportunity) => opportunity.brand === track.id)
      .filter((opportunity) => !track.closingSteps.includes(opportunity.stage ?? ''))
      .map((opportunity) => itemFromOpportunity(track.id, opportunity));
  }

  async addItem(trackId: string, who: TrackWho, step: string, note: string, _sourceSignal: string): Promise<TrackItem> {
    const track = (await this.listTracks()).find((candidate) => candidate.id === trackId);
    if (!track || !track.steps.includes(step)) throw new Error('Twenty track or step is unavailable');
    if (!who.personId && !who.organisationId) throw new Error('Twenty track items need a person or organisation');
    const created = await this.createOpportunity({
      name: note.trim() || `${track.name} — ${who.personId ?? who.organisationId}`,
      brand: trackId,
      stage: step,
      ...(who.personId ? { pointOfContactId: who.personId } : {}),
      ...(who.organisationId ? { companyId: who.organisationId } : {}),
    });
    return itemFromOpportunity(trackId, { ...created, pointOfContactId: who.personId, companyId: who.organisationId });
  }

  async moveItem(itemId: string, step: string, note: string, _sourceSignal: string, expectedTrackId?: string): Promise<TrackItem> {
    const current = await this.getOpportunity(itemId);
    if (expectedTrackId !== undefined && current.brand !== expectedTrackId) throw new Error('Twenty opportunity track changed');
    const track = (await this.listTracks()).find((candidate) => candidate.id === current.brand);
    if (!track || !track.steps.includes(step)) throw new Error('Twenty track or step is unavailable');
    await this.setOpportunityStage(itemId, step, current.brand);
    return itemFromOpportunity(track.id, { ...current, stage: step, description: note || current.description });
  }

  /** Called by the existing approval-gated Twenty tools after their exact approval check. */
  async createOpportunity(input: { name: string; brand: string; stage: string; pointOfContactId?: string; companyId?: string }): Promise<TwentyOpportunity> {
    const track = (await this.listTracks()).find((candidate) => candidate.id === input.brand);
    if (!track || !track.steps.includes(input.stage)) throw new Error('Twenty track or step is unavailable');
    const response = await this.client.post<{ data?: Record<string, TwentyOpportunity> }>('/opportunities', input);
    const opportunity = Object.values(response.data ?? {}).find((candidate) => typeof candidate?.id === 'string');
    if (!opportunity) throw new Error('Twenty create opportunity returned no record id');
    return { ...opportunity, brand: input.brand, stage: input.stage };
  }

  /** Reads the opportunity's current track before moving it, then validates the exact live step. */
  async setOpportunityStage(itemId: string, stage: string, expectedTrackId?: string): Promise<void> {
    const current = await this.getOpportunity(itemId);
    if (!current.brand || (expectedTrackId && current.brand !== expectedTrackId)) throw new Error('Twenty opportunity track changed');
    const track = (await this.listTracks()).find((candidate) => candidate.id === current.brand);
    if (!track || !track.steps.includes(stage)) throw new Error('Twenty track or step is unavailable');
    await this.client.patch(`/opportunities/${encodeURIComponent(itemId)}`, { stage });
  }

  private async getOpportunity(itemId: string): Promise<TwentyOpportunity> {
    const response = await this.client.get<{ data?: { opportunity?: TwentyOpportunity } }>(`/opportunities/${encodeURIComponent(itemId)}`);
    const opportunity = response.data?.opportunity;
    if (!opportunity?.id) throw new Error('Twenty opportunity is unavailable');
    return opportunity;
  }

  async createTrack(_track: Track): Promise<Track> { throw new Error('Create tracks in Twenty; the live metadata owns available tracks'); }
  async setSteps(_trackId: string, _steps: string[], _closingSteps: string[]): Promise<Track> { throw new Error('Change steps in Twenty; the live metadata owns available steps'); }
}
