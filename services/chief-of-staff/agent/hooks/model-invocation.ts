import { defineHook } from 'eve/hooks';
import { refuseModelCompaction } from '@lares/agent-kit/definition-model';

// Eve awaits this event before compactMessages and before the main model call. A summary
// requires its own trusted purpose/coordinates; it cannot spend the main step's claim.
export default defineHook({ events: { 'compaction.requested': refuseModelCompaction } });
