import type { Capacity } from '../lib/builder';
export function CeilingNotice({ capacity }: { capacity: Capacity }) {
  if (capacity.ceiling === null || !capacity.approved) return <p role="status">This box’s agent capacity has not been measured and approved. You have {capacity.activeCount} {capacity.activeCount === 1 ? 'agent' : 'agents'}. Creating an agent is unavailable until the owner approves a measured ceiling.</p>;
  return <div role="status"><p>This box holds up to {capacity.ceiling} {capacity.ceiling === 1 ? 'agent' : 'agents'}. You have {capacity.activeCount}.</p>{!capacity.creationAvailable && <p>{capacity.ceiling === 0 ? 'Move to a server with agent capacity to create one.' : 'To add another, retire an agent or move to a larger server.'}</p>}</div>;
}
