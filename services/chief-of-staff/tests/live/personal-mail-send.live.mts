/** MANUAL WRITE PROBE. Never tests/CI. Requires a fresh technical-user approval for ONE
 * prepared exact own-account message. This consumes the ordinary permanently nonretryable
 * action: failure/unknown NEVER permits replay. A new send needs a new proposal and review.
 *
 * pnpm -C services/chief-of-staff exec tsx tests/live/personal-mail-send.live.mts \
 *   --config /private/operator/action.json --approved-action <uuid> --allow-provider-write
 *
 * Private JSON: {context,reference}. These are trusted server-captured approval-response
 * coordinates for an ALREADY encrypted/prepared/approved personal action, not fabricated
 * model input. Existing mounted runtime configuration and DATABASE_URL are required. The
 * encryption key is the existing token key (TOKEN_ENC_KEY_FILE). No creation, approval,
 * consent, account selection fallback or arbitrary payload is performed by this probe.
 * Run separately for Google and a Microsoft work technical-user account, only to controlled
 * recipients named in the exact card. Inspect the actual Sent folder after accepted; API
 * acceptance is NOT delivery evidence. Output never includes IDs, addresses, body or errors.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getPool,closePool } from '@lares/agent-kit/db';
import { readTokenEncKey } from '@lares/agent-kit/google-auth';
import { PgPersonalActionStore } from '@lares/agent-kit/personal-action-store';
import { encryptSecret,decryptSecret } from '@lares/agent-box/lib/crypto.js';
import { executeApprovedPersonalSend } from '../../lib/personal-send.js';
const {values}=parseArgs({options:{config:{type:'string'},'approved-action':{type:'string'},'allow-provider-write':{type:'boolean'}}});
if(!values.config||!values['allow-provider-write']||!values['approved-action'])throw new Error('Explicit prepared action and write permission are required');
try{
  const {context,reference}=JSON.parse(readFileSync(values.config,'utf8'));
  if(reference.actionId!==values['approved-action'])throw new Error('Selected approved action changed');
  const key=readTokenEncKey(),pool=getPool();
  const actions=new PgPersonalActionStore(pool,{encrypt:text=>encryptSecret(text,key),decrypt:text=>decryptSecret(text,key)});
  const outcome=await executeApprovedPersonalSend(context,reference,{pool,actions});
  console.log(JSON.stringify({probeAccepted:outcome.state==='accepted',outcome:outcome.state,deliveryVerified:false}));
  if(outcome.state!=='accepted')process.exitCode=1;
}catch{console.log(JSON.stringify({probeAccepted:false,outcome:'unavailable-or-unknown',deliveryVerified:false}));process.exitCode=1;}
finally{await closePool();}
