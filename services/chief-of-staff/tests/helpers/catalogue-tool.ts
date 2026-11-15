/** The tools the real chief-of-staff catalogue resolver emits for a plain (native) conversation. */
import { vi } from "vitest";
import { runDynamic } from "../../../../packages/agent-kit/tests/helpers/eve-dynamic.js";

vi.mock("../../lib/definition.js", () => ({ thisAgent: async () => ({ loaded: { definition: {} } }) }));
vi.mock("@lares/agent-kit/catalogue", async (original) => ({ ...(await original<typeof import("@lares/agent-kit/catalogue")>()), grantedToolNames: () => ["echo_note"] }));

export async function eveDynamicFor(_tool: string): Promise<Record<string, any>> {
  const resolver = (await import("../../agent/tools/catalogue.js")).default;
  return runDynamic(resolver, { session: { id: "wrun_door", auth: { current: null, initiator: null } } });
}
