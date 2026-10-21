/** Root-owned personal-read sources. Definitions select capabilities, never host files. */
import { lstatSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { AgentDefinition } from '@lares/agent-kit/definition';
import { autonomyOf, grantFor } from '@lares/agent-kit/manifest';
import { googleSecretFiles, type PersonalGoogleConfig } from './personal-google.js';
const path = z.string().refine(s => isAbsolute(s) && normalize(s) === s && !/[\r\n\0$]/.test(s));
export const personalMicrosoftSchema = z.strictObject({tenantIdFile:path,clientIdFile:path,clientSecretFile:path,tokenKeyFile:path});
export type PersonalMicrosoftConfig = z.infer<typeof personalMicrosoftSchema>;
export function personalMicrosoftEnabled(d: AgentDefinition): boolean {
  return d.role === 'chief-of-staff' && ['personal_mailbox','personal_calendar'].some(capability => {
    const grant=grantFor(d,capability);
    return !!grant && grant.scope!=='none' && autonomyOf(d,capability)!=='never';
  });
}
type Sources = {personalMicrosoft?:PersonalMicrosoftConfig;personalGoogle?:PersonalGoogleConfig;email?:{tokenKeyFile:string;clientIdFile:string;clientSecretFile:string}};
/** Console custody uses one encryption key. Distinct provider mounts must name the same source
 * when both are mounted. Microsoft-only installations need no Google configuration. */
export function personalReadSecretFiles(a: Sources): string[] {
  const google=googleSecretFiles(a),ms=a.personalMicrosoft?personalMicrosoftSchema.parse(a.personalMicrosoft):undefined;
  const googleKey=a.personalGoogle?.tokenKeyFile ?? a.email?.tokenKeyFile;
  if(ms && googleKey && ms.tokenKeyFile!==googleKey)throw new Error('Conflicting personal-read custody key sources');
  return [...new Set([...google,...(ms?Object.values(ms):[])])];
}
export function verifyPersonalReadSecretSources(a: Sources): void {
  try {
    for(const file of personalReadSecretFiles(a)) {
      const st=lstatSync(file);
      if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || !st.size)throw new Error();
    }
  }catch{throw new Error('Personal-read runtime files unavailable or conflicting');}
}
