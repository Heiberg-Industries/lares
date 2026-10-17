import type { Capacity } from '../lib/builder';
/** Why there is a limit, and what sets it (the `agents.ceiling` setting; the keeper refuses a new agent at it). */
export const LIMIT_WHY = 'The limit protects the server from running out of memory. It is the setting agents.ceiling in this installation’s settings (the settings table of its database); a fresh install starts it at 1, and the console cannot change it yet. Raise it only once the server has memory to spare for another agent.';
export function CeilingNotice({ capacity }: { capacity: Capacity }) {
  if (capacity.ceiling === null || !capacity.approved) return <p role="status">This box’s agent capacity has not been measured and approved. You have {capacity.activeCount} {capacity.activeCount === 1 ? 'agent' : 'agents'}. Creating an agent is unavailable until the owner approves a measured ceiling.</p>;
  return <div role="status"><p>This box holds up to {capacity.ceiling} {capacity.ceiling === 1 ? 'agent' : 'agents'}. You have {capacity.activeCount}.</p><p>{LIMIT_WHY}</p>{!capacity.creationAvailable && <p>{capacity.ceiling === 0 ? 'Move to a server with agent capacity to create one.' : 'To add another, retire an agent or move to a larger server.'}</p>}</div>;
}
