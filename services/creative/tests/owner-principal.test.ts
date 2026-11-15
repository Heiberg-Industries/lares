// The owner of a door is the FIRST id on its allow-list; the allow-list says who may talk, the owner is who may approve.
import { describe, expect, it } from "vitest";
import { isAllowedPrincipal, isOwnerPrincipal, ownerPrincipalId } from "../lib/principals.js";

const env = { SLACK_ALLOWED_USER_IDS: " U_OWNER , U_SECOND ", CONSOLE_ALLOWED_EMAILS: "owner@example.com,second@example.com" };

describe("the owner of a door is the first id of its list", () => {
  it("is accepted; a second ALLOWED id is not the owner", () => {
    expect(ownerPrincipalId("slack", env)).toBe("U_OWNER");
    for (const [auth, owner, second] of [["slack-webhook", "U_OWNER", "U_SECOND"], ["lares-console", "owner@example.com", "second@example.com"]] as const) {
      expect(isOwnerPrincipal(auth, owner, env)).toBe(true);
      expect(isAllowedPrincipal(auth, second, env)).toBe(true);
      expect(isOwnerPrincipal(auth, second, env)).toBe(false);
    }
  });
  it("is nobody on an unknown door, with no id, with another door's id, or with no list", () => {
    expect(isOwnerPrincipal("http-basic", "U_OWNER", env)).toBe(false);
    expect(isOwnerPrincipal("slack-webhook", undefined, env)).toBe(false);
    expect(isOwnerPrincipal("slack-webhook", "owner@example.com", env)).toBe(false);
    expect(isOwnerPrincipal("slack-webhook", "U_OWNER", {})).toBe(false);
  });
});
