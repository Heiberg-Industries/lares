/** Root-owned Google client sources. Definitions select capability, never host files or actors. */
import { lstatSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { AgentDefinition } from '@lares/agent-kit/definition';
import { autonomyOf, grantFor } from '@lares/agent-kit/manifest';
const path = z.string().refine(s => isAbsolute(s) && normalize(s) === s && !/[\r\n\0$]/.test(s));
/** Matches canonical persisted org IDs from console discovery; never silently lowercase aliases. */
export const personalGoogleSchema = z.object({
  tokenKeyFile: path,
  clients: z.record(z.string().regex(/^[a-z0-9]{1,32}$/), z.object({ clientIdFile: path, clientSecretFile: path }).strict())
    .refine(clients => Object.keys(clients).length > 0 && Object.keys(clients).length <= 32),
}).strict();
export type PersonalGoogleConfig = z.infer<typeof personalGoogleSchema>;
/** Preserve historical native-only org keys without granting them personal credential access.
 * Never normalize them into another account's canonical client. Refuse over-capacity canonical
 * registries rather than truncate; an all-legacy configuration supplies no personal registry.
 */
export function personalGoogleConfig(config: {tokenKeyFile: string; clients: PersonalGoogleConfig['clients']} | undefined): PersonalGoogleConfig | undefined {
  if (!config) return undefined;
  const clients = Object.fromEntries(Object.entries(config.clients).filter(([org]) => /^[a-z0-9]{1,32}$/.test(org)));
  if (!Object.keys(clients).length) return undefined;
  return personalGoogleSchema.parse({tokenKeyFile: config.tokenKeyFile, clients});
}
export function personalGoogleEnabled(d: AgentDefinition): boolean {
  return d.role === 'chief-of-staff' && ['gmail', 'personal_mailbox', 'personal_calendar'].some(capability => {
    const grant = grantFor(d, capability);
    return !!grant && grant.scope !== 'none' && autonomyOf(d, capability) !== 'never';
  });
}
type GoogleSources = { personalGoogle?: PersonalGoogleConfig; email?: {tokenKeyFile: string; clientIdFile: string; clientSecretFile: string} };
/** One inventory for compose, reconciliation and credential-operation preflight/rollback. */
export function googleSecretFiles(a: GoogleSources): string[] {
  const personal = a.personalGoogle ? personalGoogleSchema.parse(a.personalGoogle) : undefined;
  if (personal && a.email && personal.tokenKeyFile !== a.email.tokenKeyFile)
    throw new Error('Conflicting Google token encryption sources');
  return [...new Set([
    ...(a.email ? [a.email.tokenKeyFile, a.email.clientIdFile, a.email.clientSecretFile] : []),
    ...(personal ? [personal.tokenKeyFile, ...Object.keys(personal.clients).sort().flatMap(org =>
      [personal.clients[org]!.clientIdFile, personal.clients[org]!.clientSecretFile])] : []),
  ])];
}
export function verifyGoogleSecretSources(a: GoogleSources): void {
  try {
    for (const file of googleSecretFiles(a)) {
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !st.size) throw new Error();
    }
  } catch { throw new Error('Google runtime files unavailable or conflicting'); }
}
