import { readFileSync } from "node:fs";
import { GATEWAY_PURPOSES, gatewayStatusInput, gatewayStatusSchema, type GatewayStatus, type GatewayPurposeStatus } from "@lares/agent-kit/gateway-status";
import { registerAction } from "./actions.js";
import { gatewayModels } from "./gateway-keys.js";
import type { GatewayAdmin, GatewayModel } from "./gateway-admin.js";

export interface GatewayStatusConfig {
  /** `runtime.gatewayUrl`; absent when the keeper has no lifecycle configuration. */
  gatewayUrl: string | undefined;
  /** Present only when Lares runs the gateway (it holds the admin key). */
  masterKeyFile: string | undefined;
  aliasPrefix: () => Promise<unknown>;
  admin: GatewayAdmin;
  now?: () => Date;
}

/** Reads gateway status for the console. Never calls a model; see gateway-admin.ts. */
export class GatewayStatusReader {
  constructor(private cfg: GatewayStatusConfig) {}

  private key(): string | null {
    try {
      const value = readFileSync(this.cfg.masterKeyFile!, "utf8").trimEnd();
      return value.startsWith("sk-") && value.length >= 16 ? value : null;
    } catch { return null; }
  }
  private async aliases(): Promise<string[] | null> {
    try {
      const prefix = await this.cfg.aliasPrefix();
      return typeof prefix === "string" ? gatewayModels(prefix) : null;
    } catch { return null; }
  }
  private purposes(aliases: string[] | null, models: GatewayModel[] | null): GatewayPurposeStatus[] {
    if (!aliases) return [];
    return GATEWAY_PURPOSES.map((purpose, i): GatewayPurposeStatus => {
      const alias = aliases[i]!;
      if (!models) return { purpose, alias, state: "unknown" };
      const found = models.find(m => m.alias === alias);
      if (!found) return { purpose, alias, state: "not-served" };
      return found.target ? { purpose, alias, state: "served", target: found.target } : { purpose, alias, state: "served-target-hidden" };
    });
  }

  async read(): Promise<GatewayStatus> {
    const checkedAt = (this.cfg.now?.() ?? new Date()).toISOString();
    const base = { checkedAt, providerTested: false as const };
    if (!this.cfg.gatewayUrl)
      return gatewayStatusSchema.parse({ ...base, mode: null, endpoint: null, reachability: "not-configured", details: { state: "unavailable" }, purposes: [] });
    const mode = this.cfg.masterKeyFile ? "managed" as const : "external" as const;
    const endpoint = new URL(this.cfg.gatewayUrl).origin;
    const aliases = await this.aliases();
    const result = (reachability: GatewayStatus["reachability"], details: GatewayStatus["details"], models: GatewayModel[] | null = null) =>
      gatewayStatusSchema.parse({ ...base, mode, endpoint, reachability, details: aliases ? details : { state: "aliases-unknown" }, purposes: this.purposes(aliases, models) });

    if ((await this.cfg.admin.liveliness()).kind !== "ok") return result("unreachable", { state: "unavailable" });
    const readiness = await this.cfg.admin.readiness();
    const reachability: GatewayStatus["reachability"] = readiness.kind === "ready" ? "reachable"
      : readiness.kind === "not-ready" ? "not-ready" : readiness.kind === "unreadable" ? "readiness-unreadable" : "unreachable";
    if (readiness.kind === "unreachable") return result(reachability, { state: "unavailable" });
    if (mode === "external") return result(reachability, { state: "not-managed" });
    const key = this.key();
    if (!key) return result(reachability, { state: "key-unreadable" });
    const info = await this.cfg.admin.modelInfo(key);
    if (info.kind !== "ok") return result(reachability, { state: info.kind });
    const names = new Set(aliases ?? []);
    const others = info.models.map(m => m.alias).filter(a => !names.has(a));
    return result(reachability, { state: "ok", others: others.slice(0, 200), othersTotal: others.length }, info.models);
  }
}

export function registerGatewayStatusAction(reader: GatewayStatusReader): void {
  registerAction({
    name: "gateway.status", input: gatewayStatusInput, run: () => reader.read(),
    successDetail: result => { const s = gatewayStatusSchema.parse(result); return JSON.stringify({ reachability: s.reachability, details: s.details.state }); },
  });
}
