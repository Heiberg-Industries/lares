// Creative has no admitted-turn hook for Keeper-proxied outside calls yet.
// Fail closed: never expose a direct provider connection or credential fallback.
import { defineDynamic } from 'eve/connections';
export default defineDynamic({events:{'session.started':async()=>null}});
