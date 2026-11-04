import { credentialActor } from './credentials';
import { keeper } from './keeper-client';

export interface MeetingsSourceView { value: string | null; from: 'console' | 'installation file' | 'none'; canChange: boolean; chiefCount: number }

/** One keeper read per page render. Null means it could not be read (no session, keeper down). */
export async function getMeetingsSourceView(): Promise<MeetingsSourceView | null> {
  const actor = await credentialActor();
  if (!actor) return null;
  try { return await keeper<MeetingsSourceView>('settings.notion_meetings_get', {}, actor); }
  catch { return null; }
}
