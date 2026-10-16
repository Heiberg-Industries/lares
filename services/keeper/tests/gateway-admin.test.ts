import { describe, expect, it, vi } from "vitest";
import { GatewayAdmin, GATEWAY_ROUTES } from "../lib/gateway-admin.js";

const CANARY = "sk-canary-admin-key-0123456789";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const admin = (fn: (url: string, init?: RequestInit) => Promise<Response>) => {
  const f = vi.fn(fn);
  return { f, gw: new GatewayAdmin("http://gateway.example:4000/", f as unknown as typeof fetch) };
};

describe("allowlist", () => {
  it("is exactly three routes", () => {
    expect([...Object.values(GATEWAY_ROUTES)].sort()).toEqual(["/health/liveliness", "/health/readiness", "/v1/model/info"]);
  });
  it.each(["/health", "/health/", "/health/readiness/details", "/health/liveliness?x=1", "/key/info", "/v2/key/info",
    "/model/info", "/v1/models", "//evil.example/health/liveliness", "http://evil.example/v1/model/info", "/v1/model/info/../../key/list", ""])(
    "refuses %j in code without any request", async path => {
      const { f, gw } = admin(async () => json({}));
      await expect(gw.call(path, CANARY)).rejects.toThrow("route not allowed");
      expect(f).not.toHaveBeenCalled();
    });
  it("only ever sends GET, to the configured origin, without following redirects", async () => {
    const { f, gw } = admin(async () => json({ data: [] }));
    await gw.liveliness(); await gw.readiness(); await gw.modelInfo(CANARY);
    expect(f.mock.calls.map(c => c[0])).toEqual(["http://gateway.example:4000/health/liveliness", "http://gateway.example:4000/health/readiness", "http://gateway.example:4000/v1/model/info"]);
    for (const [, init] of f.mock.calls) { expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeTruthy(); }
  });
  it("sends the key only to model info", async () => {
    const { f, gw } = admin(async () => json({ data: [] }));
    await gw.liveliness(); await gw.readiness(); await gw.modelInfo(CANARY);
    const auth = f.mock.calls.map(c => (c[1]?.headers as Record<string, string> | undefined)?.authorization);
    expect(auth).toEqual([undefined, undefined, `Bearer ${CANARY}`]);
  });
  it("does not retry", async () => {
    const { f, gw } = admin(async () => { throw new Error("down"); });
    await gw.liveliness(); expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("liveliness", () => {
  it("ok on 200", async () => expect(await admin(async () => json("I'm alive!")).gw.liveliness()).toEqual({ kind: "ok" }));
  it.each([500, 404, 302])("unreachable on %s", async s => expect(await admin(async () => new Response("x", { status: s })).gw.liveliness()).toEqual({ kind: "unreachable" }));
  it("unreachable on network error or timeout", async () => expect(await admin(async () => { throw new Error("ECONNREFUSED"); }).gw.liveliness()).toEqual({ kind: "unreachable" }));
});

describe("readiness", () => {
  it("ready when db connected", async () => expect(await admin(async () => json({ status: "healthy", db: "connected" })).gw.readiness()).toEqual({ kind: "ready" }));
  it("not-ready on 503", async () => expect(await admin(async () => json({ status: "unhealthy" }, 503)).gw.readiness()).toEqual({ kind: "not-ready" }));
  it("not-ready when db is not connected", async () => expect(await admin(async () => json({ status: "healthy", db: "Not connected" })).gw.readiness()).toEqual({ kind: "not-ready" }));
  it("unreadable when 200 but not the expected body", async () => {
    expect(await admin(async () => new Response("<html>")).gw.readiness()).toEqual({ kind: "unreadable" });
    expect(await admin(async () => json({ status: "healthy" })).gw.readiness()).toEqual({ kind: "unreadable" });
    expect(await admin(async () => json([1])).gw.readiness()).toEqual({ kind: "unreadable" });
  });
  it("unreachable on network error", async () => expect(await admin(async () => { throw new Error("x"); }).gw.readiness()).toEqual({ kind: "unreachable" }));
  it.each([404, 500, 502])("unreadable (not unreachable) when the gateway answered %s", async s => expect(await admin(async () => new Response("", { status: s })).gw.readiness()).toEqual({ kind: "unreadable" }));
});

describe("model info", () => {
  const entry = (name: string, model?: string) => ({ model_name: name, litellm_params: model ? { model } : {}, model_info: {} });
  it("splits provider at the first slash only", async () => {
    const r = await admin(async () => json({ data: [entry("lares-brain", "anthropic/claude-x"), entry("other", "hosted_vllm/org/model")] })).gw.modelInfo(CANARY);
    expect(r).toEqual({ kind: "ok", models: [{ alias: "lares-brain", target: { provider: "anthropic", model: "claude-x" } }, { alias: "other", target: { provider: "hosted_vllm", model: "org/model" } }] });
  });
  it("lists an alias with no or unsplittable target as hidden", async () => {
    const r = await admin(async () => json({ data: [entry("a"), entry("b", "noslash"), entry("c", "/x"), entry("d", "x/")] })).gw.modelInfo(CANARY);
    expect(r).toEqual({ kind: "ok", models: ["a", "b", "c", "d"].map(alias => ({ alias, target: null })) });
  });
  it("hides the target when deployments of one alias disagree, and keeps one row", async () => {
    const r = await admin(async () => json({ data: [entry("a", "x/one"), entry("a", "y/two"), entry("b", "x/one"), entry("b", "x/one")] })).gw.modelInfo(CANARY);
    expect(r).toEqual({ kind: "ok", models: [{ alias: "a", target: null }, { alias: "b", target: { provider: "x", model: "one" } }] });
  });
  it("never returns api_key or api_base content", async () => {
    const body = { data: [{ model_name: "a", litellm_params: { model: "x/y", api_key: CANARY, api_base: "http://secret.internal" }, model_info: { api_key: CANARY } }] };
    const text = JSON.stringify(await admin(async () => json(body)).gw.modelInfo(CANARY));
    expect(text).not.toContain(CANARY); expect(text).not.toContain("secret.internal");
  });
  it.each([401, 403])("refused on %s", async s => expect(await admin(async () => json({ error: CANARY }, s)).gw.modelInfo(CANARY)).toEqual({ kind: "refused" }));
  it.each([500, 503, 302])("unavailable on %s", async s => expect(await admin(async () => new Response("x", { status: s })).gw.modelInfo(CANARY)).toEqual({ kind: "unavailable" }));
  it("unavailable on network error", async () => expect(await admin(async () => { throw new Error(CANARY); }).gw.modelInfo(CANARY)).toEqual({ kind: "unavailable" }));
  it.each([["not json", new Response("nope")], ["no data", json({})], ["data not array", json({ data: {} })], ["entry without name", json({ data: [{ litellm_params: {} }] })], ["entry not object", json({ data: [1] })]])(
    "invalid when %s", async (_n, response) => expect(await admin(async () => response).gw.modelInfo(CANARY)).toEqual({ kind: "invalid" }));
});
