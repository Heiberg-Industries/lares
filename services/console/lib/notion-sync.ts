import { credentialActor } from './credentials';
import { keeper } from './keeper-client';

export interface NotionSyncCounts { create: number; adoptPatch: number; skip: number; conflict: number }
/** What the keeper reports about the Notion sync (sync.notion_get). Secret-free. */
export interface NotionSyncView {
  canChange: boolean;
  enabled: boolean;
  meetingsDataSource: string | null;
  peopleDataSource: string | null;
  passes: ('attendees' | 'people')[];
  problems: string[];
  keyApplied: boolean;
  hash: string | null;
  preview: { at: string; passes: Record<string, NotionSyncCounts>; current: boolean } | null;
  accepted: boolean;
  running: 'running' | 'stopped' | 'not-created';
  lastRun: string | null;
  phase: 'off' | 'needs-setup' | 'needs-key' | 'needs-preview' | 'ready-to-accept' | 'on';
}

/** One keeper read per page render. Null means it could not be read (no session, keeper down, or this
 * installation's release offers no Notion sync). */
export async function getNotionSyncView(): Promise<NotionSyncView | null> {
  const actor = await credentialActor();
  if (!actor) return null;
  try { return await keeper<NotionSyncView>('sync.notion_get', {}, actor); }
  catch { return null; }
}
