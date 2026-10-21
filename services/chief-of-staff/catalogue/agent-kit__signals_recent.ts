// This agent's `@lares/agent-kit` contribution, held directly in its own catalogue rather than reached
// through `agent/extensions/agent-kit/tools/signals_recent.ts`. That mount file is an unconditional
// `disableTool` sentinel (see its own header), because a resolver-emitted tool under the same prefixed
// key (`agent-kit__signals_recent`) replaces an authored/mounted tool of that name completely.
//
// A free, unbilled read of the persisted operational-signal spine (no `.approval`).
//
// A thin re-export, not a copy: the tool's real implementation stays exactly where the kit owns
// it (packages/agent-kit/extension/tools/signals_recent.ts).
import { signals_recent } from "@lares/agent-kit/tools";

export default signals_recent;
