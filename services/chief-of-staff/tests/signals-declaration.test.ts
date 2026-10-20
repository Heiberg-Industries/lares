import { describe, expect, it } from "vitest";
import { isDisabledToolSentinel } from "eve/tools";
import { assertDeclarationIntegrity, grantFor } from "@lares/agent-kit/manifest";
import { parseDefinition } from "@lares/agent-kit/definition";
import { grantedToolNames } from "@lares/agent-kit/catalogue";

import manifest from "../agent.json";
import { CATALOGUE } from "../catalogue/index.js";

describe("signals declaration and fleet gate", () => {
  it("grants the chief of staff signals read at gated autonomy", () => {
    const declaration = assertDeclarationIntegrity(manifest);
    expect(grantFor(declaration, "signals")?.scope).toBe("read");
    expect(declaration.autonomy["signals"]).toBe("gated");
  });

  // signals_recent moved into the chief of staff's own catalogue, keyed
  // `agent-kit__signals_recent` — a resolver-emitted tool replaces an authored/mounted tool of
  // the same name completely, so `agent/extensions/agent-kit/tools/
  // signals_recent.ts` is now an unconditional disableTool() sentinel (see that file's own
  // header) and the live check moves to the catalogue that superseded it.
  it("mounts signals_recent for the chief of staff, through her own catalogue now", async () => {
    const mountTool = (await import("../agent/extensions/agent-kit/tools/signals_recent.js")).default;
    expect(isDisabledToolSentinel(mountTool)).toBe(true);

    const catalogueTool = CATALOGUE["agent-kit__signals_recent"]!.tool as { execute?: unknown };
    expect(isDisabledToolSentinel(catalogueTool)).toBe(false);
    expect(typeof catalogueTool.execute).toBe("function");

    const granted = grantedToolNames(CATALOGUE, parseDefinition(manifest));
    expect(granted).toContain("agent-kit__signals_recent");
  });

  it("does not grant signals to the creative role", async () => {
    const [creativeManifest, creativeTool] = await Promise.all([
      import("../../creative/agent.json"),
      import("../../creative/agent/extensions/agent-kit/tools/signals_recent.js"),
    ]);
    expect(grantFor(assertDeclarationIntegrity(creativeManifest.default), "signals")).toBeUndefined();
    expect(isDisabledToolSentinel(creativeTool.default)).toBe(true);
  });
});
