import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpsProxyAgent } from "https-proxy-agent";

import {
  LangfuseNotConfiguredError,
  langfuseExporterConfig,
  isLangfuseConfigured,
} from "../src/langfuse-otel.js";

/**
 * Langfuse ingests OpenTelemetry over OTLP/HTTP with HTTP Basic auth: the public key as the
 * username, the secret key as the password. Both come from a box secret file, read at
 * startup, never at module scope — `eve build` loads this module in CI, which has no
 * secrets.
 */

let dir: string;
let keyFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-langfuse-"));
  keyFile = join(dir, "langfuse-keys");
  writeFileSync(keyFile, "pk-lf-public\nsk-lf-secret\n");
  process.env["LANGFUSE_KEY_FILE"] = keyFile;
  delete process.env["LANGFUSE_HOST"];
  delete process.env["LANGFUSE_PROXY_URL"];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["LANGFUSE_KEY_FILE"];
  delete process.env["LANGFUSE_HOST"];
  delete process.env["LANGFUSE_PROXY_URL"];
});

describe("isLangfuseConfigured", () => {
  it("is true when the key file is readable", () => {
    expect(isLangfuseConfigured()).toBe(true);
  });

  it("is false when the key file is absent, so the app still boots", () => {
    // Telemetry must never be load-bearing. A missing key file is a degraded state that
    // logs loudly, not a crash that takes the agent down.
    process.env["LANGFUSE_KEY_FILE"] = join(dir, "not-there");
    expect(isLangfuseConfigured()).toBe(false);
  });
});

describe("langfuseExporterConfig", () => {
  it("targets Langfuse's OTLP traces endpoint on the EU host by default", () => {
    // EU by default is the vendor-sovereignty default, not an accident: cloud.langfuse.com
    // is the EU region; the US region is a different hostname.
    expect(langfuseExporterConfig().url).toBe(
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });

  it("honours LANGFUSE_HOST for a self-hosted or region-specific instance", () => {
    process.env["LANGFUSE_HOST"] = "https://langfuse.example.com";
    expect(langfuseExporterConfig().url).toBe(
      "https://langfuse.example.com/api/public/otel/v1/traces",
    );
  });

  it("trims a trailing slash on the host rather than emitting a double slash", () => {
    process.env["LANGFUSE_HOST"] = "https://cloud.langfuse.com/";
    expect(langfuseExporterConfig().url).toBe(
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });

  it("authenticates with HTTP Basic: public key as user, secret key as password", () => {
    const expected = "Basic " + Buffer.from("pk-lf-public:sk-lf-secret").toString("base64");
    expect(langfuseExporterConfig().headers["Authorization"]).toBe(expected);
  });

  it("sends the v4 ingestion header Langfuse Cloud requires from 2026-11-16", () => {
    // Without this header, Langfuse Cloud's legacy ingestion path (removed on the cutoff
    // date) is the only one that accepts our batches — see LAR-66.
    expect(langfuseExporterConfig().headers["x-langfuse-ingestion-version"]).toBe("4");
  });

  it("reads the two keys from two lines and tolerates trailing whitespace", () => {
    writeFileSync(keyFile, "  pk-lf-public  \n  sk-lf-secret  \n\n");
    const expected = "Basic " + Buffer.from("pk-lf-public:sk-lf-secret").toString("base64");
    expect(langfuseExporterConfig().headers["Authorization"]).toBe(expected);
  });

  it("has no agent factory when no proxy is configured, so a local run exports directly", () => {
    expect(langfuseExporterConfig().httpAgentOptions).toBeUndefined();
  });

  it("routes through the proxy when LANGFUSE_PROXY_URL is set", () => {
    // On the box this is not optional: the seal permits gateway + db + slack-proxy + DNS
    // only, so an unproxied POST dies as a HANG rather than an error.
    process.env["LANGFUSE_PROXY_URL"] = "http://slack-proxy:8888";
    const factory = langfuseExporterConfig().httpAgentOptions;
    expect(factory).toBeTypeOf("function");
    const agent = factory!();
    expect(agent).toBeInstanceOf(HttpsProxyAgent);
    // One agent reused across batches, not a fresh CONNECT tunnel per flush.
    expect(factory!()).toBe(agent);
  });

  it("throws a typed error naming the file when it is missing", () => {
    process.env["LANGFUSE_KEY_FILE"] = join(dir, "not-there");
    expect(() => langfuseExporterConfig()).toThrow(LangfuseNotConfiguredError);
    expect(() => langfuseExporterConfig()).toThrow(/not-there/);
  });

  it("throws when the file has only one line — a half-configured exporter is a silent one", () => {
    // The failure this prevents: a one-line file yields an undefined secret, the Basic
    // header is built anyway, Langfuse 401s every batch, and nothing ever appears while
    // the agent looks perfectly healthy.
    writeFileSync(keyFile, "pk-lf-public\n");
    expect(() => langfuseExporterConfig()).toThrow(LangfuseNotConfiguredError);
  });

  it("never puts a key in the error message", () => {
    writeFileSync(keyFile, "pk-lf-public\n");
    expect(() => langfuseExporterConfig()).not.toThrow(/pk-lf-public/);
  });
});
