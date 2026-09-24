import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentDefinition } from '@lares/agent-kit/definition';
import { pool } from './db';
export type Role = 'chief-of-staff' | 'creative' | 'travel';
export interface StartingPoint { id: Role; label: string; description: string; capabilities: string[]; schedules: string[]; definition: AgentDefinition }
export interface Capacity { ceiling: number | null; activeCount: number; approved: boolean; creationAvailable: boolean }
export interface RuntimeState { pending: boolean; reason: string | null }
// Optional status permits a Console upgrade before its keeper. ok means a Git push occurred,
// not whether the local save succeeded; disabled is an ordinary informational state.
export interface DefinitionBackup { ok: boolean; status?: 'saved' | 'disabled' | 'failed'; message?: string }
export interface RetirementResult { name: string; status: "retired"; archive: string; backup: DefinitionBackup }
export interface DefinitionResult { name: string; hash: string; backup: DefinitionBackup; runtime?: RuntimeState }
const ROLES: { id: Role; label: string; description: string }[] = [
  { id:'chief-of-staff',label:'Chief of staff',description:'Briefings, calendar, mail and follow-ups.' },
  { id:'creative',label:'Creative',description:'Writing, ideas and creative work.' },
  { id:'travel',label:'Travel',description:'Journeys, places and travel planning.' },
];
export function startingPoints(): StartingPoint[] {
  // Next standalone starts in services/console, just like pnpm -C in development.
  const root = resolve(process.cwd(), '../../packages/agent-kit/templates');
  return ROLES.map(role => {
    const definition = JSON.parse(readFileSync(resolve(root, role.id, 'definition.json'), 'utf8')) as AgentDefinition;
    return { ...role, definition, capabilities: definition.grants.map(g=>g.capability), schedules: Object.keys(definition.schedules) };
  });
}
export function modelAliases(prefix: string): { alias: string; label: string; when: string }[] {
  if (!/^[a-z0-9]+$/.test(prefix) || prefix === 'installation') throw new Error('Configure models.alias_prefix with the installation gateway purpose prefix.');
  return [
    ['brain','Brain','General reasoning and everyday agent work.'],
    ['writer','Writer','Writing and editing.'],
    ['utility','Utility','Small, routine tasks.'],
    ['gate','Gate','Classification and routing.'],
    ['embed','Embed','Embedding work; requires a compatible gateway mapping.'],
  ].map(([purpose,label,when])=>({alias:`${prefix}-${purpose}`,label,when}));
}
const CONVERSATION = 'Takes effect at its next conversation. On a direct-message door a conversation lasts the day, so that usually means tomorrow — or start a fresh one now.';
export function takesEffect(field: string): string {
  if(field === 'autonomy') return 'Takes effect at its next action.';
  if(field === 'schedules') return 'Takes effect the next time it runs.';
  if(field === 'doors') return 'Apply connection changes to activate saved connections. This restarts the agent.';
  if(field === 'name' || field === 'startingPoint') return 'Set when the agent is created; it cannot change here later.';
  return CONVERSATION;
}
/** Compare fingerprints, never session timestamps: rememberValid refreshes valid_at each start.
 * Fixed-format keeper evidence avoids casting historical free-text audit detail to JSON.
 * A flag only; hand editing remains allowed. */
export async function editedOutsideTheConsole(name: string): Promise<{ at: string } | null> {
  const { rows } = await pool.query<{ valid_at: string }>(`
    SELECT d.valid_at FROM agent_definitions d WHERE d.name = $1
    AND COALESCE((SELECT k.detail FROM keeper_audit k
      WHERE k.action IN ('definition.save', 'definition.create') AND k.outcome = 'ok'
      AND k.input->>'name' = d.name ORDER BY COALESCE(k.completed_at, k.at) DESC, k.id DESC LIMIT 1), '') <> '{"hash":"' || d.hash || '"}' `, [name]);
  return rows[0] ? { at: new Date(rows[0].valid_at).toISOString() } : null;
}

/** Authenticate server-rendered builder reads as well as every action. */
export async function builderData(name?: string) {
  const [{cookies},{verify},{keeper},{getBoardRows}] = await Promise.all([
    import('next/headers'),import('./auth'),import('./keeper-client'),import('./board'),
  ]);
  const email=await verify((await cookies()).get('lares_session')?.value);
  if(!email) throw new Error('unauthenticated');
  const prefix = (await pool.query<{value:unknown}>("SELECT value FROM settings WHERE key='models.alias_prefix'")).rows[0]?.value;
  const aliases=modelAliases(typeof prefix === 'string' ? prefix : '');
  const points=startingPoints();
  const [capacity,list]=await Promise.all([
    keeper<Capacity>('definition.capacity',{},email),
    keeper<{name:string;hash:string;status:string}[]>('definition.list',{},email),
  ]);
  const timing=Object.fromEntries(['name','gender','description','startingPoint','duties','voice','language','model','grants','skills','autonomy','schedules','doors'].map(f=>[f,takesEffect(f)]));
  if(!name) return {startingPoints:points,aliases,capacity,timing};
  const entry=list.find(a=>a.name===name);
  if(!entry) throw new Error('Agent definition not found.');
  const [saved,permissions]=await Promise.all([
    keeper<{definition:string;duties:string;voice:string;runtime?:RuntimeState}>('definition.get',{name},email),
    getBoardRows(),
  ]);
  return {publicDoorOrigin:process.env.LARES_PUBLIC_DOOR_ORIGIN??'',startingPoints:points,aliases,capacity,timing,initial:{...saved,definition:JSON.parse(saved.definition) as AgentDefinition,hash:entry.hash,status:entry.status},permissions:permissions.filter(p=>p.agent===name)};
}
