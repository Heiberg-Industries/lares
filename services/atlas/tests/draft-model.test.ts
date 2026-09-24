import { describe, it, expect } from "vitest";
import { makeGatewayDraftModel } from "../lib/adapters/draft-model.js";
import { SECTIONS } from "../lib/narrative.js";
import type { ResolvedSource } from "../lib/resolve.js";

const sources: ResolvedSource[] = [
  { ref: { prefix: "repo", locator: "README.md", declared: "repo:README.md" }, outcome: "found", content: "# Murmur\n" },
];

const reply = (obj: unknown) => new Response(JSON.stringify({
  content: [{ type: "text", text: JSON.stringify(obj) }],
}), { status: 200, headers: { "content-type": "application/json" } });

const sections = Object.fromEntries(SECTIONS.map((s) => [s, `text for ${s}`]));

describe("makeGatewayDraftModel", () => {
  it("returns the parsed sections", async () => {
    const m = makeGatewayDraftModel({ url: "https://gw/anthropic", apiKey: "k", model: "test-model", fetch: async () => reply({ sections }) });
    expect((await m.draft({ brand: "murmur", currentBody: "old", sources })).sections["## Target"]).toBe("text for ## Target");
  });

  it("sends the model id it was given and never one of its own", async () => {
    let body: any;
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "configured-model",
      fetch: async (_u, init) => { body = JSON.parse(String(init!.body)); return reply({ sections }); },
    });
    await m.draft({ brand: "murmur", currentBody: "old", sources });
    expect(body.model).toBe("configured-model");
  });

  it("puts the never-guess rule and the business-only rule in the prompt", async () => {
    let body: any;
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "m",
      fetch: async (_u, init) => { body = JSON.parse(String(init!.body)); return reply({ sections }); },
    });
    await m.draft({ brand: "murmur", currentBody: "old", sources });
    const prompt = JSON.stringify(body);
    expect(prompt).toMatch(/never guess/i);
    expect(prompt).toMatch(/—/);
    expect(prompt).toMatch(/no personal/i);
  });

  it("labels each source with its declared reference so the model can attribute", async () => {
    let body: any;
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "m",
      fetch: async (_u, init) => { body = JSON.parse(String(init!.body)); return reply({ sections }); },
    });
    await m.draft({ brand: "murmur", currentBody: "old", sources });
    expect(JSON.stringify(body)).toContain("repo:README.md");
  });

  it("THROWS on a non-2xx rather than returning empty sections", async () => {
    const m = makeGatewayDraftModel({ url: "https://gw/anthropic", apiKey: "k", model: "m", fetch: async () => new Response("nope", { status: 500 }) });
    await expect(m.draft({ brand: "murmur", currentBody: "old", sources })).rejects.toThrow(/500/);
  });

  it("THROWS on a reply missing a section, rather than filling the gap", async () => {
    const partial = { ...sections };
    delete (partial as Record<string, string>)["## Target"];
    const m = makeGatewayDraftModel({ url: "https://gw/anthropic", apiKey: "k", model: "m", fetch: async () => reply({ sections: partial }) });
    await expect(m.draft({ brand: "murmur", currentBody: "old", sources })).rejects.toThrow(/## Target/);
  });

  it("THROWS on unparseable JSON rather than proposing prose it did not understand", async () => {
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "m",
      fetch: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "sorry, I can't" }] }), { status: 200 }),
    });
    await expect(m.draft({ brand: "murmur", currentBody: "old", sources })).rejects.toThrow(/JSON/i);
  });

  it("does not leak the API key into a thrown error message", async () => {
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "super-secret-key-value", model: "m",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    let message = "";
    try {
      await m.draft({ brand: "murmur", currentBody: "old", sources });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("super-secret-key-value");
  });

  it("THROWS a branded error, not a raw SyntaxError, on a non-JSON 200 (an HTML error page from a proxy)", async () => {
    // Nothing partial is ever returned either way — the safety property holds regardless —
    // but the operator gets an "atlas: …" sentence naming the brand and what came back,
    // not a bare `Unexpected token '<'` with no idea which note or gateway call it was.
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "m",
      fetch: async () => new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200, headers: { "content-type": "text/html" },
      }),
    });
    await expect(m.draft({ brand: "murmur", currentBody: "old", sources })).rejects.toThrow(/^atlas:/);
  });

  it("THROWS a branded error, not a raw SyntaxError, on an EMPTY 200 body", async () => {
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "m",
      fetch: async () => new Response("", { status: 200 }),
    });
    await expect(m.draft({ brand: "murmur", currentBody: "old", sources })).rejects.toThrow(/^atlas:/);
  });

  it("THROWS a branded error, not a raw TypeError, on a literal `null` JSON reply", async () => {
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "m",
      fetch: async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(m.draft({ brand: "murmur", currentBody: "old", sources })).rejects.toThrow(/^atlas:/);
  });

  it("THROWS a branded error, not a raw TypeError, when fetch() itself rejects (network failure, DNS, abort)", async () => {
    // This is the one an egress-blocked box actually hits — the sealed-agent posture means
    // an outbound call that never reaches the gateway at all is the REALISTIC failure, not
    // a hypothetical one. The operator needs "atlas: ..." naming the brand, not a bare
    // "TypeError: fetch failed" with no idea which note's drafting call it was.
    const m = makeGatewayDraftModel({
      url: "https://gw/anthropic", apiKey: "k", model: "m",
      fetch: async () => { throw new TypeError("fetch failed"); },
    });
    await expect(m.draft({ brand: "murmur", currentBody: "old", sources })).rejects.toThrow(/^atlas:/);
  });

  it("refuses to be constructed without a model id — 'which model' must never be a silent question", () => {
    expect(() => makeGatewayDraftModel({ url: "https://gw/anthropic", apiKey: "k", model: "" }))
      .toThrow(/model/i);
    expect(() => makeGatewayDraftModel({ url: "https://gw/anthropic", apiKey: "k", model: "   " }))
      .toThrow(/model/i);
    expect(() => makeGatewayDraftModel({ url: "https://gw/anthropic", apiKey: "k", model: undefined as unknown as string }))
      .toThrow(/model/i);
  });
});
