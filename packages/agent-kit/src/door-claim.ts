/**
 * THE DOOR CLAIM CHECK, once, for every Keeper broker that serves a chat door's turn (the model
 * purpose broker's `door.open` and the Vault broker's `door.turn.open`). Door-neutral: which kinds
 * exist is the door table's answer (`door-kinds.ts`), never a name written here.
 */
import { type SourceDatabase, gateConsoleOrganisation } from './console-source-transaction.js';
import { currentDoor, type ChatDoor } from './door-authority.js';
import { isKnownDoor } from './door-kinds.js';

export const DOOR_PRINCIPAL = /^[A-Za-z0-9_-]{1,128}$/;
export const DOOR_CLAIM_REVISION = /^[a-f0-9-]{36}$/;

/** The door and the claim an agent says it speaks under: a known door, a principal, a revision. */
export function isValidDoorClaim(input: { door?: unknown; principal?: unknown; claimRevision?: unknown } | null | undefined): boolean {
  return !!input && isKnownDoor(input.door) &&
    typeof input.principal === 'string' && DOOR_PRINCIPAL.test(input.principal) &&
    typeof input.claimRevision === 'string' && DOOR_CLAIM_REVISION.test(input.claimRevision);
}

/** The applied door claim is still exactly this one, and its payer is still an active owner of an
 * organisation whose current address is the one the claim was issued by (compared trimmed and
 * case-insensitively). The organisation gate comes first, as for every other authority. */
export async function requireDoorClaim(db:SourceDatabase,claim:{door:string;principal:string;claimRevision:string;memberId:string},env:NodeJS.ProcessEnv):Promise<void> {
  if(!isKnownDoor(claim.door))throw new Error('Unsupported authority');
  await gateConsoleOrganisation(db,claim.memberId,undefined,{lock:'share'});
  const row=await currentDoor(claim.door as ChatDoor,db,env);
  if(!row||typeof row.principal!=='string'||row.principal!==claim.principal||row.revision!==claim.claimRevision||row.applied_revision!==claim.claimRevision||
    typeof row.owner_email!=='string')throw new Error('Stale authority');
  // The same owner rule as owner jobs (`requireActiveOwner`): a demoted owner no longer pays.
  const payer=await db.query(`SELECT 1 FROM users WHERE id=$1 AND status='active' AND org_role='owner' AND org_id IS NOT NULL AND primary_email IS NOT NULL
    AND lower(btrim(primary_email))=lower(btrim($2))`,[claim.memberId,row.owner_email]);
  if(payer.rows.length!==1)throw new Error('Stale authority');
}
