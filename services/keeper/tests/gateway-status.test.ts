import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayStatusSchema } from "@lares/agent-kit/gateway-status";
import { GatewayStatusReader, registerGatewayStatusAction } from "../lib/gateway-status.js";
import { resetActions, runAction, actionNames, type AuditRecord } from "../lib/actions.js";
import type { GatewayAdmin } from "../lib/gateway-admin.js";

const CANARY = "sk-canary-admin-key-0123456789";
const dir = mkdtempSync(join(tmpdir(), "gw-"));
const keyFile = join(dir, "master"); writeFileSync(keyFile, `${CANARY}\n`);
const badKey = join(dir, "bad"); writeFileSync(badKey, "nope");
const NOW = new Date("2026-10-09T10:00:00.000Z");

type Cfg = { url?: string | null; key?: string | null; prefix?: () => Promise<unknown> };
function reader(over: Partial<Record<"liveliness" | "readiness" | "modelInfo", unknown>> = {}, cfg: Cfg = {}) {
  const admin = {
    liveliness: vi.fn(async () => over.liveliness ?? { kind: "ok" }),
    readiness: vi.fn(async () => over.readiness ?? { kind: "ready" }),
    modelInfo: vi.fn(async () => over.modelInfo ?? { kind: "ok", models: [] }),
  };
  const r = new GatewayStatusReader({
    gatewayUrl: cfg.url === null ? undefined : cfg.url ?? "http://lares-gateway:4000/some/path?token=x",
    masterKeyFile: cfg.key === null ? undefined : cfg.key ?? keyFile,
    aliasPrefix: cfg.prefix ?? (async () => "lares"), admin: admin as unknown as GatewayAdmin, now: () => NOW });
  return { r, admin };
}
const states = (s: Awaited<ReturnType<GatewayStatusReader["read"]>>) => Object.fromEntries(s.purposes.map(p => [p.purpose, p.state]));

describe("gateway status", () => {
  it("managed, reachable, one alias served with its target", async () => {
    const { r } = reader({ modelInfo: { kind: "ok", models: [{ alias: "lares-brain", target: { provider: "anthropic", model: "claude-x" } }, { alias: "stray", target: null }] } });
    const s = await r.read();
    expect(gatewayStatusSchema.parse(s)).toEqual(s);
    expect(s).toMatchObject({ mode: "managed", endpoint: "http://lares-gateway:4000", checkedAt: NOW.toISOString(), reachability: "reachable", providerTested: false, details: { state: "ok", others: ["stray"] } });
    expect(states(s)).toEqual({ brain: "served", writer: "not-served", utility: "not-served", gate: "not-served", embed: "not-served" });
    expect(s.purposes[0]).toMatchObject({ alias: "lares-brain", target: { provider: "anthropic", model: "claude-x" } });
  });
  it("served-target-hidden when listed without a target", async () => {
    const s = await reader({ modelInfo: { kind: "ok", models: [{ alias: "lares-writer", target: null }] } }).r.read();
    expect(states(s).writer).toBe("served-target-hidden"); expect(s.purposes[1]!.target).toBeUndefined();
  });
  it("unreachable: details unavailable, purposes unknown, no key call", async () => {
    const { r, admin } = reader({ liveliness: { kind: "unreachable" } });
    const s = await r.read();
    expect(s.reachability).toBe("unreachable"); expect(s.details).toEqual({ state: "unavailable" });
    expect(Object.values(states(s))).toEqual(Array(5).fill("unknown"));
    expect(admin.readiness).not.toHaveBeenCalled(); expect(admin.modelInfo).not.toHaveBeenCalled();
  });
  it("not-ready still reads details", async () => {
    const { r, admin } = reader({ readiness: { kind: "not-ready" } });
    expect((await r.read()).reachability).toBe("not-ready"); expect(admin.modelInfo).toHaveBeenCalledTimes(1);
  });
  it("readiness-unreadable is its own value", async () => expect((await reader({ readiness: { kind: "unreadable" } }).r.read()).reachability).toBe("readiness-unreadable"));
  it("readiness unreachable after liveliness ok is unreachable", async () => expect((await reader({ readiness: { kind: "unreachable" } }).r.read()).reachability).toBe("unreachable"));
  it.each(["refused", "invalid", "unavailable"])("details %s keeps reachability truthful and purposes unknown", async kind => {
    const s = await reader({ modelInfo: { kind } }).r.read();
    expect(s.reachability).toBe("reachable"); expect(s.details).toEqual({ state: kind });
    expect(Object.values(states(s))).toEqual(Array(5).fill("unknown"));
  });
  it("external: no key read, reachability only, details not-managed", async () => {
    const { r, admin } = reader({}, { key: null });
    const s = await r.read();
    expect(s).toMatchObject({ mode: "external", reachability: "reachable", details: { state: "not-managed" } });
    expect(admin.modelInfo).not.toHaveBeenCalled(); expect(Object.values(states(s))).toEqual(Array(5).fill("unknown"));
  });
  it("unreadable key file", async () => {
    const { r, admin } = reader({}, { key: badKey });
    expect((await r.read()).details).toEqual({ state: "key-unreadable" }); expect(admin.modelInfo).not.toHaveBeenCalled();
    expect((await reader({}, { key: join(dir, "missing") }).r.read()).details).toEqual({ state: "key-unreadable" });
  });
  it("not-configured when the keeper has no gateway address", async () => {
    const { r, admin } = reader({}, { url: null });
    const s = await r.read();
    expect(s).toMatchObject({ mode: null, endpoint: null, reachability: "not-configured", details: { state: "unavailable" }, purposes: [] });
    expect(admin.liveliness).not.toHaveBeenCalled();
  });
  it("unusable alias prefix leaves purposes empty and details unavailable", async () => {
    for (const prefix of [async () => { throw new Error("db"); }, async () => undefined, async () => "Bad Prefix"]) {
      const s = await reader({}, { prefix }).r.read();
      expect(s.purposes).toEqual([]); expect(s.details).toEqual({ state: "unavailable" });
    }
  });
  it("never carries the key", async () => expect(JSON.stringify(await reader().r.read())).not.toContain(CANARY));
});

describe("gateway.status action", () => {
  beforeEach(resetActions);
  const ctx = () => ({ actor: "owner@example.com", audit: vi.fn(async (_r: AuditRecord) => { }) });
  it("is audited as pending then ok, takes no input, returns the contract", async () => {
    const c = ctx(); registerGatewayStatusAction(reader().r);
    expect(actionNames()).toContain("gateway.status");
    const out = await runAction("gateway.status", {}, c);
    expect(gatewayStatusSchema.parse(out)).toBeTruthy();
    expect(c.audit.mock.calls.map(([x]) => x.outcome)).toEqual(["pending", "ok"]);
    expect(JSON.stringify(c.audit.mock.calls)).not.toContain(CANARY);
    expect(c.audit.mock.calls[1]![0].detail).toBe(JSON.stringify({ reachability: "reachable", details: "ok" }));
  });
  it("refuses any input so nothing can be echoed", async () => {
    const c = ctx(); const { r, admin } = reader(); registerGatewayStatusAction(r);
    await expect(runAction("gateway.status", { url: "http://evil.example", key: CANARY }, c)).rejects.toThrow("invalid input");
    expect(admin.liveliness).not.toHaveBeenCalled(); expect(JSON.stringify(c.audit.mock.calls)).not.toContain(CANARY);
  });
});
