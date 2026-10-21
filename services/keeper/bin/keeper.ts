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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deployedToolsFor } from "@lares/agent-kit/persona";
import { registerDefinitionActions } from "../lib/definitions.js";
import { GitBackup } from "../lib/git-backup.js";
import { readSetting } from "../lib/settings.js";
import { ownedDocker } from "../lib/docker.js";
import { AgentLifecycle } from "../lib/lifecycle.js";
import { keeperPool, loadKeeperConfig } from "../lib/config.js";
import { auditor } from "../lib/audit.js";
import { serve } from "../lib/socket-server.js";
import {serveGatewayBudget} from '../lib/gateway-budget-server.js';
import {productionGatewayBudgetAuthority} from '../lib/gateway-budget.js';
import { GatewayAdmin } from "../lib/gateway-admin.js";
import { GatewayStatusReader, registerGatewayStatusAction } from "../lib/gateway-status.js";
async function main(): Promise<void> {
    if (process.argv[2] !== "serve")
        throw new Error("usage: keeper serve");
    const config = loadKeeperConfig();
    const pool = keeperPool(config.db);
    // Independent bounded pool: a slow machine RPC cannot queue behind human actions or
    // occupy their connections. HTTP deadlines never authorize a late allow.
    const budgetPool=keeperPool(config.db,{max:2,connectionTimeoutMillis:500,query_timeout:1750,options:'-c statement_timeout=1500 -c lock_timeout=750 -c idle_in_transaction_session_timeout=2500'});
    budgetPool.on('error',()=>{});
    const admin=config.lifecycle?keeperPool(config.lifecycle.adminDb):undefined;
    const docker=config.lifecycle?ownedDocker({...config.lifecycle,project:config.project,dir:config.dir}):undefined;
    const lifecycle=config.lifecycle&&admin&&docker?new AgentLifecycle(pool,admin,config.lifecycle,config,docker):undefined;
    const credentialStore = new PgCredentialStore(pool);
    const credentialFiles = new CredentialFiles(config.secretsDir);
    const managed = config.credentials?.prepared === true;
    if (managed) lifecycle?.setCredentialState(() => credentialStore.read());
    const namespaceGuard = async () => {
        if (managed && (await credentialStore.read()).activationIntent)
            throw new KeeperRefusedError('Credential recovery required before changing agents or connections');
    };
    const context = { actor: "host", audit: auditor(pool) };
    const stops: Array<() => Promise<void>> = [];
    let financialJournal:HostFinancialJournal|undefined;
    try {
        if(config.budgetFinancial){
            financialJournal=HostFinancialJournal.openExisting(config.budgetFinancial.directory,{requirePrepared:true});
            // The startup observer is owned/released before sockets become reachable.
            const db=await budgetPool.connect();
            try{await verifyFinancialContinuity(financialJournal,db);}finally{db.release();}
        }
        registerAction({name:'budget.freeze',hostOnly:true,input:z.object({}).strict(),run:async()=>{
            if(!financialJournal)throw new Error('Financial custody is not configured');
            await financialJournal.freezeForRestore();return {frozen:true};
        }});
        registerAction({name:'budget.provision-accounts',hostOnly:true,input:budgetAccountProvisionPlanSchema,secretFields:['memberIds'],run:async input=>{
            if(!financialJournal)throw new Error('Financial custody is not configured');
            return provisionBudgetAccounts(budgetPool,financialJournal,input);
        },successDetail:result=>`closed unreconciled accounts provisioned for ${result.members} members`});
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
        stops.push(await serveGatewayBudget({socket:'/run/lares/gateway-budget.sock',authority:productionGatewayBudgetAuthority(budgetPool,config.gatewayBudget?.serviceKeyFile,financialJournal)}));
        // After a reboot the kernel holds no firewall. Not awaited: the sockets serve meanwhile,
        // and any seal an action starts waits for this one. It logs its own outcome and never throws.
        void lifecycle?.resealAtStart();
    }
    catch {
        for (const stop of stops)
            await stop();
        await pool.end();
        await budgetPool.end();
        await admin?.end();
        financialJournal?.close();
        throw new Error("keeper: startup failed");
    }
    let stopping = false;
    const shutdown = async () => {
        if (stopping)
            return;
        stopping = true;
        // Stops admission synchronously before waiting for any socket/pool shutdown.
        const drained=financialJournal?.drainForShutdown();
        for (const stop of stops)
            await stop();
        await pool.end();
        await budgetPool.end();
        await admin?.end();
        await drained;
        financialJournal?.close();
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
