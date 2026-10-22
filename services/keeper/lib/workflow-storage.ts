import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { KeeperRefusedError } from './actions.js';
import { agentName } from './compose-agents.js';
import { applyWorkflowRuntimePrivileges, verifyWorkflowRuntimePrivileges } from '../../box/lib/workflow-database-privileges.js';

const ident = (s: string) => { if (!/^[a-z][a-z0-9_]{0,62}$/.test(s)) throw new Error('Invalid database identifier'); return `"${s}"`; };

/** Connection factories are Keeper-owned; workflow runtime verification must use a real login. */
export interface WorkflowDatabaseConnections {
    provisioner(database: string): Pool;
    runtime(database: string): Pool;
}
/** Injectable only to keep lifecycle state-machine tests independent of PostgreSQL role setup. */
export interface WorkflowPrivilegeContract {
    apply(client: PoolClient): Promise<void>;
    verify(client: PoolClient): Promise<void>;
    assertProvisioner(client: PoolClient, database: string, owner: string): Promise<void>;
    assertRuntime(client: PoolClient, database: string, owner: string): Promise<void>;
}
const productionPrivileges: WorkflowPrivilegeContract = {
    apply: applyWorkflowRuntimePrivileges,
    verify: verifyWorkflowRuntimePrivileges,
    async assertProvisioner(client, database, owner) {
        const result = await client.query<{ current_user: string; session_user: string; database: string; createdb: boolean; createrole: boolean; superuser: boolean; member: boolean }>(`
            SELECT current_user, session_user, current_database() AS database,
                r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolsuper AS superuser,
                pg_has_role(current_user, $1, 'MEMBER') AS member
            FROM pg_roles r WHERE r.rolname=current_user
        `, [owner]);
        const identity = result.rows[0];
        if (!identity || identity.current_user !== 'lares_workflow_provisioner' || identity.session_user !== 'lares_workflow_provisioner' || identity.database !== database || !identity.createdb || identity.createrole || identity.superuser || !identity.member)
            throw new KeeperRefusedError('Workflow provisioner identity or owner membership is invalid');
    },
    async assertRuntime(client, database, owner) {
        const identity = await client.query<{ current_user: string; session_user: string; database: string; superuser: boolean; createdb: boolean; createrole: boolean; bypassrls: boolean; can_set_owner: boolean; can_set_provisioner: boolean }>(`
            SELECT current_user,session_user,current_database() AS database,
                r.rolsuper AS superuser,r.rolcreatedb AS createdb,r.rolcreaterole AS createrole,r.rolbypassrls AS bypassrls,
                pg_has_role(current_user,$1,'MEMBER') AS can_set_owner,
                pg_has_role(current_user,'lares_workflow_provisioner','MEMBER') AS can_set_provisioner
            FROM pg_roles r WHERE r.rolname=current_user
        `, [owner]);
        const current = identity.rows[0];
        if (!current || current.current_user !== 'lares_workflow' || current.session_user !== 'lares_workflow' || current.database !== database || current.superuser || current.createdb || current.createrole || current.bypassrls || current.can_set_owner || current.can_set_provisioner)
            throw new KeeperRefusedError('Workflow runtime identity or role authority is invalid');
    },
};

export class WorkflowStorage {
    constructor(
        private registry: Pool,
        private admin: Pool,
        private template: string,
        private owner: string,
        private connections?: WorkflowDatabaseConnections,
        private privileges: WorkflowPrivilegeContract = productionPrivileges,
    ) { ident(template); ident(owner); }

    async row(name: string) { agentName(name); return (await this.registry.query('SELECT * FROM agent_resources WHERE name=$1', [name])).rows[0]; }

    /** Keeper calls this before opening action sockets; stale/pending workflow ACLs stop startup. */
    async verifyReadyDatabases(): Promise<void> {
        const rows = (await this.registry.query("SELECT * FROM agent_resources WHERE state='ready' ORDER BY name")).rows;
        for (const row of rows) {
            await this.verifyOwned(row);
            await this.verifyRuntime(row);
        }
    }

    async provision(name: string, address: string) {
        agentName(name);
        let row = await this.row(name);
        if (!row) {
            const token = randomUUID(), database = `lares_${token.replaceAll('-', '')}`;
            row = (await this.registry.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state) VALUES($1,$2,$3,'owned',$4,$4,'provisioning') RETURNING *", [name, address, database, token])).rows[0];
        }
        if (row.ownership !== 'owned') throw new KeeperRefusedError('Existing storage cannot be provisioned as owned');
        if (row.state === 'ready') {
            await this.verifyOwned(row);
            await this.verifyRuntime(row);
            return row;
        }
        if (row.state !== 'provisioning') throw new Error('Storage reconciliation required');
        this.requireConnections();
        const existing = await this.database(row.workflow_database);
        if (existing) {
            await this.assertProvisioner();
            // The owned marker is the sole authority to repair ACLs after a crash.
            await this.verifyOwned(row);
        } else {
            await this.createOwnedDatabase(row);
            await this.verifyOwned(row);
        }
        await this.applyAndVerifyRuntime(row);
        await this.registry.query("UPDATE agent_resources SET state='ready',updated_at=now() WHERE name=$1", [name]);
        return { ...row, state: 'ready' };
    }

    private requireConnections(): WorkflowDatabaseConnections {
        if (!this.connections) throw new Error('Workflow database access is not configured');
        return this.connections;
    }
    private async assertProvisioner(database = 'postgres'): Promise<void> {
        const client = await this.admin.connect();
        try {
            await this.privileges.assertProvisioner(client, database, this.owner);
        } finally { client.release(); }
    }
    private async createOwnedDatabase(row: any): Promise<void> {
        const client = await this.admin.connect();
        try {
            await this.privileges.assertProvisioner(client, 'postgres', this.owner);
            await client.query(`CREATE DATABASE ${ident(row.workflow_database)} WITH TEMPLATE ${ident(this.template)} OWNER ${ident(this.owner)}`);
            await client.query(`SET ROLE ${ident(this.owner)}`);
            try {
                const identity = await client.query<{ current_user: string; session_user: string }>('SELECT current_user,session_user');
                if (identity.rows[0]?.current_user !== this.owner || identity.rows[0]?.session_user !== 'lares_workflow_provisioner')
                    throw new KeeperRefusedError('Workflow owner role transition is invalid');
                await client.query(`COMMENT ON DATABASE ${ident(row.workflow_database)} IS 'lares-owned:${row.ownership_token}'`);
            } finally { await client.query('RESET ROLE'); }
        } finally { client.release(); }
    }

    private async database(database: string) {
        return (await this.admin.query("SELECT d.datname,r.rolname AS owner,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1", [database])).rows[0];
    }
    private async verifyOwned(row: any, missing = false) {
        if (row.ownership !== 'owned' || !/^lares_[0-9a-f]{32}$/.test(row.workflow_database) || !/^[0-9a-f-]{36}$/.test(row.ownership_token))
            throw new KeeperRefusedError('Storage ownership is unsupported; no resources were deleted');
        const db = await this.database(row.workflow_database);
        if (!db && missing && row.state === 'deleting') return;
        if (!db || db.owner !== this.owner || db.marker !== `lares-owned:${row.ownership_token}`)
            throw new KeeperRefusedError('Database ownership cannot be verified; operator reconciliation required');
    }
    private async applyAndVerifyRuntime(row: any): Promise<void> {
        const connections = this.requireConnections();
        const provisioner = connections.provisioner(row.workflow_database);
        try {
            const client = await provisioner.connect();
            try {
                await this.privileges.assertProvisioner(client, row.workflow_database, this.owner);
                await client.query(`SET ROLE ${ident(this.owner)}`);
                try {
                    const identity = await client.query<{ current_user: string; session_user: string }>('SELECT current_user,session_user');
                    if (identity.rows[0]?.current_user !== this.owner || identity.rows[0]?.session_user !== 'lares_workflow_provisioner')
                        throw new KeeperRefusedError('Workflow owner role transition is invalid');
                    await this.privileges.apply(client);
                } finally { await client.query('RESET ROLE'); }
            } finally { client.release(); }
        } finally { await provisioner.end(); }
        await this.verifyRuntime(row);
    }
    private async verifyRuntime(row: any): Promise<void> {
        const connections = this.requireConnections();
        const runtime = connections.runtime(row.workflow_database);
        try {
            const client = await runtime.connect();
            try {
                await this.privileges.assertRuntime(client, row.workflow_database, this.owner);
                await this.privileges.verify(client);
            } finally { client.release(); }
        } finally { await runtime.end(); }
    }

    async prepareDelete(name: string) {
        const row = await this.row(name);
        if (!row) throw new KeeperRefusedError('Storage ownership is missing');
        await this.verifyOwned(row, true);
        await this.assertProvisioner();
        return { delete: async () => {
            const current = await this.row(name);
            if (!current || current.ownership_token !== row.ownership_token) throw new KeeperRefusedError('Storage incarnation changed');
            await this.verifyOwned(current, true);
            await this.registry.query("UPDATE agent_resources SET state='deleting',updated_at=now() WHERE name=$1", [name]);
                const client = await this.admin.connect();
                try {
                    await this.privileges.assertProvisioner(client, 'postgres', this.owner);
                    await client.query(`SET ROLE ${ident(this.owner)}`);
                    try {
                        const identity = await client.query<{ current_user: string; session_user: string }>('SELECT current_user,session_user');
                        if (identity.rows[0]?.current_user !== this.owner || identity.rows[0]?.session_user !== 'lares_workflow_provisioner')
                            throw new KeeperRefusedError('Workflow owner role transition is invalid');
                        await client.query(`DROP DATABASE IF EXISTS ${ident(row.workflow_database)} WITH (FORCE)`);
                    } finally { await client.query('RESET ROLE'); }
                } finally { client.release(); }
        } };
    }
}
