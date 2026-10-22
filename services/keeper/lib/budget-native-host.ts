import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import {z} from 'zod';
import {rejectDuplicateJsonKeys,BudgetNativeCredentialClient} from './budget-native-client.js';
import {budgetNativeReviewedPolicySchema,NATIVE_CUSTODY_POLICY_BYTES,type BudgetNativeReviewedPolicy} from './budget-native-custody.js';
import {readProtectedNativeGatewayMasterKey,trustedNativeGatewayOrigin} from './budget-native-cleanup.js';
import {registerAction} from './actions.js';
import {budgetNativeProvisionRequestSchema} from './budget-native-provisioning.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const policyFileSchema=z.object({endpointHash:hash,policies:z.array(budgetNativeReviewedPolicySchema).min(1).max(16)}).strict();
export const budgetNativeActivationRequestSchema=z.object({bindingId:z.string().uuid(),credentialGeneration:z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value=>BigInt(value)<=9_223_372_036_854_775_807n)}).strict();
export type BudgetNativePolicyDocument=z.infer<typeof policyFileSchema>;
type ProvisionRequest=z.infer<typeof budgetNativeProvisionRequestSchema>;
type ActivationRequest=z.infer<typeof budgetNativeActivationRequestSchema>;
type ProvisionResult={state:'bound-closed';bindingId:string;credentialGeneration:string};
type ActivationResult={state:'active';bindingId:string;credentialGeneration:string};

/** Registers the only socket actions that may change native custody; callers supply the
 * trusted in-process class composition, never request-selected authority. */
export function registerBudgetNativeHostActions(operations:{provision:(input:ProvisionRequest)=>Promise<ProvisionResult>;activate:(input:ActivationRequest)=>Promise<ActivationResult>}):void {
  registerAction({name:'budget.provision-native',hostOnly:true,input:budgetNativeProvisionRequestSchema,secretFields:['memberId'],run:operations.provision,
    successDetail:()=> 'native credential provisioned in a closed state'});
  registerAction({name:'budget.activate-native',hostOnly:true,input:budgetNativeActivationRequestSchema,run:operations.activate,
    successDetail:()=> 'native credential activated'});
}

function readProtectedPolicyText(path:string):string {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes:Buffer|undefined;
  try{
    const protectedFile=(stat:ReturnType<typeof fstatSync>)=>stat.isFile()&&stat.nlink===1&&stat.uid===0&&stat.gid===0&&
      (Number(stat.mode)&0o777)===0o600&&stat.size>=1&&stat.size<=NATIVE_CUSTODY_POLICY_BYTES;
    const before=fstatSync(fd);if(!protectedFile(before))throw new Error('unavailable');
    bytes=Buffer.alloc(NATIVE_CUSTODY_POLICY_BYTES+1);let length=0;
    while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,null);if(count===0)break;length+=count;}
    const after=fstatSync(fd),visible=lstatSync(path);
    if(length>NATIVE_CUSTODY_POLICY_BYTES||!protectedFile(after)||!protectedFile(visible)||
      before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||
      before.dev!==visible.dev||before.ino!==visible.ino||before.size!==visible.size||before.mtimeMs!==visible.mtimeMs)throw new Error('unavailable');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));
  }finally{bytes?.fill(0);closeSync(fd);}
}

/** Parse the operator-reviewed file without accepting duplicate JSON keys or unknown fields. */
export function parseBudgetNativePolicyDocument(text:string):BudgetNativePolicyDocument {
  try{
    if(Buffer.byteLength(text,'utf8')>NATIVE_CUSTODY_POLICY_BYTES)throw new Error();
    rejectDuplicateJsonKeys(text);
    const parsed=policyFileSchema.parse(JSON.parse(text));
    const aliases=new Set<string>();
    for(const policy of parsed.policies){
      if(policy.key.models.length!==1||aliases.has(policy.key.models[0]!))throw new Error();
      aliases.add(policy.key.models[0]!);
    }
    return parsed;
  }catch{throw new Error('Native budget policy is unavailable or invalid');}
}

export function readBudgetNativePolicyDocument(path:string):BudgetNativePolicyDocument {
  try{return parseBudgetNativePolicyDocument(readProtectedPolicyText(path));}
  catch{throw new Error('Native budget policy is unavailable or invalid');}
}

export function selectBudgetNativeReviewedPolicy(document:BudgetNativePolicyDocument,alias:string):BudgetNativeReviewedPolicy {
  const matches=document.policies.filter(policy=>policy.key.models[0]===alias);
  if(matches.length!==1)throw new Error('Native budget policy is unavailable or invalid');
  return matches[0]!;
}

export function createNativeCredentialClient(gatewayUrl:string|undefined,masterKeyFile:string|undefined):BudgetNativeCredentialClient {
  if(!gatewayUrl||!masterKeyFile)throw new Error('Native budget gateway is unavailable');
  const origin=trustedNativeGatewayOrigin(gatewayUrl);if(!origin)throw new Error('Native budget gateway is unavailable');
  let key:string;try{key=readProtectedNativeGatewayMasterKey(masterKeyFile);}catch{throw new Error('Native budget gateway is unavailable');}
  try{return new BudgetNativeCredentialClient(origin,key);}catch{throw new Error('Native budget gateway is unavailable');}
}
