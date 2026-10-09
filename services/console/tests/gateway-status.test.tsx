import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), keeper: vi.fn(), query: vi.fn() }));
vi.mock("../lib/credentials", () => ({ credentialActor: mocks.actor }));
vi.mock("../lib/keeper-client", async original => ({ ...await original<typeof import("../lib/keeper-client")>(), keeper: mocks.keeper }));
vi.mock("../lib/db", () => ({ pool: { query: mocks.query } }));
import { getGatewayStatusView, type GatewayStatusView } from "../lib/gateway-status";
import { ModelsSection } from "../components/ModelsSection";
import { KeeperRefusedError, KeeperUnavailableError } from "../lib/keeper-client";
import type { GatewayStatus } from "@lares/agent-kit/gateway-status";

const purposes = (state: string, brain?: object) => ["brain", "writer", "utility", "gate", "embed"].map((purpose, i) => ({
  purpose, alias: `lares-${purpose}`, state: i === 0 && brain ? "served" : state, ...(i === 0 && brain ? { target: brain } : {}) }));
const status = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  mode: "managed", endpoint: "http://lares-gateway:4000", checkedAt: "2026-10-09T10:00:00.000Z", reachability: "reachable",
  details: { state: "ok", others: [], othersTotal: 0 }, purposes: purposes("not-served", { provider: "anthropic", model: "claude-x" }) as GatewayStatus["purposes"],
  providerTested: false, ...over });
const html = (view: GatewayStatusView) => renderToStaticMarkup(<ModelsSection view={view} />);
const text = (view: GatewayStatusView) => html(view).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  vi.clearAllMocks(); mocks.actor.mockResolvedValue("owner@example.com");
  mocks.keeper.mockResolvedValue(status()); mocks.query.mockResolvedValue({ rows: [{ name: "saga", model: "lares-brain" }, { name: "odd", model: null }] });
});

describe("getGatewayStatusView", () => {
  it("asks the keeper for gateway.status with no input as the signed-in actor", async () => {
    const view = await getGatewayStatusView();
    expect(mocks.keeper).toHaveBeenCalledOnce(); expect(mocks.keeper).toHaveBeenCalledWith("gateway.status", {}, "owner@example.com");
    expect(view).toEqual({ kind: "status", status: status(), usage: { "lares-brain": ["saga"] } });
  });
  it("makes no keeper call without a session", async () => {
    mocks.actor.mockResolvedValue(null);
    expect(await getGatewayStatusView()).toEqual({ kind: "sign-in-required" }); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it("keeper outage is its own value", async () => {
    mocks.keeper.mockRejectedValue(new KeeperUnavailableError("socket"));
    expect(await getGatewayStatusView()).toEqual({ kind: "keeper-unavailable" });
  });
  it("keeper refusal is its own value", async () => {
    mocks.keeper.mockRejectedValue(new KeeperRefusedError("no"));
    expect(await getGatewayStatusView()).toEqual({ kind: "refused" });
  });
  it("an unreadable or secret-bearing result is invalid, not rendered", async () => {
    mocks.keeper.mockResolvedValue({ ...status(), apiKey: "sk-leak" });
    expect(await getGatewayStatusView()).toEqual({ kind: "invalid" });
    mocks.keeper.mockResolvedValue(null);
    expect(await getGatewayStatusView()).toEqual({ kind: "invalid" });
  });
  it("a failed definitions read is usage unavailable, not 'nobody uses it'", async () => {
    mocks.query.mockRejectedValue(new Error("db"));
    expect(await getGatewayStatusView()).toEqual({ kind: "status", status: status(), usage: null });
  });
});

describe("Models section", () => {
  const view = (s: GatewayStatus, usage: Record<string, string[]> | null = { "lares-brain": ["saga"] }): GatewayStatusView => ({ kind: "status", status: s, usage });
  it("reachable and served: address, time, provider and model, agents, and always not tested", () => {
    const t = text(view(status()));
    expect(t).toContain("Models"); expect(t).toContain("http://lares-gateway:4000"); expect(t).toContain("Run by Lares");
    expect(t).toContain("Reachable"); expect(t).toContain("2026-10-09"); expect(t).toContain("anthropic"); expect(t).toContain("claude-x");
    expect(t).toContain("saga"); expect(t).toContain("Not served by this gateway");
    expect(t).toContain("Provider not tested: testing sends a paid request");
  });
  it("unreachable says so and never shows a purpose as served", () => {
    const t = text(view(status({ reachability: "unreachable", details: { state: "unavailable" }, purposes: purposes("unknown") as GatewayStatus["purposes"] })));
    expect(t).toContain("Not reachable"); expect(t).not.toContain("Not served"); expect(t).toContain("Unknown");
  });
  it("each failure has its own words", () => {
    const words = new Map<string, string>();
    const add = (k: string, v: GatewayStatusView) => words.set(k, text(v));
    add("keeper", { kind: "keeper-unavailable" }); add("refusedKeeper", { kind: "refused" }); add("wholeInvalid", { kind: "invalid" });
    add("notready", view(status({ reachability: "not-ready" }))); add("unreadable", view(status({ reachability: "readiness-unreadable" })));
    add("notconf", view(status({ mode: null, endpoint: null, reachability: "not-configured", details: { state: "unavailable" }, purposes: [] })));
    for (const s of ["refused", "invalid", "unavailable", "key-unreadable", "not-managed", "aliases-unknown"] as const)
      add(s, view(status({ details: { state: s }, purposes: purposes("unknown") as GatewayStatus["purposes"] })));
    expect(words.get("keeper")).toContain("Gateway status unavailable"); expect(words.get("keeper")).toContain("server helper did not answer");
    expect(words.get("notready")).toContain("Running but not ready");
    expect(words.get("notconf")).toContain("No gateway configured");
    expect(words.get("refused")).toContain("Details refused by the gateway");
    expect(words.get("wholeInvalid")).toContain("Gateway status could not be read");
    expect(words.get("not-managed")).toContain("Managed outside Lares");
    expect(words.get("key-unreadable")).toContain("key");
    expect(words.get("aliases-unknown")).toContain("could not read its own alias settings");
    expect(new Set(words.values()).size).toBe(words.size);
  });
  it("usage unavailable is stated, not shown as no agents", () => {
    expect(text(view(status(), null))).toContain("Agents using it: unavailable");
    expect(text(view(status(), {}))).toContain("No agent uses it");
  });
  it("hidden target and other models", () => {
    const s = status({ details: { state: "ok", others: ["stray-model"], othersTotal: 1 }, purposes: purposes("served-target-hidden") as GatewayStatus["purposes"] });
    const t = text(view(s));
    expect(t).toContain("Served, model not shown by the gateway"); expect(t).toContain("stray-model");
  });
  it("says how many more other models there are", () => {
    const others = Array.from({ length: 200 }, (_, i) => `m${i}`);
    expect(text(view(status({ details: { state: "ok", others, othersTotal: 250 } })))).toContain("and 50 more");
  });
  it("readiness-unreadable gets a neutral badge, not Not ready", () => {
    const t = text(view(status({ reachability: "readiness-unreadable" })));
    expect(t).toContain("Readiness unclear"); expect(t).not.toContain("Not ready");
  });
  it("is read-only: a plain link to reload, no form, no button", () => {
    const h = html(view(status()));
    expect(h).not.toMatch(/<form|<button|method=/i); expect(h).toContain('href="/settings"');
  });
});
