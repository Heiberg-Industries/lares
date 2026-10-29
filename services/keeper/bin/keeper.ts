import {z} from 'zod';
import {registerAction} from '../lib/actions.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {verifyFinancialContinuity} from '../lib/financial-continuity.js';
import {budgetAccountProvisionPlanSchema,provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import { Credentials, registerCredentialActions } from "../lib/credentials.js";
import { CredentialFiles } from "../lib/credential-files.js";
import { PgCredentialStore } from "../lib/credential-store.js";
import { credentialConsumers, deletedAgents } from "../lib/credential-consumers.js";
import { notionCredentialTester } from "../lib/notion-credential.js";
import { CredentialActivation } from '../lib/credential-activation.js';
import { OwnedCredentialRuntime } from '../lib/credential-runtime.js';
import { KeeperRefusedError } from '../lib/actions.js';
import {registerDoorActions} from '../lib/doors.js';
import {registerConversationActions,runtimeReset} from "../lib/conversations.js";
import { registerOutsideToolActions } from "../lib/outside-tools.js";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { deployedToolsFor } from "@lares/agent-kit/persona";
import { registerDefinitionActions } from "../lib/definitions.js";
import { GitBackup } from "../lib/git-backup.js";
import { readSetting } from "../lib/settings.js";
import { ownedDocker } from "../lib/docker.js";
import { AgentLifecycle } from "../lib/lifecycle.js";
import { keeperFinancialPool, keeperOutsideCustodyPool, keeperPool, loadKeeperConfig } from "../lib/config.js";
import { loadBoundOutsideCustodyKey, OutsideCustodyStore } from "../lib/outside-custody.js";
import { registerHumanOutsideDiscoveryActions } from "../lib/outside-discovery-actions.js";
import { registerPrivateMetadataActions } from "../lib/private-metadata.js";
import { auditor } from "../lib/audit.js";
import { serve } from "../lib/socket-server.js";
import {serveGatewayBudget} from '../lib/gateway-budget-server.js';
import {productionGatewayBudgetAuthority} from '../lib/gateway-budget.js';
import {preparedModelPurposeConsumer} from '../lib/budget-financial-writer.js';
import { GatewayAdmin } from "../lib/gateway-admin.js";
import { GatewayStatusReader, registerGatewayStatusAction } from "../lib/gateway-status.js";
import { prepareVaultRuntimeDirectory, serveConsoleVaultBroker } from "../lib/vault-console-broker.js";
import { serveModelPurposeBroker } from "../lib/model-purpose-broker.js";
import { DEFAULT_MODEL_PURPOSE_GATEWAY_SOCKET, serveModelPurposeTransport } from "../lib/model-purpose-transport.js";
import { registerMemberRemovalAction } from "../lib/member-removal.js";
import {registerInitialMemberBudgetActions} from '../lib/initial-member-budget.js';
import {BudgetNativeCustodyStore} from '../lib/budget-native-custody.js';
import {cleanupOneNativeCredential,openConfiguredNativeCustody} from '../lib/budget-native-cleanup.js';
import {BudgetNativeProvisioner} from '../lib/budget-native-provisioning.js';
import {BudgetNativeActivator} from '../lib/budget-native-activation.js';
import {createNativeCredentialClient,readBudgetNativePolicyDocument,selectBudgetNativeReviewedPolicy,registerBudgetNativeHostActions} from '../lib/budget-native-host.js';
import {createKeeperNativeRuntimeReader} from '../lib/native-runtime-reader.js';
async function main(): Promise<void> {
    if (process.argv[2] !== "serve")
        throw new Error("usage: keeper serve");
    const config = loadKeeperConfig();
    const vaultRuntimePath = join(config.agentsDir, "..", "run", "vault");
    let vaultRuntimeDir: string | undefined;
    let nativeCustody:BudgetNativeCustodyStore|undefined;
    let pool!:ReturnType<typeof keeperPool>;
    let vaultPool:ReturnType<typeof keeperPool>|undefined;
    let modelPurposePool:ReturnType<typeof keeperPool>|undefined;
    let financialPool:ReturnType<typeof keeperPool>|undefined;
    let outsidePool:ReturnType<typeof keeperPool>|undefined;
    let admin:ReturnType<typeof keeperPool>|undefined;
    const stops: Array<() => Promise<void>> = [];
    let financialJournal:HostFinancialJournal|undefined;
    let outsideCustody:OutsideCustodyStore|undefined;
    let modelPurposeTransportReady=false;
    try {
    pool = keeperPool(config.db);
    // Vault reads use a dedicated, bounded pool so disconnected clients cannot occupy
    // the connections used by unrelated Keeper actions.
    const vaultKeyPath=config.vaultConsoleSigningKeyFile;
    let vaultKeyPresent=false;
    try { if(vaultKeyPath){const st=lstatSync(vaultKeyPath); vaultKeyPresent=st.isFile()&&!st.isSymbolicLink()&&st.size>0;} } catch { }
    vaultPool=vaultKeyPresent
        ?keeperPool(config.db,{max:32,connectionTimeoutMillis:500,query_timeout:1000,options:'-c statement_timeout=900 -c lock_timeout=500 -c idle_in_transaction_session_timeout=1500'})
        :undefined;
    vaultPool?.on('error',()=>{});
    const modelPurposeKeyPath=config.modelPurposeConsoleSigningKeyFile;
    modelPurposePool=modelPurposeKeyPath?keeperPool(config.db,{max:8,connectionTimeoutMillis:500,query_timeout:1800,options:'-c statement_timeout=1600 -c lock_timeout=750 -c idle_in_transaction_session_timeout=2500'}):undefined;
    modelPurposePool?.on('error',()=>{});
    // Independent bounded pool: a slow machine RPC cannot queue behind human actions or
    // occupy their connections. HTTP deadlines never authorize a late allow.
    financialPool=keeperFinancialPool(config,{max:2,connectionTimeoutMillis:500,query_timeout:1750,options:'-c statement_timeout=1500 -c lock_timeout=750 -c idle_in_transaction_session_timeout=2500'});
    financialPool?.on('error',()=>{});
    admin=config.lifecycle?keeperPool(config.lifecycle.adminDb):undefined;
    const docker=config.lifecycle?ownedDocker({...config.lifecycle,project:config.project,dir:config.dir}):undefined;
    // Verify native custody before creating the optional vault runtime directory or
    // registering any action that can mutate SQL or local files.
    nativeCustody=openConfiguredNativeCustody(config.budgetNative?.directory);
    try {
        await prepareVaultRuntimeDirectory(vaultRuntimePath);
        vaultRuntimeDir = vaultRuntimePath;
    } catch {
        console.warn("keeper: Vault reader unavailable until its dedicated runtime directory is repaired");
    }
    const modelPurposeRuntimeDir=modelPurposeKeyPath?config.modelPurposeRuntimeDir:undefined;
    const nativeRuntimeReader=config.budgetNative||nativeCustody?createKeeperNativeRuntimeReader({
        policyFile:config.budgetNative?.reviewedPolicyFile,
        custody:()=>nativeCustody,
        journal:()=>financialJournal,
        pool:()=>financialPool,
        designatedOwnerId:()=>config.designatedOwnerId,
        gatewayUrl:()=>config.lifecycle?.runtime.gatewayUrl,
        runtimeTransportReady:()=>!!modelPurposePool&&!!modelPurposeKeyPath&&!!modelPurposeRuntimeDir&&modelPurposeTransportReady,
    }):undefined;
    // Lifecycle construction precedes journal preparation; the reader above resolves custody,
    // journal and transport state on every check instead of capturing startup-time absence.
    const lifecycle=config.lifecycle&&admin&&docker?new AgentLifecycle(pool,admin,config.lifecycle,{...config,vaultRuntimeDir,modelPurposeRuntimeDir},docker,
        undefined,undefined,undefined,undefined,undefined,nativeRuntimeReader):undefined;
    if(lifecycle)await lifecycle.storage.verifyReadyDatabases();
    if(config.outsideCustody){
        if(!lifecycle)throw new Error('keeper: outside custody unavailable');
        // Validate the root-bound key before constructing the dedicated outside-role pool.
        const outsideKey=loadBoundOutsideCustodyKey(config.outsideCustody.keyFile,config.outsideCustody.keyFingerprint);
        try{
            outsidePool=keeperOutsideCustodyPool(config,{max:4,connectionTimeoutMillis:500});
            if(!outsidePool)throw new Error('keeper: outside custody unavailable');
            outsidePool.on('error',()=>{});
            outsideCustody=new OutsideCustodyStore(outsidePool,outsideKey,{mainPool:pool,lifecycle});
            registerHumanOutsideDiscoveryActions(outsideCustody);
            registerPrivateMetadataActions(outsideCustody);
        }finally{outsideKey.fill(0);}
    }
    const credentialStore = new PgCredentialStore(pool);
    const credentialFiles = new CredentialFiles(config.secretsDir);
    const managed = config.credentials?.prepared === true;
    if (managed) lifecycle?.setCredentialState(() => credentialStore.read());
    const namespaceGuard = async () => {
        if (managed && (await credentialStore.read()).activationIntent)
            throw new KeeperRefusedError('Credential recovery required before changing agents or connections');
    };
    const context = { actor: "host", audit: auditor(pool) };
        // Native custody is opened and verified before the journal or any action can mutate
        // source rows or files. An unbound leftover is recovery, never an empty legacy store.
        if(config.budgetFinancial){
            if(!financialPool)throw new Error('Financial database credentials unavailable');
            financialJournal=HostFinancialJournal.openExistingForStartupVerification(config.budgetFinancial.directory,{requirePrepared:true});
            // Keep protected ownership through the full check, then publish writer ownership
            // before any host action or listener can reach the journal.
            const db=await financialPool.connect();
            try{await verifyFinancialContinuity(financialJournal,db);}finally{db.release();}
            financialJournal.acquireWriterLease();
        }
        registerInitialMemberBudgetActions({pool:financialPool,designatedOwnerId:config.designatedOwnerId});
        registerAction({name:'budget.freeze',hostOnly:true,input:z.object({}).strict(),run:async()=>{
            if(!financialJournal)throw new Error('Financial custody is not configured');
            await nativeCustody?.drainForShutdown();
            await financialJournal.freezeForRestore();
            nativeCustody?.close();
            return {frozen:true};
        }});
        if(nativeCustody)registerAction({name:'budget.cleanup-native',hostOnly:true,input:z.object({}).strict(),run:async()=>
            nativeCustody!.withGate(gate=>cleanupOneNativeCredential(gate,{gatewayUrl:config.lifecycle?.runtime.gatewayUrl,masterKeyFile:config.lifecycle?.runtime.gatewayMasterKeyFile})),
          successDetail:result=>result.status==='complete'?'native key cleanup complete':result.status==='pending'
            ?`${result.remaining} native key cleanup item(s) remain`:'native key cleanup blocked; inspection is required'});
        registerAction({name:'budget.provision-accounts',hostOnly:true,input:budgetAccountProvisionPlanSchema,secretFields:['memberIds'],run:async input=>{
            if(!financialJournal)throw new Error('Financial custody is not configured');
            if(!financialPool||!financialJournal)throw new Error('Financial custody is not configured');
            return provisionBudgetAccounts(financialPool,financialJournal,input);
        },successDetail:result=>`closed unreconciled accounts provisioned for ${result.members} members`});
        registerBudgetNativeHostActions({provision:async input=>{
            if(!financialPool||!financialJournal?.prepared||!nativeCustody||!config.budgetNative?.reviewedPolicyFile)throw new Error('Native budget provisioning is unavailable');
            const document=readBudgetNativePolicyDocument(config.budgetNative.reviewedPolicyFile);
            const policy=selectBudgetNativeReviewedPolicy(document,input.purposeAlias);
            const native=createNativeCredentialClient(config.lifecycle?.runtime.gatewayUrl,config.lifecycle?.runtime.gatewayMasterKeyFile);
            return new BudgetNativeProvisioner(financialPool,financialJournal,nativeCustody,native,{origin:native.gatewayOrigin,hash:document.endpointHash},policy).provision(input);
        },activate:async input=>{
            if(!financialPool||!financialJournal?.prepared||!nativeCustody)throw new Error('Native budget activation is unavailable');
            const native=createNativeCredentialClient(config.lifecycle?.runtime.gatewayUrl,config.lifecycle?.runtime.gatewayMasterKeyFile);
            return new BudgetNativeActivator(financialPool,financialJournal,nativeCustody,native).activate(input);
        }});
        if(financialPool)registerMemberRemovalAction({pool:financialPool,journal:financialJournal,designatedOwnerId:config.designatedOwnerId,nativeCustody});
        registerDefinitionActions({
            namespaceGuard, administrator: config.credentials?.administrator,
            pool, agentsDir: config.agentsDir, retiredDir: config.retiredDir, secretsDir: config.secretsDir,
            ceiling: async () => { const value = await readSetting(pool, "agents.ceiling"); return typeof value === "number" ? value : NaN; },
            compose: lifecycle ?? {stop:async()=>{throw new Error("Lifecycle configuration required");}},
            storage:lifecycle,
            roleInfo: role => ({ roleMd: readFileSync(join(config.templatesDir, role, "role.md"), "utf8"), deployedTools: deployedToolsFor(join(config.rolesDir, role)) }),
            backup: new GitBackup({ checkout: config.backupDir,
                remote: async () => { const value = await readSetting(pool, "agents.backup_remote"); return typeof value === "string" ? value : ""; },
                source: async (name) => {
                    const active = join(config.agentsDir, name);
                    if (existsSync(active))
                        return active;
                    const { rows } = await pool.query("SELECT retired_folder FROM agent_definitions WHERE name=$1 AND status='retired'", [name]);
                    const folder = rows[0]?.retired_folder;
                    if (typeof folder !== "string" || !new RegExp(`^${name}-[0-9T-]+-[0-9a-f-]{36}$`).test(folder))
                        throw new Error("backup: archive unavailable");
                    return join(config.retiredDir, folder);
                },
            }),
        });
        registerCredentialActions(new Credentials(config.credentials, credentialStore, credentialFiles, grants => credentialConsumers(pool, config, grants), notionCredentialTester(config.lifecycle?.runtime.proxyUrl),
            managed && lifecycle && docker ? new CredentialActivation(credentialFiles, new OwnedCredentialRuntime(pool, config, lifecycle, docker)) : undefined,
            names => deletedAgents(pool, names)));
        const gatewayUrl = config.lifecycle?.runtime.gatewayUrl;
        registerGatewayStatusAction(new GatewayStatusReader({ gatewayUrl, masterKeyFile: config.lifecycle?.runtime.gatewayMasterKeyFile,
            aliasPrefix: () => readSetting(pool, "models.alias_prefix"), admin: new GatewayAdmin(gatewayUrl ?? "http://unconfigured.invalid") }));
        registerDoorActions({pool,secretsDir:config.secretsDir,publicOrigin:config.publicDoorOrigin,emailPrincipal:config.lifecycle?.runtime.google?.principal,googleOrgs:Object.keys(config.lifecycle?.runtime.google?.clients??{}),namespaceGuard});
        registerConversationActions(pool,(name,incarnation,id)=>runtimeReset(config.project,name,incarnation,id));
        registerOutsideToolActions({ pool, agentsDir: config.agentsDir, secretsDir: config.secretsDir });
        stops.push(await serve({ socket: "/run/lares/keeper.sock", host: false, context }));
        stops.push(await serve({ socket: "/run/lares-host/keeper.sock", host: true, context }));
        if(financialPool)stops.push(await serveGatewayBudget({socket:'/run/lares/gateway-budget.sock',authority:productionGatewayBudgetAuthority(financialPool,config.gatewayBudget?.serviceKeyFile,financialJournal)}));
        // Vault is optional for older installations: missing custody removes only its dedicated
        // reader sockets and never prevents unrelated conversations or Keeper actions.
        if (vaultPool) {
            try { if(!vaultKeyPath)throw new Error('Vault signing key unavailable');stops.push(await serveConsoleVaultBroker(vaultPool,vaultKeyPath,config.secretsDir,join(config.agentsDir,"..","run","vault","read.sock"),{outsideCustody})); }
            catch { console.warn("keeper: Vault reader unavailable until its dedicated broker path is repaired"); }
        }
        // The dedicated model-purpose signer enables its independent, bounded broker. A
        // configured but unusable signer fails startup rather than silently allowing unsigned
        // private requests; absent optional custody leaves ordinary private chat unchanged.
        if(modelPurposePool&&modelPurposeKeyPath){
            const consumer=preparedModelPurposeConsumer(financialPool,financialJournal);
            const brokerStop=await serveModelPurposeBroker(modelPurposePool,{
                consoleSigningKeyFile:modelPurposeKeyPath,runtimeSecretsDir:config.secretsDir,
                consoleSocket:"/run/lares/model-purpose-console.sock",runtimeSocket:"/run/lares/model-purpose/model-purpose.sock",
            },consumer);
            if(nativeCustody&&consumer&&modelPurposeRuntimeDir){
                try{
                    const transportStop=await serveModelPurposeTransport({socket:DEFAULT_MODEL_PURPOSE_GATEWAY_SOCKET,runtimeSecretsDir:config.secretsDir,
                        custody:nativeCustody,ticketPool:consumer.pool});
                    modelPurposeTransportReady=true;
                    stops.push(async()=>{await transportStop();await brokerStop();});
                }catch(error){await brokerStop();throw error;}
            }else stops.push(brokerStop);
        }
        // After a reboot the kernel holds no firewall. Not awaited: the sockets serve meanwhile,
        // and any seal an action starts waits for this one. It logs its own outcome and never throws.
        void lifecycle?.resealAtStart();
    }
    catch {
        // Cleanup is best-effort but keeps the ownership order: stop listeners, drain
        // native work, drain its journal work, then close pools and durable owners.
        await Promise.allSettled(stops.map(stop=>stop()));
        try{await outsideCustody?.drainForShutdown();}catch{}
        try{outsideCustody?.close();}catch{}
        try{await nativeCustody?.drainForShutdown();}catch{}
        try{await financialJournal?.drainForShutdown();}catch{}
        await Promise.allSettled([pool?.end(),vaultPool?.end(),modelPurposePool?.end(),financialPool?.end(),outsidePool?.end(),admin?.end()].filter(Boolean) as Promise<void>[]);
        try{nativeCustody?.close();}catch{}
        try{financialJournal?.close();}catch{}
        throw new Error("keeper: startup failed");
    }
    let stopping = false;
    const shutdown = async () => {
        if (stopping)
            return;
        stopping = true;
        modelPurposeTransportReady=false;
        // Stop accepting commands first; keep both pools alive while an active native
        // action finishes any journal it already owns. Only then stop journal admission.
        const failures:unknown[]=[];
        for(const stop of stops)try{await stop();}catch(error){failures.push(error);}
        try{await outsideCustody?.drainForShutdown();}catch(error){failures.push(error);}
        try{outsideCustody?.close();}catch(error){failures.push(error);}
        try{await nativeCustody?.drainForShutdown();}catch(error){failures.push(error);}
        try{await financialJournal?.drainForShutdown();}catch(error){failures.push(error);}
        const pools=[pool.end(),vaultPool?.end(),modelPurposePool?.end(),financialPool?.end(),outsidePool?.end(),admin?.end()].filter(Boolean) as Promise<void>[];
        for(const result of await Promise.allSettled(pools))if(result.status==='rejected')failures.push(result.reason);
        try{nativeCustody?.close();}catch(error){failures.push(error);}
        try{financialJournal?.close();}catch(error){failures.push(error);}
        if(failures.length)throw new Error('keeper: shutdown did not complete cleanly');
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const)
        process.once(signal, () => {
            void shutdown().catch(() => {
                process.exitCode = 1;
            });
        });
}
void main().catch(() => {
    console.error("keeper: startup failed");
    process.exitCode = 1;
});
