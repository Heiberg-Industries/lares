/** Exact approval adapter shared by the Chief's callbacks and Keeper's signed broker.
 * No provider lookup, credential access, or model-authored identity is used here. */
import { payloadFingerprint, callIdFrom } from './approval-ledger.js';
import type { ExactApprovalAdapter } from './approval-execution.js';
import { parseDefinition } from './definition.js';
import { autonomyOf } from './manifest.js';
import { outsideToolsInEffect } from './outside-tools.js';
import { outsidePayloadHash } from './outside-execution-receipts.js';

export function outsideApprovalAdapter(connectionName:string,toolName:string):ExactApprovalAdapter {
 const name=`${connectionName}__${toolName}`;
 return {
  toolNames:[name],
  async readPolicyHash(db,agent,incarnation){
   const {rows}=await db.query(`SELECT r.applied_definition,a.hash FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
    WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready'
    AND NOT r.pending AND a.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,a`,[agent,incarnation]);
   if(rows.length!==1)throw new Error('Outside approval policy is unavailable');
   const definition=parseDefinition(rows[0].applied_definition),entry=outsideToolsInEffect(definition).find(e=>e.name===connectionName);
   if(!entry?.tools.allow.includes(toolName))throw new Error('Outside approval policy is unavailable');
   const board=await db.query("SELECT level,updated_at::text AS updated_at FROM ratchet WHERE agent=$1 AND capability='outside' AND action='' FOR SHARE",[agent]);
   const level=board.rows[0]?.level??autonomyOf(definition,'outside');
   if(!['gated','autonomous'].includes(level))throw new Error('Outside approval policy is unavailable');
   // Audit IDs survive deletion: changing an absent override to never and back cannot
   // revive an approval that captured the old board. The broker holds the ratchet table
   // lock through its final policy read and custody dispatch, including an absent row.
   const history=await db.query(`SELECT COALESCE(max(id),0)::text AS revision FROM ratchet_audit
    WHERE agent=$1 AND capability='outside'`,[agent]);
   return payloadFingerprint('outside-exact-policy-v1',{definition,hash:rows[0].hash,board:board.rows[0]??null,
    ratchetRevision:history.rows[0].revision,level,connectionName,toolName});
  },
  async readTarget(_db,input,memberId,tool,ctx,reserved){
   const callId=callIdFrom(ctx)??reserved?.id;
   if(tool!==name||!callId)throw new Error('Outside approval target is unavailable');
   return {kind:'outside-call',id:callId,ownerMemberId:memberId,fingerprint:outsidePayloadHash(toolName,input)};
  },
 };
}
