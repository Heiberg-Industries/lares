import {registerDoorActions} from '../lib/doors.js';
import {registerConversationActions,runtimeReset} from "../lib/conversations.js";
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
async function main(): Promise<void> {
    if (process.argv[2] !== "serve")
        throw new Error("usage: keeper serve");
    const config = loadKeeperConfig();
    const pool = keeperPool(config.db);
    const admin=config.lifecycle?keeperPool(config.lifecycle.adminDb):undefined;
    const lifecycle=config.lifecycle&&admin?new AgentLifecycle(pool,admin,config.lifecycle,config,ownedDocker({...config.lifecycle,project:config.project,dir:config.dir})):undefined;
    const context = { actor: "host", audit: auditor(pool) };
    const stops: Array<() => Promise<void>> = [];
    try {
        registerDefinitionActions({
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
        registerDoorActions({pool,secretsDir:config.secretsDir,publicOrigin:config.publicDoorOrigin,emailPrincipal:config.lifecycle?.runtime.google?.principal,googleOrgs:Object.keys(config.lifecycle?.runtime.google?.clients??{})});
        registerConversationActions(pool,(name,incarnation,id)=>runtimeReset(config.project,name,incarnation,id));
        stops.push(await serve({ socket: "/run/lares/keeper.sock", host: false, context }));
        stops.push(await serve({ socket: "/run/lares-host/keeper.sock", host: true, context }));
    }
    catch {
        for (const stop of stops)
            await stop();
        await pool.end();
        await admin?.end();
        throw new Error("keeper: startup failed");
    }
    let stopping = false;
    const shutdown = async () => {
        if (stopping)
            return;
        stopping = true;
        for (const stop of stops)
            await stop();
        await pool.end();
        await admin?.end();
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
