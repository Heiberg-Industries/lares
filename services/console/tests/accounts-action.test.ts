import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so the mock factories (which are hoisted above imports) can safely reference these.
const { cookieStore, deleteToken } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn<() => { value: string } | undefined>(() => undefined) },
  deleteToken: vi.fn(async () => {}),
}));

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@lares/agent-box/lib/oauth-tokens.js", () => ({ deleteToken }));
vi.mock("../lib/db", () => ({ pool: {} }));
// lib/accounts is imported by the action for CONSOLE_PRINCIPAL; it also imports @lares/agent-box.
vi.mock("../lib/accounts", () => ({ consolePrincipal: () => "U_bendik" }));

beforeEach(() => { vi.clearAllMocks(); cookieStore.get.mockReturnValue(undefined); });

describe("removeAccount", () => {
  it("throws when unauthenticated and does not delete", async () => {
    const { removeAccount } = await import("../app/actions/accounts");
    await expect(removeAccount({ email: "x@y.co" })).rejects.toThrow(/unauthenticated/);
    expect(deleteToken).not.toHaveBeenCalled();
  });
});
