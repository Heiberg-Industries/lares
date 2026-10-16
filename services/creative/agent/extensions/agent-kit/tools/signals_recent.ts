import { signals_recent } from "@lares/agent-kit/tools";
import { resolveExtensionTool } from "@lares/agent-kit/manifest";

import manifest from "../../../../agent.json";

export default resolveExtensionTool(manifest, "signals", signals_recent);
