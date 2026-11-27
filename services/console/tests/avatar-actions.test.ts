import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  actingAddress: vi.fn(),
  signedInMember: vi.fn(),
  agentUse: vi.fn(),
  query: vi.fn(),
  normalize: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  actingAddress: mocks.actingAddress,
  signedInMember: mocks.signedInMember,
  mayUse: (member: { role: string } | null, level: string) =>
    !!member && (level === "member" || member.role === "owner" || (level === "admin" && member.role === "admin")),
}));
vi.mock("@lares/agent-kit/console-turn-authority", () => ({ requireConsoleAgentUse: mocks.agentUse }));
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
  mocks.actingAddress.mockResolvedValue("owner@example.test");
  mocks.signedInMember.mockResolvedValue({ id: "owner-id", role: "owner" });
});
const read = async (name: string) =>
  (await GET(new Request("http://localhost"), { params: Promise.resolve({ name }) })).status;
it("denies unauthenticated reads and writes before touching storage", async () => {
  mocks.actingAddress.mockResolvedValue(null);
  mocks.signedInMember.mockResolvedValue(null);
  expect((await saveAvatar(new FormData())).ok).toBe(false);
  expect(
    (
      await GET(new Request("http://localhost"), {
        params: Promise.resolve({ name: "agent-one" }),
      })
    ).status,
  ).toBe(401);
  expect(mocks.query).not.toHaveBeenCalled();
});
it("stores decoded normalized bytes, never the raw upload", async () => {
  mocks.query.mockResolvedValue({ rows: [{ name: "agent-one" }] });
  mocks.normalize.mockResolvedValue(Buffer.from("normalized"));
  const form = new FormData();
  form.set("name", "agent-one");
  form.set("image", new File(["raw"], "photo.png", { type: "image/png" }));
  expect((await saveAvatar(form)).ok).toBe(true);
  expect(mocks.query.mock.calls[1][1]).toEqual([
    "agent-one",
    Buffer.from("normalized"),
  ]);
});
it("returns private images and a distinct missing image response", async () => {
  mocks.query.mockResolvedValueOnce({
    rows: [{ image: Buffer.from("image") }],
  });
  const response = await GET(new Request("http://localhost"), {
    params: Promise.resolve({ name: "agent-one" }),
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("image/webp");
  mocks.query.mockResolvedValueOnce({ rows: [] });
  expect(
    (
      await GET(new Request("http://localhost"), {
        params: Promise.resolve({ name: "agent-one" }),
      })
    ).status,
  ).toBe(404);
});
it("resets only the selected agent image", async () => {
  mocks.query.mockResolvedValue({ rows: [{ name: "agent-one" }] });
  const form = new FormData();
  form.set("name", "agent-one");
  form.set("reset", "true");
  expect((await saveAvatar(form)).ok).toBe(true);
  expect(mocks.query).toHaveBeenLastCalledWith(
    "DELETE FROM agent_avatars WHERE name=$1",
    ["agent-one"],
  );
  expect(mocks.normalize).not.toHaveBeenCalled();
});
it("gives a member the picture of an agent they may use and refuses another's", async () => {
  mocks.signedInMember.mockResolvedValue({ id: "member-id", role: "member" });
  mocks.agentUse.mockImplementation(async (name: string, memberId: string) => {
    if (!(name === "allowed-agent" && memberId === "member-id")) throw new Error("denied");
  });
  mocks.query.mockResolvedValue({ rows: [{ image: Buffer.from("image") }] });
  expect(await read("allowed-agent")).toBe(200);
  expect(await read("other-agent")).toBe(403);
  expect(mocks.query).toHaveBeenCalledTimes(1);
});
it("gives an admin every agent's picture without the use check", async () => {
  mocks.signedInMember.mockResolvedValue({ id: "admin-id", role: "admin" });
  mocks.query.mockResolvedValue({ rows: [{ image: Buffer.from("image") }] });
  expect(await read("any-agent")).toBe(200);
  expect(mocks.agentUse).not.toHaveBeenCalled();
});
