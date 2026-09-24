import {getPool} from '@lares/agent-kit/db';
import {managedIdentity} from '@lares/agent-kit/door-authority';
/** Recheck on each API resolution, including supplied account/principal. Never fall back to
 * another owner mailbox, most-recent token, or an old installation's credentials. */
export async function managedGoogleSelection(principal?:string,account?:string) {
 const identity=managedIdentity();if(!identity)return null;
 const p=process.env.LARES_EMAIL_PRINCIPAL,mailbox=process.env.LARES_EMAIL_MAILBOX,org=process.env.LARES_EMAIL_ORG,revision=process.env.LARES_EMAIL_CLAIM_REVISION;
 if(!p||!mailbox||!org||!revision||(principal&&principal!==p)||(account&&account!==mailbox))throw new Error('Requested mailbox is not this agent’s selected connection');
 const {rows}=await getPool().query(`SELECT 1 FROM agent_door_connections c JOIN agent_resources r ON r.name=c.agent AND r.ownership_token=c.incarnation
   JOIN agent_doors d ON d.agent=c.agent AND d.kind='email' JOIN agent_definitions a ON a.name=c.agent
   WHERE c.agent=$1 AND c.incarnation=$2::uuid AND c.kind='email' AND c.principal=$3 AND c.org=$4 AND c.mailbox=$5
   AND r.runtime_control_token=r.ownership_token AND c.revision=$6::uuid AND c.applied_revision=c.revision AND d.enabled AND NOT r.pending AND r.state='ready' AND a.status='valid'`,[identity.name,identity.incarnation,p,org,mailbox,revision]);
 if(!rows.length)throw new Error('Email connection is disabled, changed, or awaiting application');
 return {principal:p,mailbox,org};
}
