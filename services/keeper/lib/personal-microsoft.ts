/** Root-owned personal-read sources. Definitions select capabilities, never host files. */
import { lstatSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { AgentDefinition } from '@lares/agent-kit/definition';
import { autonomyOf, grantFor } from '@lares/agent-kit/manifest';
import { KeeperRefusedError } from './actions.js';
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
type Sources = {personalMicrosoft?:PersonalMicrosoftConfig;personalGoogle?:PersonalGoogleConfig};
/** Console custody uses one encryption key. Distinct provider mounts must name the same source
 * when both are mounted. Microsoft-only installations need no Google configuration. */
export function personalReadSecretFiles(a: Sources): string[] {
  const google=googleSecretFiles(a),ms=a.personalMicrosoft?personalMicrosoftSchema.parse(a.personalMicrosoft):undefined;
  const googleKey=a.personalGoogle?.tokenKeyFile;
  if(ms && googleKey && ms.tokenKeyFile!==googleKey)throw new Error('Conflicting personal-read custody key sources');
  return [...new Set([...google,...(ms?Object.values(ms):[])])];
}
/** Refuses, naming the path only, when a configured source file is not visible to the keeper as a
 * single plain non-empty file. The usual cause is a keeper.json path no compose mount covers. */
export function verifyPersonalReadSecretSources(a: Sources): void {
  let files: string[];
  try{files=personalReadSecretFiles(a);}
  catch{throw new KeeperRefusedError('Personal-read runtime settings are invalid or conflicting');}
  for(const file of files) {
    try {
      const st=lstatSync(file);
      if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || !st.size)throw new Error();
    }catch{throw new KeeperRefusedError(`The keeper cannot see the configured personal-read file ${file}: it is missing, empty, linked or not a plain file inside the keeper`);}
  }
}
