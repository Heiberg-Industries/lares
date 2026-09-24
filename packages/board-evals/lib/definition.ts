// Real mounted-folder reader, validator and PostgreSQL last-valid cache. Synthetic identity only.
import { resolveDefinition, type Resolved } from '@lares/agent-kit/definition-cache';
const sessions = new Map<string, Promise<Resolved>>();
export function fixtureDefinition(sessionId?: string): Promise<Resolved> {
  const fresh = () => resolveDefinition({
    serviceDir: process.cwd(), agentName: 'board-evals',
    roleMd: 'A synthetic permissions proof.', deployedTools: ['vault_list', 'gmail_list'],
  });
  if (!sessionId) return fresh(); // Schedules must read at every tick.
  let value = sessions.get(sessionId);
  if (!value) {
    value = fresh().catch(error => { sessions.delete(sessionId); throw error; });
    sessions.set(sessionId, value);
  }
  return value;
}
