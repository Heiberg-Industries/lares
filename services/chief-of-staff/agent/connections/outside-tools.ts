// Outside tools are ordinary tools under agent/tools/outside-tools.ts.
// Never expose a direct provider connection or credential fallback.
import { defineDynamic } from 'eve/connections';
export default defineDynamic({events:{'session.started':async()=>null}});
