/** Closed provider permission profiles. Provider consent never grants engine write authority. */
export type PersonalConsentPower = 'read' | 'read+mail-send' | 'read+mail-draft';
export function personalConsentPower(value: unknown): PersonalConsentPower {
  if (value === 'read' || value === 'read+mail-send' || value === 'read+mail-draft') return value;
  throw new Error('Invalid personal consent power');
}
// openid validates issuer+subject through the OIDC library; the verified Gmail profile supplies
// the display address. Neither an email/profile scope nor identity-by-email is needed.
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
// https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/get
export const GOOGLE_PERSONAL_READ_SCOPES = ['openid', 'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly'] as const;
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
export function googlePersonalConsentScopes(power: PersonalConsentPower): readonly string[] {
  const checked = personalConsentPower(power);
  if (checked === 'read') return GOOGLE_PERSONAL_READ_SCOPES;
  if (checked === 'read+mail-send') return [...GOOGLE_PERSONAL_READ_SCOPES, GMAIL_SEND];
  // "Read + drafts" also reads Drive files (read-only) and manages calendar events (each one approved by the
  // owner in chat). An account consented before either was added still validates for this power:
  // validateGooglePersonalScopes requires neither scope.
  if (checked === 'read+mail-draft') return [...GOOGLE_PERSONAL_READ_SCOPES, GMAIL_COMPOSE, DRIVE_READONLY, CALENDAR_EVENTS];
  throw new Error('Invalid personal consent power');
}
// Prior verified consent may carry these known broader powers. Preserve actual scopes;
// accepting them for reads is never an engine authorization decision.
const GOOGLE_ALLOWED = [...GOOGLE_PERSONAL_READ_SCOPES, GMAIL_SEND, 'email', 'profile',
  'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile',
  GMAIL_COMPOSE, 'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/', CALENDAR_EVENTS,
  'https://www.googleapis.com/auth/calendar', DRIVE_READONLY];
export function validateGooglePersonalScopes(scopes: readonly string[], power: PersonalConsentPower): void {
  personalConsentPower(power);
  if (!Array.isArray(scopes) || scopes.length > GOOGLE_ALLOWED.length || scopes.some(s => typeof s !== 'string' || !GOOGLE_ALLOWED.includes(s))) throw new Error('Consent scopes refused');
  const has = (...options: string[]) => options.some(s => scopes.includes(s));
  const fullMail = has('https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/');
  if (!has('openid') || !(fullMail || has(GOOGLE_PERSONAL_READ_SCOPES[1])) ||
    !has(GOOGLE_PERSONAL_READ_SCOPES[2], 'https://www.googleapis.com/auth/calendar') ||
    (power === 'read+mail-send' && !(fullMail || has(GMAIL_SEND, GMAIL_COMPOSE))) ||
    // Drafts need compose (or a broader mail scope); gmail.send alone cannot create or update a draft.
    (power === 'read+mail-draft' && !(fullMail || has(GMAIL_COMPOSE)))) throw new Error('Consent scopes incomplete');
}
export const MICROSOFT_PERSONAL_READ_SCOPES = ['openid', 'offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'] as const;
const MICROSOFT_ALLOWED = [...MICROSOFT_PERSONAL_READ_SCOPES, 'profile', 'email', 'Mail.Send'];
export function microsoftPersonalConsentScopes(power: PersonalConsentPower): readonly string[] {
  const checked = personalConsentPower(power);
  if (checked === 'read') return MICROSOFT_PERSONAL_READ_SCOPES;
  if (checked === 'read+mail-send') return [...MICROSOFT_PERSONAL_READ_SCOPES, 'Mail.Send'];
  throw new Error('Microsoft accounts have no draft-only permission');
}
/** Known broader carryover is retained honestly. Unknown, shared and application scopes refuse. */
export function normalizeMicrosoftPersonalScopes(scopes: readonly string[], power: PersonalConsentPower = 'read'): string[] {
  if (personalConsentPower(power) === 'read+mail-draft') throw new Error('Microsoft accounts have no draft-only permission');
  if (!Array.isArray(scopes) || scopes.length > MICROSOFT_ALLOWED.length || scopes.some(s => typeof s !== 'string' || s.length > 128)) throw new Error('Consent scopes refused');
  const normalized = [...new Set(scopes.map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//, '')))].sort();
  if (['User.Read', 'Mail.Read', 'Calendars.Read', ...(power === 'read+mail-send' ? ['Mail.Send'] : [])].some(s => !normalized.includes(s)) ||
    normalized.some(s => !MICROSOFT_ALLOWED.includes(s))) throw new Error('Consent scopes incomplete');
  return normalized;
}
