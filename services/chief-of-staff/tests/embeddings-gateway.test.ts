import { describe, it, expect } from "vitest";
import { makeGatewayEmbedder, makeVoiceStore } from "../lib/embeddings-gateway.js";

describe("makeGatewayEmbedder", () => {
  it("POSTs to <gateway>/v1/embeddings with the model + input, and forces identity encoding", async () => {
    let url = ""; let init: any;
    const fakeFetch = (async (u: any, i: any) => {
      url = String(u); init = i;
      return { ok: true, json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) } as any;
    }) as any;
    const embedder = makeGatewayEmbedder({
      gatewayUrl: "https://gateway.example.com", apiKey: "k", model: "jina-embeddings-v3", fetchImpl: fakeFetch,
    });
    const vectors = await embedder.embed(["hello"]);
    expect(vectors).toEqual([[1, 2, 3]]);
    expect(url).toBe("https://gateway.example.com/v1/embeddings");
    expect(init.headers["Authorization"]).toBe("Bearer k");
    expect(init.headers["Accept-Encoding"]).toBe("identity");
    expect(JSON.parse(init.body)).toEqual({ model: "jina-embeddings-v3", input: ["hello"] });
  });

  it("throws with the status + a snippet of the body on a non-ok response", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 500, text: async () => "boom" }) as any) as any;
    const embedder = makeGatewayEmbedder({ gatewayUrl: "https://g", apiKey: "k", model: "m", fetchImpl: fakeFetch });
    await expect(embedder.embed(["x"])).rejects.toThrow(/500.*boom/);
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
