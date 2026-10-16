import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ROUTE_USERNAME, ACCEPTED_USERNAMES, routePasswordPath } from "../agent/channels/eve.js";
import { denylistPatterns } from "./helpers/denylist";

describe("the agent's own HTTP door", () => {
  it("answers to a role-neutral name", () => {
    expect(ROUTE_USERNAME).toBe("eve");
    expect(ACCEPTED_USERNAMES[0]).toBe("eve");
  });

  it("accepts exactly one name", () => {
    expect(ACCEPTED_USERNAMES).toEqual(["eve"]);
  });

  it("reads the route password path from EVE_ROUTE_PASSWORD_FILE, else the standard mount", () => {
    expect(routePasswordPath({ EVE_ROUTE_PASSWORD_FILE: "/a" })).toBe("/a");
    expect(routePasswordPath({})).toBe("/run/secrets/eve-route-password");
  });

  it("names no person and no company anywhere in the file", () => {
    const src = readFileSync(new URL("../agent/channels/eve.ts", import.meta.url), "utf8");
    for (const re of denylistPatterns()) expect(src).not.toMatch(re);
  });
});
