import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { KeeperRefusedError } from './actions.js';
import { agentName } from './compose-agents.js';
const ident = (s: string) => { if (!/^[a-z][a-z0-9_]{0,62}$/.test(s))
    throw new Error('Invalid database identifier'); return `"${s}"`; };
export class WorkflowStorage {
    constructor(private registry: Pool, private admin: Pool, private template: string, private owner: string) { ident(template); ident(owner); }
    async row(name: string) { agentName(name); return (await this.registry.query('SELECT * FROM agent_resources WHERE name=$1', [name])).rows[0]; }
    async provision(name: string, address: string) {
        agentName(name);
        let row = await this.row(name);
        if (!row) {
            const token = randomUUID(), database = `lares_${token.replaceAll('-', '')}`;
            row = (await this.registry.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state) VALUES($1,$2,$3,'owned',$4,$4,'provisioning') RETURNING *", [name, address, database, token])).rows[0];
        }
        if (row.ownership !== 'owned')
            throw new KeeperRefusedError('Existing storage cannot be provisioned as owned');
        if (row.state === 'ready') {
            await this.verify(row);
            return row;
        }
        if (row.state !== 'provisioning')
            throw new Error('Storage reconciliation required');
        const existing = await this.database(row.workflow_database);
        if (existing)
            await this.verify(row); // A crash before COMMENT is deliberately ambiguous; operator review required.
        else {
            await this.admin.query(`CREATE DATABASE ${ident(row.workflow_database)} WITH TEMPLATE ${ident(this.template)} OWNER ${ident(this.owner)}`);
            await this.admin.query(`COMMENT ON DATABASE ${ident(row.workflow_database)} IS 'lares-owned:${row.ownership_token}'`);
        }
        await this.verify(row);
        await this.registry.query("UPDATE agent_resources SET state='ready',updated_at=now() WHERE name=$1", [name]);
        return { ...row, state: 'ready' };
    }
    private async database(database: string) { return (await this.admin.query("SELECT d.datname,r.rolname AS owner,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1", [database])).rows[0]; }
    private async verify(row: any, missing = false) {
        if (row.ownership !== 'owned' || !/^lares_[0-9a-f]{32}$/.test(row.workflow_database) || !/^[0-9a-f-]{36}$/.test(row.ownership_token))
            throw new KeeperRefusedError('Storage ownership is unsupported; no resources were deleted');
        const db = await this.database(row.workflow_database);
        if (!db && missing && row.state === 'deleting')
            return;
        if (!db || db.owner !== this.owner || db.marker !== `lares-owned:${row.ownership_token}`)
            throw new KeeperRefusedError('Database ownership cannot be verified; operator reconciliation required');
    }
    async prepareDelete(name: string) {
        const row = await this.row(name);
        if (!row)
            throw new KeeperRefusedError('Storage ownership is missing');
        await this.verify(row, true);
        return { delete: async () => {
                const current = await this.row(name);
                if (!current || current.ownership_token !== row.ownership_token)
                    throw new KeeperRefusedError('Storage incarnation changed');
                await this.verify(current, true);
                await this.registry.query("UPDATE agent_resources SET state='deleting',updated_at=now() WHERE name=$1", [name]);
                await this.admin.query(`DROP DATABASE IF EXISTS ${ident(row.workflow_database)} WITH (FORCE)`);
            } };
    }
}
