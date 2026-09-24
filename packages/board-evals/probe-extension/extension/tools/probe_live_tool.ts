// Never overridden and never emitted by the catalogue. Its presence in the model's tool set as
// `probe__probe_live_tool` is the control for Q3: it proves the mount is live and that `probe__`
// really is this extension's reserved prefix, so a catalogue key under the same prefix is a genuine
// collision test rather than a name nobody owns.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Probe extension control tool, never overridden.",
  inputSchema: z.object({}),
  execute: async () => ({ from: "extension", tool: "probe_live_tool" }),
});
