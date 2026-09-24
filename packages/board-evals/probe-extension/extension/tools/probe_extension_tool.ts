// The extension's own copy. The consumer mount overrides this slot with `disableTool()`
// (agent/extensions/probe/tools/probe_extension_tool.ts), which is D10's shape: the extension
// contributes the name, the mount switches it off, and the agent's dynamic catalogue tries to
// supply it instead. If this copy ever answers a call, the catalogue did NOT win.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Probe extension tool, extension copy.",
  inputSchema: z.object({}),
  execute: async () => ({ from: "extension", tool: "probe_extension_tool" }),
});
