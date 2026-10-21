import { beforeEach, describe, expect, it } from "vitest";
import { accountSessionHash, openAccountFlow, sealAccountFlow, type AccountFlow } from "../lib/account-oauth-state";
const flow: AccountFlow = { provider: "google", intent: "new", memberId: "member-a", sessionHash: accountSessionHash("opaque-session"),
  org: "example", clientId: "data-client", state: "state", nonce: "nonce", verifier: "verifier" };
beforeEach(() => { process.env.CONSOLE_SESSION_SECRET = "test-consent-secret"; });
describe("member account flow cookie", () => {
  it("encrypts and authenticates member, session, client, state, PKCE and nonce", async () => {
    const sealed = await sealAccountFlow(flow);
    expect(sealed).not.toContain("verifier");
    expect(await openAccountFlow(sealed)).toEqual(flow);
    expect(await openAccountFlow(sealed + "x")).toBeNull();
    expect(await openAccountFlow(undefined)).toBeNull();
    process.env.CONSOLE_SESSION_SECRET = "another-secret";
    expect(await openAccountFlow(sealed)).toBeNull();
  });
  it("captures reconnect account, generation and revision with no address identity", async () => {
    const reconnect: AccountFlow = { ...flow, intent: "reconnect", update: { accountId: "account", generation: 2, lifecycleRevision: 4 } };
    expect(await openAccountFlow(await sealAccountFlow(reconnect))).toEqual(reconnect);
    await expect(sealAccountFlow({ ...flow, email: "same@example.test" } as never)).rejects.toThrow();
    await expect(sealAccountFlow({ ...flow, intent: "reconnect" } as never)).rejects.toThrow();
    await expect(sealAccountFlow({ ...flow, intent: "new", update: reconnect.update } as never)).rejects.toThrow();
    expect(accountSessionHash("another-session")).not.toBe(flow.sessionHash);
  });
  it("requires configured signing material", async () => {
    delete process.env.CONSOLE_SESSION_SECRET;
    await expect(sealAccountFlow(flow)).rejects.toThrow(/not configured/);
  });
});

it("strictly binds provider and work tenant in the authenticated cookie", async () => {
 const microsoft: AccountFlow = { ...flow, provider: "microsoft", tenantId: "11111111-2222-4333-8444-555555555555" };
 expect(await openAccountFlow(await sealAccountFlow(microsoft))).toEqual(microsoft);
 for (const changed of [{ provider: undefined }, { provider: "other" }, { provider: "microsoft" }, { provider: "google", tenantId: microsoft.tenantId }, { provider: "microsoft", tenantId: "consumers" }])
   await expect(sealAccountFlow({ ...flow, ...changed } as never)).rejects.toThrow();
});
