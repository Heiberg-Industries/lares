import { lstatSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { INTEGRATION_SECRET_FILES as FROM_INTEGRATIONS } from '@lares/agent-kit/integration-secrets';
import { PLATFORM_SECRET_FILES } from '@lares/agent-kit/platform-secrets';

// Only the root-owned installation config supplies these bindings. Definitions and
// Console actions cannot mount host paths, replace core settings or choose credentials.
const path = z.string().refine(s => isAbsolute(s) && normalize(s) === s && !/[\r\n\0$]/.test(s));
const text = z.string().min(1).max(2048).refine(s => !/[\r\n\0$]/.test(s));
const environmentKeys = [
  'ATLAS_PATH', 'VAULT_PATH',
  'BRIEF_PICKS_DIR', 'TZ', 'OWNER_HOME_TZ', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'STUDIO_MODEL',
  'KARAKEEP_URL', 'SIGNAL_SPINE_URL', 'SIGNAL_PROJECT',
  'EVE_DREAM_LIVE', 'EVE_DIGEST_LIVE',
  'DIGEST_SLACK_TARGET', 'TELEGRAM_BOT_USERNAME', 'GOOGLE_PRINCIPAL_ID', 'GOOGLE_ORG',
  // Whose Slack sign-in (oauth_tokens principal) the chief of staff reads. A managed one is given
  // it from the owner's register id below; this is the explicit override.
  'SLACK_TOKEN_PRINCIPAL_ID',
  // Where the digest files saved articles: `shared` (the engine default) or `private`. Checked
  // below, so a typo cannot silently mean "shared".
  'LARES_ARTICLE_AREA',
  // The installation's own business data for the chief of staff. The first three are JSON arrays
  // as text: CRM_BRANDS `[{"id":"EXAMPLE_BRAND","description":"..."}]`, COMMERCIAL_BRANDS
  // `["EXAMPLE_BRAND"]`, INSTITUTIONAL_SENDER_DOMAINS `["authority.example"]`. The fourth is the
  // path of a JSON calendar file, which must sit under an explicit mount (checked below).
  'CRM_BRANDS', 'COMMERCIAL_BRANDS', 'INSTITUTIONAL_SENDER_DOMAINS', 'DEADLINE_CALENDAR_FILE',
  // The CRM company field that holds the organisation number (Twenty has no standard one).
  'TWENTY_ORG_NUMBER_FIELD',
  // The Notion database (data source) the meeting follow-up schedule reads meeting notes from.
  // Not a secret; it identifies the installation's own database, so the engine has no default.
  'NOTION_MEETINGS_DATA_SOURCE_ID',
  // W8B-s5. Who may answer an approval in web chat, on an installation whose agents are NOT a
  // managed incarnation — a managed one is given LARES_CONSOLE_PRINCIPAL below instead, from the
  // owner claim, exactly as the Slack and Telegram principals are (or, with no claim yet, from the
  // installation's credential administrator in keeper.json). Unset admits nobody.
  'CONSOLE_ALLOWED_EMAILS',
  // The console's public address, e.g. `https://console.example.com`. A Telegram approval card too
  // long for one message links to its Waiting on you page. Unset: the card says to open the console.
  'LARES_CONSOLE_URL',
] as const;
// Targets preserve the existing adapters' file-first contracts. No raw secret values.
//
// PLATFORM secrets: the ones that are not an integration with a vendor at the other end — the
// agent's own HTTP route password, the key its stored OAuth tokens are encrypted at rest with,
// and the tracing keys. They belong to the engine, so they are declared by hand in the agent kit (`platform-secrets.ts`) and never
// in `integrations/installation.json` (installation data — taking these with it would leave
// every installation unable to mount them).
// The integration half is GENERATED from `integrations/installation.json`: one source,
// one command (`pnpm -C packages/agent-kit run generate:connections`), one staleness test, and
// the console's list can no longer disagree with what is actually mountable. The keeper reads
// the generated TypeScript module, never `integrations/` — that folder is in no runtime image.
export const INTEGRATION_SECRET_FILES = { ...FROM_INTEGRATIONS, ...PLATFORM_SECRET_FILES } as const;
const secretKeys = Object.keys(INTEGRATION_SECRET_FILES) as [keyof typeof INTEGRATION_SECRET_FILES, ...(keyof typeof INTEGRATION_SECRET_FILES)[]];
/** Environment keys that only the removed travel role read. An older keeper.json may still carry
 * them in a binding; they are dropped with a log line so that file keeps loading. */
const RETIRED_ENVIRONMENT_KEYS = new Set(['TASTE_ROOT', 'TRAVEL_PATH']);
function dropRetiredEnvironment(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (RETIRED_ENVIRONMENT_KEYS.has(key)) console.warn(`keeper: ignoring retired environment setting "${key}" in a runtime binding`);
    else kept[key] = entry;
  }
  return kept;
}
/** Roles this engine used to run and no longer does. A stored definition or an old keeper.json
 * may still name one; the keeper skips it with a message instead of failing for every agent. */
export const RETIRED_ROLES: ReadonlySet<string> = new Set(['travel']);
export function isRetiredRole(role: unknown): boolean { return typeof role === 'string' && RETIRED_ROLES.has(role); }
export const runtimeBindingsSchema = z.object({
  role: z.enum(['creative', 'chief-of-staff']),
  // Existing owner-clock/proactivity namespace; distinct from the Console login email.
  ownerId: text.optional(),
  environment: z.preprocess(dropRetiredEnvironment, z.partialRecord(z.enum(environmentKeys), text)),
  mounts: z.array(z.object({ source: path, target: path.refine(s => s.startsWith('/srv/') || s.startsWith('/data/') || s === '/etc/gitconfig'), readOnly: z.boolean() }).strict()),
  secrets: z.partialRecord(z.enum(secretKeys), path),
  // Existing workflow-file storage is retained, never recreated or deleted by keeper.
  workflowVolume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).optional(),
  // Retained sessions may remember a pre-rename sandbox root. Never mask a current role.
  legacySandboxRoots: z.array(z.string().regex(/^\/app\/services\/[a-z][a-z0-9-]{1,63}$/)
    .refine(s => !['creative','chief-of-staff','keeper','console'].some(role => s === `/app/services/${role}`)))
    .max(3).optional(),
}).strict().superRefine((b, ctx) => {
  const targets = b.mounts.map(m => m.target);
  if (b.mounts.some(m => m.target === '/etc/gitconfig' && !m.readOnly))
    ctx.addIssue({code:'custom',message:'Git configuration must be read-only'});
  if (targets.some((t, i) => targets.some((other, j) => i !== j && (t === other || t.startsWith(other + '/')))))
    ctx.addIssue({code:'custom',message:'Overlapping runtime mounts'});
  // Google authority comes only from the managed selected-mailbox contract.
  if (Object.keys(b.environment).some(k => k.startsWith('GOOGLE_')) || Object.keys(b.secrets).some(k => k.startsWith('GOOGLE_CLIENT_') || k === 'TOKEN_ENC_KEY_FILE'))
    ctx.addIssue({code:'custom',message:'Google bindings come only from the managed selected-mailbox contract'});
  for (const [key,value] of Object.entries(b.environment)) {
    if (key === 'LARES_ARTICLE_AREA' && value !== 'shared' && value !== 'private')
      ctx.addIssue({code:'custom',message:'The article area must be shared or private'});
    if (key.endsWith('_URL')) {
      try { const u = new URL(value!); if(u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error(); }
      catch { ctx.addIssue({code:'custom',message:'Invalid integration URL'}); }
    }
    if (['ATLAS_PATH','VAULT_PATH','BRIEF_PICKS_DIR','DEADLINE_CALENDAR_FILE'].includes(key)) {
      if (!path.safeParse(value).success || !targets.some(t => value === t || value!.startsWith(t + '/')))
        ctx.addIssue({code:'custom',message:'Store path must be covered by an explicit mount'});
    }
  }
});
export type RuntimeBindings = z.infer<typeof runtimeBindingsSchema>;
export function bindingsFor(role: string, value: RuntimeBindings | undefined): RuntimeBindings | undefined {
  if (!value) return undefined;
  const bindings = runtimeBindingsSchema.parse(value);
  if (bindings.role !== role) throw new Error('Runtime bindings role mismatch; review installation bindings before changing role');
  return bindings;
}
/** Validate paths on the keeper's same-path, read-only host mounts before any stop.
 * Do not mkdir missing data sources (Docker short bind syntax would hide this failure). */
export function verifyBindingSources(bindings: RuntimeBindings | undefined): void {
  for (const mount of bindings?.mounts ?? []) {
    const st = lstatSync(mount.source);
    if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) throw new Error('Invalid runtime data mount');
  }
}
