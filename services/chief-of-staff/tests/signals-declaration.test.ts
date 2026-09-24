import { describe, expect, it } from "vitest";
import { isDisabledToolSentinel } from "eve/tools";
import { assertDeclarationIntegrity, grantFor } from "@lares/agent-kit/manifest";
import { parseDefinition } from "@lares/agent-kit/definition";
import { grantedToolNames } from "@lares/agent-kit/catalogue";

import manifest from "../agent.json";
import { CATALOGUE } from "../catalogue/index.js";

describe("signals declaration and fleet gate", () => {
  it("grants Saga signals read at gated autonomy", () => {
    const declaration = assertDeclarationIntegrity(manifest);
    expect(grantFor(declaration, "signals")?.scope).toBe("read");
    expect(declaration.autonomy["signals"]).toBe("gated");
  });

  // ORB-278 step 2, Task 9: signals_recent moved into Saga's own catalogue, keyed
  // `agent-kit__signals_recent` — a resolver-emitted tool replaces an authored/mounted tool of
  // the same name completely (Task 1, Q1c), so `agent/extensions/agent-kit/tools/
  // signals_recent.ts` is now an unconditional disableTool() sentinel (see that file's own
  // header) and the live check moves to the catalogue that superseded it.
  it("mounts signals_recent for Saga, through her own catalogue now", async () => {
    const mountTool = (await import("../agent/extensions/agent-kit/tools/signals_recent.js")).default;
    expect(isDisabledToolSentinel(mountTool)).toBe(true);

    const catalogueTool = CATALOGUE["agent-kit__signals_recent"]!.tool as { execute?: unknown };
    expect(isDisabledToolSentinel(catalogueTool)).toBe(false);
    expect(typeof catalogueTool.execute).toBe("function");

    const granted = grantedToolNames(CATALOGUE, parseDefinition(manifest));
    expect(granted).toContain("agent-kit__signals_recent");
  });

  it("does not grant signals to Marcel or Calliope", async () => {
    const [travelManifest, creativeManifest, travelTool, creativeTool] = await Promise.all([
      import("../../travel/agent.json"),
      import("../../creative/agent.json"),
      import("../../travel/agent/extensions/agent-kit/tools/signals_recent.js"),
      import("../../creative/agent/extensions/agent-kit/tools/signals_recent.js"),
    ]);
    expect(grantFor(assertDeclarationIntegrity(travelManifest.default), "signals")).toBeUndefined();
    expect(grantFor(assertDeclarationIntegrity(creativeManifest.default), "signals")).toBeUndefined();
    expect(isDisabledToolSentinel(travelTool.default)).toBe(true);
    expect(isDisabledToolSentinel(creativeTool.default)).toBe(true);
  });
});
