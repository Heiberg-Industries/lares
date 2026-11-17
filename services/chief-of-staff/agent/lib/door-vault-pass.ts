import { doorVaultPoint, doorVaultRoute, openDoorVaultTurn, type DoorVaultPoint, type DoorVaultRoute } from '@lares/agent-kit/door-vault-turn';
import { DOOR_NOTE_READ_FAILED } from '@lares/agent-kit/door-vault-sentences';
import { thisAgent } from '../../lib/definition.js';
import { setVaultTurnCapability, vaultTurnCapability, type VaultTurnCapability } from './vault-turn.js';

// ── The pass for a chat door's turn (the claimed person in a private chat) ───────────────────────
// One Keeper call per turn, shared by the turn-start hook and any tool call that finds none (a turn that
// continued after a card). Any failure is the one read sentence; nothing from Keeper is passed on.
const opening=new Map<string,Promise<VaultTurnCapability>>();
export async function ensureDoorVaultTurn(ctx:unknown):Promise<{route:DoorVaultRoute;point:DoorVaultPoint;capability:string}> {
 const route=doorVaultRoute(ctx),point=doorVaultPoint(ctx);
 if(!route||!point)throw new Error(DOOR_NOTE_READ_FAILED);
 const held=vaultTurnCapability(point);
 if(held&&held.expiresAt>Date.now()+1000)return {route,point,capability:held.capability};
 const id=`${point.sessionId}\0${point.turnId}\0${point.sequence}\0${point.incarnation}`;
 let pending=opening.get(id);
 if(!pending){
  pending=(async()=>{
   const {loaded}=await thisAgent(point.sessionId);
   const opened=await openDoorVaultTurn(route,point,{definition:loaded.definition,dutiesMd:loaded.dutiesMd,voiceMd:loaded.voiceMd,hash:loaded.hash});
   const value:VaultTurnCapability={turnId:point.turnId,sequence:point.sequence,capability:opened.capability,expiresAt:opened.expiresAt,door:true};
   setVaultTurnCapability(point,value);return value;
  })().finally(()=>opening.delete(id));
  opening.set(id,pending);
 }
 try{return {route,point,capability:(await pending).capability};}catch{throw new Error(DOOR_NOTE_READ_FAILED);}
}
