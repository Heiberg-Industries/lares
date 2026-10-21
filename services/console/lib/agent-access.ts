import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { pool } from './db';
export const agentAccess = new PgGrantStore(pool);
