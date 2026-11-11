import {slackChannel,defaultSlackAuth} from 'eve/channels/slack';
import {appendFileSync} from 'node:fs';
import {slackDoorVerifier,interceptSlackClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority} from '@lares/agent-kit/door-authority';
// No `events` block: eve 1.0 does not hear one (an unknown key is silently ignored), so the five
// empty handlers this fixture carried on 0.60 did nothing any more. The guarded `botToken` below is
// what stops an outbound call: it records the attempt and throws before any request leaves.
export default slackChannel({
 credentials:{webhookVerifier:slackDoorVerifier(()=>process.env.PROOF_SIGNING_SECRET!),botToken:async()=>{appendFileSync(process.env.PROOF_OUTBOUND_LOG!,'TOKEN\n');await assertDoorAuthority('slack');throw new Error('No outbound calls allowed');}},
 onDirectMessage:async(ctx,message)=>{
  if(await interceptSlackClaim(message))return null;
  if(message.author?.userId!==process.env.LARES_SLACK_PRINCIPAL)return null;
  return {auth:defaultSlackAuth(message,ctx)};
 },onAppMention:()=>null,
});
