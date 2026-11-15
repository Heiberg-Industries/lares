// The owner of a door is the FIRST id on its allow-list; the allow-list says who may talk, the owner is who may approve.
import { describe, expect, it } from "vitest";
import { isAllowedPrincipal, isOwnerPrincipal, ownerPrincipalId } from "../lib/principals.js";

const legacy = { SLACK_ALLOWED_USER_IDS: " U_OWNER , U_SECOND ", TELEGRAM_PRINCIPAL_ID: "100,200", CONSOLE_ALLOWED_EMAILS: "owner@example.com,second@example.com" };
const managed = { LARES_AGENT_INCARNATION: "11111111-1111-4111-8111-111111111111", LARES_SLACK_PRINCIPAL: "U_OWNER,U_SECOND", LARES_TELEGRAM_PRINCIPAL: "100,200", LARES_CONSOLE_PRINCIPAL: "owner@example.com,second@example.com" };

describe.each([["unclaimed doors", legacy], ["claimed (managed) doors", managed]])("the owner on %s", (_name, env) => {
  it("is the first id of each door's list", () => {
    expect(ownerPrincipalId("slack", env)).toBe("U_OWNER");
    expect(ownerPrincipalId("telegram", env)).toBe("100");
    expect(ownerPrincipalId("console", env)).toBe("owner@example.com");
  });
  it("is accepted; a second ALLOWED id is allowed to talk but is not the owner", () => {
    for (const [auth, owner, second] of [["slack-webhook", "U_OWNER", "U_SECOND"], ["telegram-webhook", "100", "200"], ["lares-console", "owner@example.com", "second@example.com"]] as const) {
      expect(isOwnerPrincipal(auth, owner, env)).toBe(true);
      expect(isAllowedPrincipal(auth, second, env)).toBe(true);
      expect(isOwnerPrincipal(auth, second, env)).toBe(false);
    }
  });
  it("is nobody on an unknown door, with no id, or with another door's owner id", () => {
    expect(isOwnerPrincipal("http-basic", "U_OWNER", env)).toBe(false);
    expect(isOwnerPrincipal(undefined, "U_OWNER", env)).toBe(false);
    expect(isOwnerPrincipal("slack-webhook", undefined, env)).toBe(false);
    expect(isOwnerPrincipal("slack-webhook", "", env)).toBe(false);
    expect(isOwnerPrincipal("slack-webhook", "100", env)).toBe(false);
    expect(isOwnerPrincipal("telegram-webhook", "U_OWNER", env)).toBe(false);
  });
});

describe("a door with no list has no owner", () => {
  it("fails closed", () => {
    expect(ownerPrincipalId("slack", {})).toBeUndefined();
    expect(isOwnerPrincipal("slack-webhook", "U_OWNER", {})).toBe(false);
    expect(isOwnerPrincipal("slack-webhook", "U_OWNER", { SLACK_ALLOWED_USER_IDS: ",," })).toBe(false);
  });
});
