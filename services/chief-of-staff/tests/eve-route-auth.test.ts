import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ROUTE_USERNAME, ACCEPTED_USERNAMES, routePasswordPath } from "../agent/channels/eve.js";

describe("the agent's own HTTP door", () => {
  it("answers to a role-neutral name", () => {
    expect(ROUTE_USERNAME).toBe("eve");
    expect(ACCEPTED_USERNAMES[0]).toBe("eve");
  });

  it("still answers to the name this installation has used, so nothing on a box breaks", () => {
    expect(ACCEPTED_USERNAMES).toContain("eve-saga");
  });

  it("prefers the neutral secret variable, and falls back to the old one", () => {
    expect(routePasswordPath({ EVE_ROUTE_PASSWORD_FILE: "/a" })).toBe("/a");
    expect(routePasswordPath({ EVE_SAGA_ROUTE_PASSWORD_FILE: "/b" })).toBe("/b");
    expect(routePasswordPath({ EVE_ROUTE_PASSWORD_FILE: "/a", EVE_SAGA_ROUTE_PASSWORD_FILE: "/b" })).toBe("/a");
    expect(routePasswordPath({})).toBe("/run/secrets/eve-route-password");
  });

  it("names no person and no company anywhere in the file", () => {
    const src = readFileSync(new URL("../agent/channels/eve.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/bendik|heiberg/i);
  });
});
