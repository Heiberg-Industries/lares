import type { Pool } from 'pg';
import { KeeperRefusedError } from './actions.js';
// Fixed engine-owned table/column map. No caller can add a table, predicate or SQL.
// Audit/approval/initiations history and shared owner memory intentionally remain.
const CURRENT_TABLES = ['ratchet', 'agent_registry', 'proactivity_settings', 'heartbeat', 'sessions', 'reminders', 'trigger_schedules', 'workflow_jobs', 'digest_requests', 'digest_skips', 'agent_conversations', 'agent_door_connections'] as const;
export async function verifyCurrentStateSchema(pool: Pool): Promise<void> {
    for (const table of CURRENT_TABLES) {
        const { rows } = await pool.query('SELECT to_regclass($1) AS relation', [`public.${table}`]);
        if (!rows[0]?.relation) throw new KeeperRefusedError('Current-state cleanup schema is incomplete; apply the manual installation migrations before deletion');
    }
}
/** Extending current agent identity state (e.g. Task17 claims) requires extending this
 * cleanup contract before slug reuse. Never delete append-only security evidence. */
export async function deleteAgentCurrentState(pool: Pool, name: string, actor: string): Promise<void> {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        await db.query("SELECT set_config('lares.actor',$1,true)", [actor]);
        for (const table of CURRENT_TABLES) {
            if (table === 'agent_registry') await db.query('DELETE FROM agent_registry WHERE name=$1', [name]);
            else if (table === 'heartbeat') await db.query("DELETE FROM heartbeat WHERE agent=$1 OR agent LIKE $1 || '/%'", [name]);
            else await db.query(`DELETE FROM ${table} WHERE agent=$1`, [name]);
        }
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    } finally {
        db.release();
    }
}
