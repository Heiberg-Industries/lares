import { describe, it, expect, vi } from "vitest";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@lares/agent-kit/owner-job", () => ({ dispatchOwnerJob: dispatch }));
import { makeGatewayEmbedder, makeVoiceStore } from "../lib/embeddings-gateway.js";

import { cutToFit } from "../lib/embeddings-gateway.js";

const reply = (data: unknown, ok = true, status = 200) => async () => ({ ok, status, json: async () => data, text: async () => String(data) }) as any;
const vec = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("makeGatewayEmbedder", () => {
  it("sends model, input and encoding_format float, and returns vectors in input order", async () => {
    let body: any;
    const embedder = makeGatewayEmbedder({ model: "lares-embed", post: async (b) => { body = JSON.parse(b); return reply({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] })(); } });
    expect(await embedder.embed(["a", "b"])).toEqual([[1, 2], [3, 4]]);
    expect(body).toEqual({ model: "lares-embed", input: ["a", "b"], encoding_format: "float" });
  });

  it("refuses zero inputs, more than 32, and empty inputs before any request", async () => {
    const post = vi.fn();
    const embedder = makeGatewayEmbedder({ model: "m", post });
    await expect(embedder.embed([])).rejects.toThrow(/1 to 32/);
    await expect(embedder.embed(Array(33).fill("x"))).rejects.toThrow(/1 to 32/);
    await expect(embedder.embed(["ok", "   "])).rejects.toThrow(/empty/);
    expect(post).not.toHaveBeenCalled();
  });

  it("cuts an over-long text to the model's limit instead of failing", async () => {
    let body: any;
    const embedder = makeGatewayEmbedder({ model: "m", maxInputTokens: 5, post: async (b) => { body = JSON.parse(b); return reply({ data: [{ index: 0, embedding: [1] }] })(); } });
    await embedder.embed(["abcdefghij"]);
    expect(body.input).toEqual(["abcde"]);
    expect(cutToFit("a😀b😀c", 3)).toBe("a😀b");
  });

  it("throws with the status and a snippet of the body on a non-ok response", async () => {
    const embedder = makeGatewayEmbedder({ model: "m", post: async () => ({ ok: false, status: 500, text: async () => "boom" }) as any });
    await expect(embedder.embed(["x"])).rejects.toThrow(/500.*boom/);
  });

  it.each([
    ["wrong count", { data: [] }],
    ["duplicate index", { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }],
    ["index out of range", { data: [{ index: 0, embedding: [1] }, { index: 5, embedding: [1] }] }],
    ["different lengths", { data: [{ index: 0, embedding: vec(2) }, { index: 1, embedding: vec(3) }] }],
    ["non-number value", { data: [{ index: 0, embedding: ["x"] }, { index: 1, embedding: [1] }] }],
  ])("refuses a malformed answer: %s", async (_name, answer) => {
    const embedder = makeGatewayEmbedder({ model: "m", post: reply(answer) });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/gateway embeddings/);
  });

  it("by default asks the Keeper for an owner-job ticket on the embeddings route", async () => {
    dispatch.mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [9] }] }), { status: 200 }));
    expect(await makeGatewayEmbedder({ model: "lares-embed" }).embed(["hi"])).toEqual([[9]]);
    const sent = dispatch.mock.calls[0]![0];
    expect(sent).toMatchObject({ alias: "lares-embed", path: "/v1/embeddings" });
    expect(JSON.parse(Buffer.from(sent.rawBody).toString())).toMatchObject({ model: "lares-embed", encoding_format: "float" });
  });
});

describe("makeVoiceStore", () => {
  const embedder = { embed: async (texts: string[]) => texts.map(() => [1, 0]) };

  it("returns the top-k nearest exemplars by cosine similarity", async () => {
    const store = makeVoiceStore({
      embedder,
      exemplars: [
        { id: "a", text: "far", vector: [0, 1] },
        { id: "b", text: "near", vector: [1, 0] },
      ],
    });
    await expect(store.retrieve("q", 1)).resolves.toEqual(["near"]);
  });

  it("filters by language before ranking", async () => {
    const store = makeVoiceStore({
      embedder,
      exemplars: [
        { id: "a", text: "en-one", vector: [1, 0], lang: "en" },
        { id: "b", text: "no-one", vector: [1, 0], lang: "no" },
      ],
    });
    await expect(store.retrieve("q", 1, { lang: "no" })).resolves.toEqual(["no-one"]);
  });

  it("returns [] when the (filtered) pool is empty — no model call needed", async () => {
    const store = makeVoiceStore({ embedder, exemplars: [] });
    await expect(store.retrieve("q", 3)).resolves.toEqual([]);
  });
});
