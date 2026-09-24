import type { Capacity } from '../lib/builder';
export function CeilingNotice({ capacity }: { capacity: Capacity }) {
  if (capacity.ceiling === null || !capacity.approved) return <p role="status">This box’s agent capacity has not been measured and approved. You have {capacity.activeCount} agents. Creating an agent is unavailable until the owner approves a measured ceiling.</p>;
  return <div role="status"><p>This box holds {capacity.ceiling} agents. You have {capacity.activeCount}.</p>{!capacity.creationAvailable && <p>This box holds {capacity.ceiling} agents; retire one or move to a larger server.</p>}</div>;
}
