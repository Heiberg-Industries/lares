import { lstatSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { INTEGRATION_SECRET_FILES as FROM_INTEGRATIONS } from '@lares/agent-kit/integration-secrets';

// Only the root-owned installation config supplies these bindings. Definitions and
// Console actions cannot mount host paths, replace core settings or choose credentials.
const path = z.string().refine(s => isAbsolute(s) && normalize(s) === s && !/[\r\n\0$]/.test(s));
const text = z.string().min(1).max(2048).refine(s => !/[\r\n\0$]/.test(s));
const environmentKeys = [
  'ATLAS_PATH', 'VAULT_PATH', 'MARCEL_DATA_ROOT', 'TASTE_ROOT', 'TRAVEL_PATH', 'NETWORK_DB_PATH',
  'BRIEF_PICKS_DIR', 'TZ', 'OWNER_HOME_TZ', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'STUDIO_MODEL', 'MARCEL_MODEL_BRAIN',
  'MARCEL_MODEL_GATE', 'KARAKEEP_URL', 'SIGNAL_SPINE_URL', 'SIGNAL_PROJECT',
  'WEEKLY_SUMMARY_HOUR', 'ROUTE_HOURS', 'EVE_DREAM_LIVE', 'EVE_DIGEST_LIVE',
  'DIGEST_SLACK_TARGET', 'TELEGRAM_BOT_USERNAME', 'GOOGLE_PRINCIPAL_ID', 'GOOGLE_ORG',
  // W8B-s5. Who may answer an approval in web chat, on an installation whose agents are NOT a
  // managed incarnation — a managed one is given LARES_CONSOLE_PRINCIPAL below instead, from the
  // owner claim, exactly as the Slack and Telegram principals are. Unset admits nobody.
  'CONSOLE_ALLOWED_EMAILS',
] as const;
// Targets preserve the existing adapters' file-first contracts. No raw secret values.
//
// PLATFORM secrets: the ones that are not an integration with a vendor at the other end — the
// agent's own HTTP route password, the key its stored OAuth tokens are encrypted at rest with,
// and the tracing keys. They belong to the engine, so they are declared HERE by hand and never
// in `integrations/installation.json` (installation data, which leaves this repo in wave 9 —
// taking these with it would leave every installation unable to mount them). Two route-password
// keys exist because one role still reads a persona-named variable; both mount one file.
const PLATFORM_SECRET_FILES = {
  LANGFUSE_KEY_FILE: 'langfuse-keys',
  EVE_SAGA_ROUTE_PASSWORD_FILE: 'eve-route-password', EVE_ROUTE_PASSWORD_FILE: 'eve-route-password',
  TOKEN_ENC_KEY_FILE: 'token-enc-key',
} as const;
// The integration half is GENERATED from `integrations/installation.json` (LAR-76): one source,
// one command (`pnpm -C packages/agent-kit run generate:connections`), one staleness test, and
// the console's list can no longer disagree with what is actually mountable. The keeper reads
// the generated TypeScript module, never `integrations/` — that folder is in no runtime image.
export const INTEGRATION_SECRET_FILES = { ...FROM_INTEGRATIONS, ...PLATFORM_SECRET_FILES } as const;
const secretKeys = Object.keys(INTEGRATION_SECRET_FILES) as [keyof typeof INTEGRATION_SECRET_FILES, ...(keyof typeof INTEGRATION_SECRET_FILES)[]];
export const runtimeBindingsSchema = z.object({
  role: z.enum(['creative', 'travel', 'chief-of-staff']),
  // Existing owner-clock/proactivity namespace; distinct from the Console login email.
  ownerId: text.optional(),
  environment: z.partialRecord(z.enum(environmentKeys), text),
  mounts: z.array(z.object({ source: path, target: path.refine(s => s.startsWith('/srv/') || s.startsWith('/data/') || s === '/etc/gitconfig'), readOnly: z.boolean() }).strict()),
  secrets: z.partialRecord(z.enum(secretKeys), path),
  // Existing workflow-file storage is retained, never recreated or deleted by keeper.
  workflowVolume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).optional(),
  // Retained sessions may remember a pre-rename sandbox root. Never mask a current role.
  legacySandboxRoots: z.array(z.string().regex(/^\/app\/services\/[a-z][a-z0-9-]{1,63}$/)
    .refine(s => !['creative','travel','chief-of-staff','keeper','console'].some(role => s === `/app/services/${role}`)))
    .max(3).optional(),
}).strict().superRefine((b, ctx) => {
  const targets = b.mounts.map(m => m.target);
  if (b.mounts.some(m => m.target === '/etc/gitconfig' && !m.readOnly))
    ctx.addIssue({code:'custom',message:'Git configuration must be read-only'});
  if (targets.some((t, i) => targets.some((other, j) => i !== j && (t === other || t.startsWith(other + '/')))))
    ctx.addIssue({code:'custom',message:'Overlapping runtime mounts'});
  // Chief's Google authority comes only from the managed selected-mailbox contract.
  if (b.role !== 'travel' && (Object.keys(b.environment).some(k => k.startsWith('GOOGLE_')) || Object.keys(b.secrets).some(k => k.startsWith('GOOGLE_CLIENT_') || k === 'TOKEN_ENC_KEY_FILE')))
    ctx.addIssue({code:'custom',message:'Google bindings are reserved for the travel read-only adapter'});
  for (const [key,value] of Object.entries(b.environment)) {
    if (key.endsWith('_URL')) {
      try { const u = new URL(value!); if(u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error(); }
      catch { ctx.addIssue({code:'custom',message:'Invalid integration URL'}); }
    }
    if (['ATLAS_PATH','VAULT_PATH','MARCEL_DATA_ROOT','TASTE_ROOT','TRAVEL_PATH','NETWORK_DB_PATH','BRIEF_PICKS_DIR'].includes(key)) {
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
