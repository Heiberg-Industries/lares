/** Closed provider permission profiles. Provider consent never grants engine write authority. */
export type PersonalConsentPower = 'read' | 'read+mail-send';
export function personalConsentPower(value: unknown): PersonalConsentPower {
  if (value === 'read' || value === 'read+mail-send') return value;
  throw new Error('Invalid personal consent power');
}
// openid validates issuer+subject through the OIDC library; the verified Gmail profile supplies
// the display address. Neither an email/profile scope nor identity-by-email is needed.
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
// https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/get
export const GOOGLE_PERSONAL_READ_SCOPES = ['openid', 'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly'] as const;
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
export function googlePersonalConsentScopes(power: PersonalConsentPower): readonly string[] {
  return personalConsentPower(power) === 'read' ? GOOGLE_PERSONAL_READ_SCOPES : [...GOOGLE_PERSONAL_READ_SCOPES, GMAIL_SEND];
}
// Prior verified consent may carry these known broader powers. Preserve actual scopes;
// accepting them for reads is never an engine authorization decision.
const GOOGLE_ALLOWED = [...GOOGLE_PERSONAL_READ_SCOPES, GMAIL_SEND, 'email', 'profile',
  'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/', 'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive.readonly'];
export function validateGooglePersonalScopes(scopes: readonly string[], power: PersonalConsentPower): void {
  personalConsentPower(power);
  if (!Array.isArray(scopes) || scopes.length > GOOGLE_ALLOWED.length || scopes.some(s => typeof s !== 'string' || !GOOGLE_ALLOWED.includes(s))) throw new Error('Consent scopes refused');
  const has = (...options: string[]) => options.some(s => scopes.includes(s));
  const fullMail = has('https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/');
  if (!has('openid') || !(fullMail || has(GOOGLE_PERSONAL_READ_SCOPES[1])) ||
    !has(GOOGLE_PERSONAL_READ_SCOPES[2], 'https://www.googleapis.com/auth/calendar') ||
    (power === 'read+mail-send' && !(fullMail || has(GMAIL_SEND, 'https://www.googleapis.com/auth/gmail.compose')))) throw new Error('Consent scopes incomplete');
}
export const MICROSOFT_PERSONAL_READ_SCOPES = ['openid', 'offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'] as const;
const MICROSOFT_ALLOWED = [...MICROSOFT_PERSONAL_READ_SCOPES, 'profile', 'email', 'Mail.Send'];
export function microsoftPersonalConsentScopes(power: PersonalConsentPower): readonly string[] {
  return personalConsentPower(power) === 'read' ? MICROSOFT_PERSONAL_READ_SCOPES : [...MICROSOFT_PERSONAL_READ_SCOPES, 'Mail.Send'];
}
/** Known broader carryover is retained honestly. Unknown, shared and application scopes refuse. */
export function normalizeMicrosoftPersonalScopes(scopes: readonly string[], power: PersonalConsentPower = 'read'): string[] {
  personalConsentPower(power);
  if (!Array.isArray(scopes) || scopes.length > MICROSOFT_ALLOWED.length || scopes.some(s => typeof s !== 'string' || s.length > 128)) throw new Error('Consent scopes refused');
  const normalized = [...new Set(scopes.map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//, '')))].sort();
  if (['User.Read', 'Mail.Read', 'Calendars.Read', ...(power === 'read+mail-send' ? ['Mail.Send'] : [])].some(s => !normalized.includes(s)) ||
    normalized.some(s => !MICROSOFT_ALLOWED.includes(s))) throw new Error('Consent scopes incomplete');
  return normalized;
}
