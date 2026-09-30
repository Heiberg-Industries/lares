import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../app/actions/autonomy", () => ({ setAutonomy: async () => {} }));

import { PermissionsBoard } from "../components/PermissionsBoard";

// Final review, last fix: the approval check only reaches write-with-confirm tools, so the agent page
// shows a switch only there — a switch on a read or plain-write integration saved a row no agent reads.
describe("PermissionsBoard (agent page)", () => {
  const html = (scope: "read" | "write" | "write-with-confirm") => renderToStaticMarkup(
    <PermissionsBoard detail={{ name: "helper", role: "assistant", status: "idle", capabilities: [{ name: "atlas", scope, defaultLevel: "gated" }] }} />,
  );
  it("a write-with-confirm integration gets the switch", () => {
    expect(html("write-with-confirm")).toContain('aria-label="atlas permission"');
  });
  it("a plain-write integration gets no switch, and says it acts without asking", () => {
    expect(html("write")).not.toContain('aria-label="atlas permission"');
    expect(html("write")).toContain("acts without asking — its definition grants a plain write");
  });
  it("a read integration gets no switch, and says reads are allowed while granted", () => {
    expect(html("read")).not.toContain('aria-label="atlas permission"');
    expect(html("read")).toContain("reads — allowed while granted");
  });
});
