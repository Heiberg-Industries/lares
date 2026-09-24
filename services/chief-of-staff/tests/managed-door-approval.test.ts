import {it,expect} from 'vitest';
import {assertApprover,approverFrom} from '../lib/approvals.js';
import {isAllowedPrincipalId} from '../lib/principals.js';
const identity={LARES_AGENT_INCARNATION:'11111111-1111-4111-8111-111111111111',SLACK_ALLOWED_USER_IDS:'U_LEGACY',TELEGRAM_PRINCIPAL_ID:'100'};
it('does not reuse legacy owner IDs for unclaimed managed doors',()=>{
 expect(isAllowedPrincipalId('slack','U_LEGACY',identity)).toBe(false);
 expect(isAllowedPrincipalId('telegram','100',identity)).toBe(false);
 expect(()=>assertApprover({authenticator:'slack-webhook',userId:'U_LEGACY'},identity)).toThrow();
});
it('uses the applied claimed principal for actual approval rechecks, including Telegram null-current fallback',()=>{
 const env={...identity,LARES_SLACK_PRINCIPAL:'U_CLAIMED',LARES_TELEGRAM_PRINCIPAL:'200'};
 expect(()=>assertApprover({authenticator:'slack-webhook',userId:'U_CLAIMED'},env)).not.toThrow();
 expect(()=>assertApprover({authenticator:'slack-webhook',userId:'U_LEGACY'},env)).toThrow();
 const auth={current:null,initiator:{authenticator:'telegram-webhook',attributes:{user_id:'200'}}};
 expect(()=>assertApprover(approverFrom(auth,env),env)).not.toThrow();
 expect(()=>assertApprover(approverFrom({...auth,initiator:{authenticator:'telegram-webhook',attributes:{user_id:'100'}}},env),env)).toThrow();
});
