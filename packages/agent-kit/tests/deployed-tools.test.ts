// deployedToolsFor (ORB-145 Phase 3, Task 9 review; ORB-278 step 2, Task 8 review follow-up).
//
// A FILE COUNT that must still be a NAME SET: once a service moves a prefixed `agent-kit__*`
// tool into its own catalogue (Task 8's shape), that tool's basename in `catalogue/` is ALREADY
// the prefixed name (`catalogue/agent-kit__<bare>.ts`), while its still-present, now-disabled
// mount file (`agent/extensions/agent-kit/tools/<bare>.ts`) produces the SAME prefixed name
// through the `agent-kit__${n}` mapping on the third spread. Before the fix this repo's own
// `services/travel` produced `agent-kit__transit_plan` twice.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployedToolsFor } from "../src/persona/deployed-tools.js";

describe("deployedToolsFor", () => {
  it("names every real committed catalogue/mount PREFIXED collision exactly once — services/travel", () => {
    // The one real instance of the shape in the fleet today: agent-kit__transit_plan lives in
    // BOTH catalogue/ (Task 8's live re-export) and the extension mount (now a disabled
    // sentinel, still a file). A plain concatenation names it twice; the fixed function must not.
    const travelDir = new URL("../../../services/travel", import.meta.url).pathname;
    const names = deployedToolsFor(travelDir);
    expect(names).toEqual([...new Set(names)]);
    expect(names.filter((n) => n === "agent-kit__transit_plan")).toHaveLength(1);
  });

  it("dedupes a synthetic catalogue/mount collision for any prefixed tool, generally", () => {
    const dir = mkdtempSync(join(tmpdir(), "deployed-tools-dedupe-"));
    try {
      mkdirSync(join(dir, "agent", "tools"), { recursive: true });
      mkdirSync(join(dir, "agent", "extensions", "agent-kit", "tools"), { recursive: true });
      mkdirSync(join(dir, "catalogue"), { recursive: true });
      // The mount, present but disabled — Task 8's shape after a prefixed tool moves.
      writeFileSync(
        join(dir, "agent", "extensions", "agent-kit", "tools", "vault_write.ts"),
        'import { disableTool } from "eve/tools";\nexport default disableTool();\n',
      );
      // The service's own catalogue answers the SAME prefixed key.
      writeFileSync(
        join(dir, "catalogue", "agent-kit__vault_write.ts"),
        'import { vault_write } from "@lares/agent-kit/tools";\nexport default vault_write;\n',
      );
      // One ordinary local tool too, so this isn't a vacuous single-name fixture.
      writeFileSync(join(dir, "agent", "tools", "todo.ts"), 'import { disableTool } from "eve/tools";\nexport default disableTool();\n');

      const names = deployedToolsFor(dir);
      expect(names).toEqual([...new Set(names)]);
      expect(names.filter((n) => n === "agent-kit__vault_write")).toHaveLength(1);
      expect(names).toContain("agent-kit__vault_write");
      expect(names).toContain("todo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
