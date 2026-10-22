export type VaultTurnCapability=Readonly<{turnId:string;sequence:number;capability:string;expiresAt:number}>;
type Key=Readonly<{sessionId:string;turnId:string;sequence:number;incarnation:string}>;
const entries=new Map<string,VaultTurnCapability>(),MAX=512;
const active=new Map<string,number>(),ACTIVE_MS=5*60_000;
const key=(k:Key)=>`${k.sessionId}\0${k.turnId}\0${k.sequence}\0${k.incarnation}`;
function prune(now=Date.now()){for(const [id,expiresAt] of active)if(expiresAt<=now)active.delete(id);for(const [id,value] of entries)if(value.expiresAt<=now)entries.delete(id);}
export function markVaultTurnActive(k:Key){const now=Date.now();prune(now);for(const id of active.keys())if(id.startsWith(`${k.sessionId}\0`)&&id.endsWith(`\0${k.incarnation}`))active.delete(id);const id=key(k);if(active.size>=MAX&&!active.has(id))throw new Error('Private Vault turn unavailable');active.set(id,now+ACTIVE_MS);}
export function isVaultTurnActive(k:Key){prune();return active.has(key(k));}
export function markVaultTurnClosed(k:Key){active.delete(key(k));entries.delete(key(k));}
export function vaultTurnCapability(k:Key):VaultTurnCapability|undefined{
 prune();const now=Date.now();
 const value=entries.get(key(k));return value?.expiresAt&&value.expiresAt>now?value:undefined;
}
export function setVaultTurnCapability(k:Key,value:VaultTurnCapability|null){
 prune();
 const id=key(k);if(value===null){entries.delete(id);return;}
 if(entries.size>=MAX&&!entries.has(id))throw new Error('Private Vault turn unavailable');
 entries.set(id,value);
}
export function clearSessionVaultTurnCapabilities(sessionId:string,incarnation:string){const prefix=`${sessionId}\0`,suffix=`\0${incarnation}`;for(const id of entries.keys())if(id.startsWith(prefix)&&id.endsWith(suffix))entries.delete(id);for(const id of active.keys())if(id.startsWith(prefix)&&id.endsWith(suffix))active.delete(id)}
