import {slackChannel,defaultSlackAuth} from 'eve/channels/slack';
import {appendFileSync} from 'node:fs';
import {slackDoorVerifier,interceptSlackClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority} from '@lares/agent-kit/door-authority';
// No `events` block: eve 1.0 does not hear one (an unknown key is silently ignored), so the five
// empty handlers this fixture carried on 0.60 did nothing any more. The guarded `botToken` below is
// what stops an outbound call, in the order the role doors use: the door-authority check FIRST, and
// only then the point where a role would read the secret. eve 1.0 asks for the token on every
// inbound direct message, refused ones included (its typing indicator), so being ASKED is no longer
// evidence of anything; `<log>.asked` counts those. `TOKEN` is written only once the authority
// check has passed, where the secret would have been released, and the function still throws
// before any request leaves.
export default slackChannel({
 credentials:{webhookVerifier:slackDoorVerifier(()=>process.env.PROOF_SIGNING_SECRET!),botToken:async()=>{appendFileSync(process.env.PROOF_OUTBOUND_LOG!+'.asked','ASKED\n');await assertDoorAuthority('slack');appendFileSync(process.env.PROOF_OUTBOUND_LOG!,'TOKEN\n');throw new Error('No outbound calls allowed');}},
 onDirectMessage:async(ctx,message)=>{
  if(await interceptSlackClaim(message))return null;
  if(message.author?.userId!==process.env.LARES_SLACK_PRINCIPAL)return null;
  return {auth:defaultSlackAuth(message,ctx)};
 },onAppMention:()=>null,
});
