import {slackChannel,defaultSlackAuth} from 'eve/channels/slack';
import {appendFileSync} from 'node:fs';
import {slackDoorVerifier,interceptSlackClaim} from '@lares/agent-kit/door-channels';
import {assertDoorAuthority} from '@lares/agent-kit/door-authority';
export default slackChannel({
 credentials:{webhookVerifier:slackDoorVerifier(()=>process.env.PROOF_SIGNING_SECRET!),botToken:async()=>{appendFileSync(process.env.PROOF_OUTBOUND_LOG!,'TOKEN\n');await assertDoorAuthority('slack');throw new Error('No outbound calls allowed');}},
 onDirectMessage:async(ctx,message)=>{
  if(await interceptSlackClaim(message))return null;
  if(message.author?.userId!==process.env.LARES_SLACK_PRINCIPAL)return null;
  return {auth:defaultSlackAuth(message,ctx)};
 },onAppMention:()=>null,
 events:{'turn.started':()=>{},'message.completed':()=>{},'turn.failed':()=>{},'session.failed':()=>{},'input.requested':()=>{}},
});
