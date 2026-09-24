import { readFileSync } from "node:fs";
import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";

/**
 * Langfuse as an OpenTelemetry backend.
 *
 * Langfuse ingests OTLP/HTTP with HTTP Basic auth: public key as username, secret key as
 * password. Both live in one box secret file, two lines, read at startup and never at
 * module scope — `eve build` evaluates this module in CI, which has no secrets.
 */

const DEFAULT_KEY_FILE = "/run/secrets/langfuse-keys";
/** EU region. The US region is a different hostname, and that is a sovereignty choice. */
const DEFAULT_HOST = "https://cloud.langfuse.com";
const OTLP_TRACES_PATH = "/api/public/otel/v1/traces";

/**
 * Telemetry is not configured, or is configured wrong.
 *
 * Typed and thrown rather than swallowed, because the failure mode being avoided is the
 * quiet one: a half-filled key file builds a Basic header anyway, Langfuse 401s every
 * batch, and nothing ever arrives while the agent looks perfectly healthy.
 */
export class LangfuseNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Langfuse telemetry not configured: ${reason}`);
    this.name = "LangfuseNotConfiguredError";
  }
}

function keyFilePath(): string {
  return process.env["LANGFUSE_KEY_FILE"] ?? DEFAULT_KEY_FILE;
}

/** Whether the key file is readable at all. Used to decide whether to register an exporter. */
export function isLangfuseConfigured(): boolean {
  try {
    return readFileSync(keyFilePath(), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export interface LangfuseExporterConfig {
  url: string;
  headers: Record<string, string>;
  /**
   * Passed to the OTLP exporter as `httpAgentOptions`. That option accepts either agent
   * OPTIONS or, when it is a function, an agent FACTORY — which is the only seam the
   * exporter offers for injecting a proxy agent
   * (`@opentelemetry/otlp-exporter-base` → `convertLegacyAgentOptions`).
   *
   * It has to be a proxy: each agent's box seal permits gateway + db + slack-proxy + DNS
   * only, so a direct POST to Langfuse dies as a HANG, not an error — the ORB-51 failure
   * shape. Left undefined when no proxy is configured, so a local run still exports
   * directly.
   */
  httpAgentOptions?: () => Agent;
}

export function langfuseExporterConfig(): LangfuseExporterConfig {
  const path = keyFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new LangfuseNotConfiguredError(`secret file not readable: ${path}`);
  }

  const [publicKey, secretKey] = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (publicKey === undefined || secretKey === undefined) {
    // Never echo what WAS found — the one line present may well be the secret key.
    throw new LangfuseNotConfiguredError(
      `expected two non-empty lines (public key, then secret key) in ${path}`,
    );
  }

  const host = (process.env["LANGFUSE_HOST"] ?? DEFAULT_HOST).replace(/\/+$/u, "");
  const proxy = process.env["LANGFUSE_PROXY_URL"]?.trim();
  return {
    url: `${host}${OTLP_TRACES_PATH}`,
    headers: {
      Authorization: "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64"),
      // Langfuse Cloud's legacy ingestion path is removed on 2026-11-16, after which this
      // header is required to reach the v4 engine. See the migration guide:
      // https://langfuse.com/integrations/native/opentelemetry/migration-to-v4
      "x-langfuse-ingestion-version": "4",
    },
    // Constructed once here and returned by the factory, so every export batch reuses one
    // agent (and one pooled tunnel) rather than opening a fresh CONNECT per flush.
    ...(proxy !== undefined && proxy.length > 0
      ? { httpAgentOptions: ((agent) => () => agent)(new HttpsProxyAgent(proxy)) }
      : {}),
  };
}
