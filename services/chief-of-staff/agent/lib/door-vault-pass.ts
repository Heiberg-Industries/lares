import { closeDoorVaultTurn, doorVaultPoint, doorVaultRoute, openDoorVaultTurn, type DoorVaultPoint, type DoorVaultRoute } from '@lares/agent-kit/door-vault-turn';
import { DOOR_NOTE_READ_FAILED } from '@lares/agent-kit/door-vault-sentences';
import { thisAgent } from '../../lib/definition.js';
import { setVaultTurnCapability, vaultTurnCapability, type VaultTurnCapability } from './vault-turn.js';

// ── The pass for a chat door's turn (the claimed person in a private chat) ───────────────────────
// One Keeper call per turn, shared by the turn-start hook and any tool call that finds none (a turn that
// continued after a card). Any failure is the one read sentence; nothing from Keeper is passed on.
type Opening={promise:Promise<VaultTurnCapability>;closed:boolean};
const opening=new Map<string,Opening>();
/** The turn ended (settled or paused) while its pass was still being asked for: when Keeper answers, the pass is closed at once and never kept. */
export function abandonDoorVaultOpening(sessionId:string,turnId:string,incarnation:string):void {
 const prefix=`${sessionId}\0${turnId}\0`,suffix=`\0${incarnation}`;
 for(const [id,entry] of opening)if(id.startsWith(prefix)&&id.endsWith(suffix))entry.closed=true;
}
export async function ensureDoorVaultTurn(ctx:unknown):Promise<{route:DoorVaultRoute;point:DoorVaultPoint;capability:string}> {
 const route=doorVaultRoute(ctx),point=doorVaultPoint(ctx);
 if(!route||!point)throw new Error(DOOR_NOTE_READ_FAILED);
 const held=vaultTurnCapability(point);
 // A held capability that is not a door pass is web chat's: never reused, never replaced.
 if(held&&!held.door)throw new Error(DOOR_NOTE_READ_FAILED);
 if(held&&held.expiresAt>Date.now()+1000)return {route,point,capability:held.capability};
 const id=`${point.sessionId}\0${point.turnId}\0${point.sequence}\0${point.incarnation}`;
 let entry=opening.get(id);
 if(!entry){
  const created:Opening={closed:false,promise:undefined as never};
  created.promise=(async()=>{
   const {loaded}=await thisAgent(point.sessionId);
   const opened=await openDoorVaultTurn(route,point,{definition:loaded.definition,dutiesMd:loaded.dutiesMd,voiceMd:loaded.voiceMd,hash:loaded.hash});
   if(created.closed){await closeDoorVaultTurn(point,opened.capability);throw new Error(DOOR_NOTE_READ_FAILED);}
   const value:VaultTurnCapability={turnId:point.turnId,sequence:point.sequence,capability:opened.capability,expiresAt:opened.expiresAt,door:true};
   setVaultTurnCapability(point,value);return value;
  })().finally(()=>opening.delete(id));
  opening.set(id,created);entry=created;
 }
 try{return {route,point,capability:(await entry.promise).capability};}catch{throw new Error(DOOR_NOTE_READ_FAILED);}
}
