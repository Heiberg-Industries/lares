import Link from 'next/link';
import { Notice } from '@lares/ui/patterns';
import type { Capacity } from '../lib/builder';
/** Why the initial limit and the separate hardware estimate can differ. */
export const LIMIT_WHY = 'A fresh installation starts with a limit of 1 as a conservative setting, not a measurement of this server’s capacity. General → Agents shows a separate rough RAM estimate: about 2.5 GiB for Lares, 2 GiB kept free, and 1.5 GiB per agent. Only the installation owner can change the limit; review that estimate first.';
export function CeilingNotice({ capacity }: { capacity: Capacity }) {
  if (capacity.ceiling === null || !capacity.approved) return <Notice tone="needs-you">This server’s agent capacity has not been measured and approved. You have {capacity.activeCount} {capacity.activeCount === 1 ? 'agent' : 'agents'}. Creating an agent is unavailable until the installation owner sets a limit in General → Agents.{capacity.canChange === true ? <Link href="/general"> Open General → Agents</Link> : ' Ask the installation owner to set one there.'}</Notice>;
  return <Notice><p>This server holds up to {capacity.ceiling} {capacity.ceiling === 1 ? 'agent' : 'agents'}. You have {capacity.activeCount}.</p><p>{LIMIT_WHY}</p>{capacity.canChange === true && <p><Link href="/general">Open General → Agents</Link></p>}{!capacity.creationAvailable && <p>{capacity.canChange === true ? 'The limit has been reached. You can raise it in General → Agents after reviewing the RAM estimate, or retire an agent.' : 'The limit has been reached. Ask the installation owner to review General → Agents, or retire an agent.'}</p>}</Notice>;
}
