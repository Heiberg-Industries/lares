/** Internal read contract only. Results contain private third-party text; the eventual caller
 * must quote/bound it and taint its turn before exposing it. No query language or URLs cross here.
 */
import { z } from 'zod';
import type { MailMessage } from './google.js';
export const opaqueId = z.string().min(1).max(2048).refine(id => !/[\x00-\x20\x7f]/.test(id) && id !== '.' && id !== '..');
export const readWindowSchema = z.strictObject({
  from: z.iso.datetime({offset:true}), until: z.iso.datetime({offset:true}), limit: z.number().int().min(1).max(100).default(25),
}).refine(w => Date.parse(w.until) > Date.parse(w.from) && Date.parse(w.until)-Date.parse(w.from) <= 31*86_400_000);
export type ReadWindow = z.infer<typeof readWindowSchema>;
export interface ReadPage<T> { items: T[]; truncated: boolean }
export interface MailReference { id: string; receivedAt: string }
export interface PrivateMail extends Pick<MailMessage,'id'|'bodyText'> {
  threadId: string|null; from: string|null; to: string[]|null; cc: string[]|null;
  subject: string|null; sentAt: string|null;
}
export interface PrivateEvent {
  id: string; summary: string|null; start: string; end: string;
  startTimeZone: string|null; endTimeZone: string|null; allDay: boolean|null;
  location: string|null; cancelled: boolean|null;
}
export interface PersonalReadAdapter {
  listMail(window: ReadWindow): Promise<ReadPage<MailReference>>;
  readMail(id: string): Promise<PrivateMail|null>;
  listCalendar(calendarId: string, window: ReadWindow): Promise<ReadPage<PrivateEvent>>;
}
export class PersonalReadError extends Error { constructor() { super('Selected private resource is unavailable or authority changed'); } }
export function inWindow(at: string, window: ReadWindow) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) throw new PersonalReadError();
  return time >= Date.parse(window.from) && time < Date.parse(window.until);
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new PersonalReadError();
  return new Date(value).toISOString();
}
export function requiredId(value: unknown): string { return opaqueId.parse(value); }

export function optionalText(value:unknown):string|null { return typeof value==='string'?value:null; }
