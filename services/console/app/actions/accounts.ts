"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import { deleteToken } from "@lares/agent-box/lib/oauth-tokens.js";
import { pool } from "../../lib/db";
import { sessionMember, isConsoleOwner } from "../../lib/auth";
import { consolePrincipal } from "../../lib/accounts";
export type RemoveAccountInput = { accountId: string; generation: number } | { email: string };
export async function removeAccount(input: RemoveAccountInput): Promise<void> {
  const member = await sessionMember((await cookies()).get("lares_session")?.value);
  if (!member) throw new Error("unauthenticated");
  try {
    if ("accountId" in input) {
      if (Object.keys(input).sort().join(",") !== "accountId,generation" || typeof input.accountId !== "string"
        || !Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error();
      const store = new PgAccountStore(pool);
      const ticket = await store.beginUpdate(member.id, input.accountId, input.generation);
      await store.setStatus(member.id, ticket, "revoked");
    } else {
      if (!isConsoleOwner(member) || Object.keys(input).join(",") !== "email" || typeof input.email !== "string" || !input.email) throw new Error();
      await deleteToken(pool, consolePrincipal(), "google", input.email);
    }
  } catch { throw new Error("Account could not be disconnected. Refresh the page and try again."); }
  revalidatePath("/membership");
  revalidatePath("/integrations");
}

/** Review only. Authentication, current binding, selected account and encrypted stored proposal
 * are all server-derived. The returned card never confers execution/approval authority. */
export async function readPersonalSendCard(requestId:string):Promise<import('../../lib/approval-text').PersonalSendCard>{
  const raw=(await cookies()).get('lares_session')?.value,member=await sessionMember(raw);
  if(!raw||!member||typeof requestId!=='string'||!requestId||requestId.length>512)throw new Error('Personal mail review unavailable');
  try{
    const found=(await pool.query(`SELECT p.id,p.account_id,p.account_generation,p.resource_binding_id,p.agent,p.session_id,p.incarnation
      FROM personal_actions p WHERE p.approval_request_id=$1 AND p.actor_member_id=$2`,[requestId,member.id])).rows[0];
    if(!found)throw new Error();
    const {PgPersonalActionStore,personalActionForRequest}=await import('@lares/agent-kit/personal-action-store');
    const {requireConsoleSessionBinding}=await import('@lares/agent-kit/console-turn-authority');
    const {currentSession}=await import('@lares/agent-kit/member-store');
    const {encryptSecret,decryptSecret}=await import('@lares/agent-box/lib/crypto.js');
    const {tokenEncKeyHex}=await import('../../lib/accounts');const key=tokenEncKeyHex();
    const actions=new PgPersonalActionStore(pool,{encrypt:text=>encryptSecret(text,key),decrypt:text=>decryptSecret(text,key)});
    return await new PgAccountStore(pool).withPersonalResourceCredential(member.id,{accountId:found.account_id,generation:found.account_generation,resourceBindingId:found.resource_binding_id},'mailbox',async({account},_credential,db)=>{
      const proposal=await actions.proposalInTransaction(member.id,found.id,db);
      const current=await personalActionForRequest(db,{requestId,memberId:member.id,agentId:found.agent,sessionId:found.session_id});
      if(!current.alive||current.approvalOutcome!==null||current.outcome.state!=='awaiting_dispatch')throw new Error();
      await requireConsoleSessionBinding({agent:found.agent,incarnation:found.incarnation,sessionId:found.session_id,memberId:member.id},db);
      if(!await currentSession(db,raw,member.id,{lock:'share'}))throw new Error();
      const final=await personalActionForRequest(db,{requestId,memberId:member.id,agentId:found.agent,sessionId:found.session_id});
      if(!final.alive)throw new Error();
      return {accountLabel:account.providerAccount.label,connectorId:account.connectorId,accountId:account.id,generation:account.generation,
        resourceBindingId:proposal.selection.resourceBindingId,...proposal.payload};
    });
  }catch{throw new Error('Personal mail review unavailable or authority changed');}
}
