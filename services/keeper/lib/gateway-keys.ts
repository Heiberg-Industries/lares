import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const AGENT_GATEWAY_BUDGET_USD = 5;
export const AGENT_GATEWAY_BUDGET_DURATION = "1d";
const PURPOSES = ["brain", "writer", "utility", "gate", "embed"] as const;
const requestSignal = () => AbortSignal.timeout(10_000);

export function gatewayModels(aliasPrefix: string): string[] {
  if (!/^[a-z0-9]+$/.test(aliasPrefix) || aliasPrefix === "installation")
    throw new Error("keeper: models.alias_prefix is missing or invalid");
  return PURPOSES.map((purpose) => `${aliasPrefix}-${purpose}`);
}

export interface GatewayKeyOptions {
  gatewayUrl: string;
  masterKeyFile: string;
  secretFile: string;
  name: string;
  aliasPrefix: string;
}

export type GatewayKeyRemovalOptions = Omit<GatewayKeyOptions, "aliasPrefix">;

export interface GatewayKeyProvisioner {
  ensure(options: GatewayKeyOptions): Promise<void>;
  remove(options: GatewayKeyRemovalOptions): Promise<void>;
}

function secretAt(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("keeper: managed gateway key is not a regular file");
    const value = readFileSync(path, "utf8").trimEnd();
    if (!value.startsWith("sk-") || value.length < 16)
      throw new Error("keeper: managed gateway key is invalid");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function persistSecret(path: string, value: string): void {
  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function exactPolicy(info: unknown, name: string, models: string[]): boolean {
  if (!info || typeof info !== "object") return false;
  const row = info as Record<string, unknown>;
  const actualModels = Array.isArray(row.models) && row.models.every((model) => typeof model === "string")
    ? [...row.models].sort()
    : [];
  return row.key_alias === `lares-agent-${name}`
    && row.max_budget === AGENT_GATEWAY_BUDGET_USD
    && row.budget_duration === AGENT_GATEWAY_BUDGET_DURATION
    && row.key_type === "llm_api"
    && actualModels.join("\n") === [...models].sort().join("\n");
}

/**
 * The secret is created locally before LiteLLM sees it. A lost HTTP response therefore leaves a
 * credential Lares still possesses, not an orphan key whose plaintext can never be recovered.
 * Reconciliation looks it up by SHA-256 in a POST body; raw keys never enter URLs or errors.
 */
export class LiteLLMGatewayKeys implements GatewayKeyProvisioner {
  constructor(private request: typeof fetch = globalThis.fetch) {}

  async ensure(options: GatewayKeyOptions): Promise<void> {
    const models = gatewayModels(options.aliasPrefix);
    let key = secretAt(options.secretFile);
    if (!key) {
      key = `sk-${randomBytes(32).toString("base64url")}`;
      persistSecret(options.secretFile, key);
    }
    const masterKey = readFileSync(options.masterKeyFile, "utf8").trimEnd();
    if (!masterKey.startsWith("sk-") || masterKey.length < 16)
      throw new Error("keeper: gateway master key is missing or invalid");

    const url = options.gatewayUrl.replace(/\/$/, "");
    const headers = { authorization: `Bearer ${masterKey}`, "content-type": "application/json" };
    const lookup = async (): Promise<unknown[]> => {
      let response: Response;
      try {
        response = await this.request(`${url}/v2/key/info`, {
          method: "POST", headers, signal: requestSignal(),
          body: JSON.stringify({ keys: [createHash("sha256").update(key!).digest("hex")] }),
        });
      } catch {
        throw new Error("keeper: gateway key lookup did not answer");
      }
      if (!response.ok) throw new Error("keeper: gateway key lookup was refused");
      try {
        const body = await response.json() as { info?: unknown[] };
        return Array.isArray(body.info) ? body.info : [];
      } catch {
        throw new Error("keeper: gateway key lookup returned an invalid response");
      }
    };

    const existing = await lookup();
    if (existing.length) {
      if (existing.length !== 1 || !exactPolicy(existing[0], options.name, models))
        throw new Error("keeper: existing agent gateway key policy does not match this installation");
      return;
    }

    let generated = false;
    try {
      const response = await this.request(`${url}/key/generate`, {
        method: "POST", headers, signal: requestSignal(),
        body: JSON.stringify({
          key,
          key_alias: `lares-agent-${options.name}`,
          key_type: "llm_api",
          models,
          max_budget: AGENT_GATEWAY_BUDGET_USD,
          budget_duration: AGENT_GATEWAY_BUDGET_DURATION,
          metadata: { managed_by: "lares", agent: options.name },
        }),
      });
      generated = response.ok;
    } catch {
      // An interrupted response is ambiguous. The hash lookup below decides whether LiteLLM
      // committed it; the same locally persisted plaintext remains available for a later retry.
    }

    const registered = await lookup();
    if (registered.length === 1 && exactPolicy(registered[0], options.name, models)) return;
    if (registered.length) throw new Error("keeper: generated agent gateway key policy does not match");
    throw new Error(generated
      ? "keeper: gateway did not retain the generated agent key"
      : "keeper: gateway refused the generated agent key");
  }

  async remove(options: GatewayKeyRemovalOptions): Promise<void> {
    const key = secretAt(options.secretFile);
    if (!key) return;
    const masterKey = readFileSync(options.masterKeyFile, "utf8").trimEnd();
    if (!masterKey.startsWith("sk-") || masterKey.length < 16)
      throw new Error("keeper: gateway master key is missing or invalid");
    const url = options.gatewayUrl.replace(/\/$/, "");
    const headers = { authorization: `Bearer ${masterKey}`, "content-type": "application/json" };
    const hash = createHash("sha256").update(key).digest("hex");
    const exists = async (): Promise<boolean> => {
      let response: Response;
      try {
        response = await this.request(`${url}/v2/key/info`, {
          method: "POST", headers, signal: requestSignal(), body: JSON.stringify({ keys: [hash] }),
        });
      } catch {
        throw new Error("keeper: gateway key lookup did not answer");
      }
      if (!response.ok) throw new Error("keeper: gateway key lookup was refused");
      try {
        const body = await response.json() as { info?: unknown[] };
        return Array.isArray(body.info) && body.info.length > 0;
      } catch {
        throw new Error("keeper: gateway key lookup returned an invalid response");
      }
    };
    if (!await exists()) return;
    try {
      await this.request(`${url}/key/delete`, {
        method: "POST", headers, signal: requestSignal(), body: JSON.stringify({ keys: [hash] }),
      });
    } catch {
      // The verification below resolves an interrupted response without exposing or replacing
      // the local key. If deletion did not commit, the explicit delete action can be retried.
    }
    if (await exists()) throw new Error("keeper: gateway did not delete the agent key");
  }
}
