import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so the mock factories (which are hoisted above imports) can safely reference these.
const { cookieStore, putAdmin } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn<() => { value: string } | undefined>(() => undefined) },
  putAdmin: vi.fn(async () => {}),
}));

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("../lib/signals", () => ({ putAdmin }));

beforeEach(() => { vi.clearAllMocks(); cookieStore.get.mockReturnValue(undefined); });

describe("saveRules / saveCatalogue", () => {
  it("throws when unauthenticated and does not call putAdmin", async () => {
    const { saveRules, saveCatalogue } = await import("../app/actions/signals");
    await expect(saveRules("[]")).rejects.toThrow(/unauthenticated/);
    await expect(saveCatalogue("[]")).rejects.toThrow(/unauthenticated/);
    expect(putAdmin).not.toHaveBeenCalled();
  });

  it("authenticates before parsing: malformed JSON + no session still rejects with unauthenticated", async () => {
    const { saveRules, saveCatalogue } = await import("../app/actions/signals");
    await expect(saveRules("{not json")).rejects.toThrow(/unauthenticated/);
    await expect(saveCatalogue("{not json")).rejects.toThrow(/unauthenticated/);
    expect(putAdmin).not.toHaveBeenCalled();
  });
});
