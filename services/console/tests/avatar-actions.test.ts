import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  query: vi.fn(),
  normalize: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ verify: mocks.verify }));
vi.mock("../lib/db", () => ({ pool: { query: mocks.query } }));
vi.mock("../lib/avatar-image", () => ({
  MAX_AVATAR_BYTES: 2 * 1024 * 1024,
  normalizeAvatar: mocks.normalize,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "test" }) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { saveAvatar } from "../app/actions/avatar";
import { GET } from "../app/api/agents/[name]/avatar/route";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockResolvedValue("owner@example.test");
});
it("denies unauthenticated reads and writes before touching storage", async () => {
  mocks.verify.mockResolvedValue(null);
  expect((await saveAvatar(new FormData())).ok).toBe(false);
  expect(
    (
      await GET(new Request("http://localhost"), {
        params: Promise.resolve({ name: "sage" }),
      })
    ).status,
  ).toBe(401);
  expect(mocks.query).not.toHaveBeenCalled();
});
it("stores decoded normalized bytes, never the raw upload", async () => {
  mocks.query.mockResolvedValue({ rows: [{ name: "sage" }] });
  mocks.normalize.mockResolvedValue(Buffer.from("normalized"));
  const form = new FormData();
  form.set("name", "sage");
  form.set("image", new File(["raw"], "photo.png", { type: "image/png" }));
  expect((await saveAvatar(form)).ok).toBe(true);
  expect(mocks.query.mock.calls[1][1]).toEqual([
    "sage",
    Buffer.from("normalized"),
  ]);
});
it("returns private images and a distinct missing image response", async () => {
  mocks.query.mockResolvedValueOnce({
    rows: [{ image: Buffer.from("image") }],
  });
  const response = await GET(new Request("http://localhost"), {
    params: Promise.resolve({ name: "sage" }),
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("image/webp");
  mocks.query.mockResolvedValueOnce({ rows: [] });
  expect(
    (
      await GET(new Request("http://localhost"), {
        params: Promise.resolve({ name: "sage" }),
      })
    ).status,
  ).toBe(404);
});
it("resets only the selected agent image", async () => {
  mocks.query.mockResolvedValue({ rows: [{ name: "sage" }] });
  const form = new FormData();
  form.set("name", "sage");
  form.set("reset", "true");
  expect((await saveAvatar(form)).ok).toBe(true);
  expect(mocks.query).toHaveBeenLastCalledWith(
    "DELETE FROM agent_avatars WHERE name=$1",
    ["sage"],
  );
  expect(mocks.normalize).not.toHaveBeenCalled();
});
