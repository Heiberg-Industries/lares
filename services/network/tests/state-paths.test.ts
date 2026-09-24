import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateRoot } from "../lib/state-paths.js";

describe("state paths during a naming upgrade", () => {
  it("uses the Lares directory for a new installation", () => {
    expect(stateRoot({})).toBe(join(homedir(), ".lares"));
  });
  it("preserves an explicitly configured existing directory", () => {
    expect(stateRoot({ LARES_HOME: "/srv/existing-network-state" })).toBe("/srv/existing-network-state");
  });
  it("refuses ambiguous paths instead of creating a different database", () => {
    for (const value of ["", "relative", "~/state"]) expect(() => stateRoot({ LARES_HOME: value })).toThrow();
  });
});
