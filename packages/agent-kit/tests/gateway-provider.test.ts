import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGatewayProvider } from "../src/gateway-provider.js";

// Unlike the old per-agent module (one module-scope cache shared by the whole test file,
// which needed vi.resetModules() + a dynamic import to isolate tests from each other), each
// createGatewayProvider() call returns its own independent closure — no shared state to
// reset between tests.
describe("createGatewayProvider", () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-kit-gateway-"));
    keyPath = join(dir, "gateway-key");
    writeFileSync(keyPath, "test-gateway-key\n", "utf8");
    delete process.env["GATEWAY_KEY_FILE"];
    delete process.env["GATEWAY_URL"];
    delete process.env["GATEWAY_LANE"];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["GATEWAY_KEY_FILE"];
    delete process.env["GATEWAY_URL"];
    delete process.env["GATEWAY_LANE"];
  });

  it("routes EVERY model id through the gateway's router route /v1 (aliases resolve there; the /anthropic pass-through forwards names verbatim and 404s on an alias)", () => {
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    for (const modelId of ["heiberg-brain", "claude-opus-4-8"]) {
      const model = gatewayModel(modelId) as unknown as {
        config: { provider: string; baseURL: string };
      };
      expect(model.config.provider).toBe("anthropic.messages");
      // baseURL ends in /v1 — the SDK appends /messages, matching the LiteLLM gateway's
      // router route (which resolves purpose aliases; the old /anthropic/v1 pass-through
      // forwarded the model id to Anthropic verbatim and 404'd on an alias).
      expect(model.config.baseURL).toBe("http://lares-gateway:4000/v1");
    }
  });

  it("forces Accept-Encoding: identity on gateway requests", async () => {
    // 2026-08-14/15 cost incident: LiteLLM's /anthropic passthrough forwarded the upstream's
    // compressed body but DROPPED the Content-Encoding header, so any client advertising
    // compression received compressed bytes labeled plain and failed "Invalid JSON" after the
    // call was billed. The router route never had this defect, but the header is retained
    // (harmless, load-bearing history) — this test keeps it in place.
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    const model = gatewayModel("claude-opus-4-8") as unknown as {
      config: { fetch?: typeof globalThis.fetch };
    };
    expect(model.config.fetch).toBeDefined();
    const seen: Array<Headers> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    try {
      await model.config.fetch!("https://gw.example.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("accept-encoding")).toBe("identity");
    expect(seen[0]!.get("content-type")).toBe("application/json");
  });

  it("the fetch seam sets no Authorization header — the SDK's own x-api-key carries the key", async () => {
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    const model = gatewayModel("claude-opus-4-8") as unknown as {
      config: { fetch?: typeof globalThis.fetch };
    };
    const seen: Array<Headers> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    try {
      await model.config.fetch!("https://gw.example.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.has("authorization")).toBe(false);
  });

  it("respects a custom GATEWAY_URL", () => {
    process.env["GATEWAY_URL"] = "https://gw.example.test";
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    const model = gatewayModel("claude-sonnet-5") as unknown as {
      config: { baseURL: string };
    };
    expect(model.config.baseURL).toBe("https://gw.example.test/v1");
  });

  it("routes a non-Anthropic target (Mistral) through the same Anthropic-format /v1 route — the gateway translates", () => {
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    const model = gatewayModel("mistral/mistral-small-latest") as unknown as {
      config: { provider: string; baseURL: string };
    };
    expect(model.config.provider).toBe("anthropic.messages");
    expect(model.config.baseURL).toBe("http://lares-gateway:4000/v1");
  });

  it("sends the key as x-api-key on a gateway request", () => {
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    const model = gatewayModel("claude-opus-4-8") as unknown as {
      config: { headers: () => Record<string, string> };
    };
    expect(model.config.headers()["x-api-key"]).toBe("test-gateway-key");
  });

  it("throws a clear, path-only error on request when the key file is missing — no silent fallback", () => {
    const missing = join(dir, "does-not-exist");
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: missing });
    const model = gatewayModel("claude-opus-4-8") as unknown as {
      config: { headers: () => Record<string, string> };
    };
    // Constructing is credential-free; building the request headers is where it must fail.
    expect(() => model.config.headers()).toThrow(`secret file not readable: ${missing}`);
  });

  it("throws the same missing-key error for a non-Anthropic target too", () => {
    const missing = join(dir, "does-not-exist");
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: missing });
    const model = gatewayModel("mistral/mistral-small-latest") as unknown as {
      config: { headers: () => Record<string, string> };
    };
    expect(() => model.config.headers()).toThrow(`secret file not readable: ${missing}`);
  });

  // Regression test for the bug that broke the first two real `docker build` runs: `eve build`
  // evaluates agent/agent.ts (which calls gatewayModel at module scope) to compile the agent's
  // static metadata, and a build environment has no gateway secret and must not need one.
  // Constructing a model must therefore touch nothing on disk. If this test fails, the image
  // build and CI both fail with "secret file not readable".
  it("does not read the key file at construction — a credential-free build must work", () => {
    const missing = join(dir, "does-not-exist");
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: missing });
    expect(() => gatewayModel("claude-opus-4-8")).not.toThrow();
    expect(() => gatewayModel("mistral/mistral-small-latest")).not.toThrow();
  });

  it("createGatewayProvider itself reads no secret — the factory call must survive a credential-free build too", () => {
    const missing = join(dir, "does-not-exist");
    expect(() => createGatewayProvider({ defaultKeyFile: missing })).not.toThrow();
  });

  it("two instances with different defaultKeyFile values stay independent — one agent's key never leaks into another's", () => {
    const dirB = mkdtempSync(join(tmpdir(), "agent-kit-gateway-b-"));
    const keyPathB = join(dirB, "gateway-key");
    writeFileSync(keyPathB, "other-agent-key\n", "utf8");
    try {
      const providerA = createGatewayProvider({ defaultKeyFile: keyPath });
      const providerB = createGatewayProvider({ defaultKeyFile: keyPathB });
      expect(providerA.gatewayKey()).toBe("test-gateway-key");
      expect(providerB.gatewayKey()).toBe("other-agent-key");
      // Caching is per-instance: reading A again must still return A's key, not B's.
      expect(providerA.gatewayKey()).toBe("test-gateway-key");
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("respects GATEWAY_KEY_FILE at read time, overriding defaultKeyFile for whichever instance reads it", () => {
    const dirB = mkdtempSync(join(tmpdir(), "agent-kit-gateway-override-"));
    const overridePath = join(dirB, "gateway-key");
    writeFileSync(overridePath, "override-key\n", "utf8");
    process.env["GATEWAY_KEY_FILE"] = overridePath;
    try {
      const { gatewayKey } = createGatewayProvider({ defaultKeyFile: keyPath });
      expect(gatewayKey()).toBe("override-key");
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  describe("the openai-compatible lane (GATEWAY_LANE)", () => {
    it("defaults to the anthropic lane when GATEWAY_LANE is unset", () => {
      const { gatewayLane } = createGatewayProvider({ defaultKeyFile: keyPath });
      expect(gatewayLane()).toBe("anthropic");
    });

    it("GATEWAY_LANE=openai-compatible builds a model on the gateway's own /v1 route, provider named for this engine, not a vendor", () => {
      process.env["GATEWAY_LANE"] = "openai-compatible";
      // An explicit gateway URL, not the module's hardcoded default: a test that asserts the
      // default would restate one installation's own hostname, and that default is itself on
      // wave 9's list to remove. Same neutral host the defaultGatewayUrl test above uses.
      const { gatewayModel, gatewayLane } = createGatewayProvider({
        defaultKeyFile: keyPath,
        defaultGatewayUrl: "https://gw.example.test",
      });
      expect(gatewayLane()).toBe("openai-compatible");
      const model = gatewayModel("mistral/mistral-small-latest") as unknown as {
        config: { provider: string; url: (args: { modelId: string; path: string }) => string };
      };
      expect(model.config.provider).toBe("lares-gateway.chat");
      expect(model.config.url({ modelId: "mistral/mistral-small-latest", path: "/chat/completions" })).toBe(
        "https://gw.example.test/v1/chat/completions",
      );
    });

    it("a defaultLane option picks the lane the same way GATEWAY_LANE does, when GATEWAY_LANE is unset", () => {
      const { gatewayLane } = createGatewayProvider({ defaultKeyFile: keyPath, defaultLane: "openai-compatible" });
      expect(gatewayLane()).toBe("openai-compatible");
    });

    it("does not read the key file at construction on this lane either — a credential-free build must work", () => {
      process.env["GATEWAY_LANE"] = "openai-compatible";
      const missing = join(dir, "does-not-exist");
      const { gatewayModel } = createGatewayProvider({ defaultKeyFile: missing });
      expect(() => gatewayModel("mistral/mistral-small-latest")).not.toThrow();
    });

    it("injects Authorization fresh, per request — never baked in at construction (the real seam this slice exists to close: createOpenAICompatible's own `headers` option is captured once, synchronously, at construction, unlike @ai-sdk/anthropic's per-request getHeaders() closure)", async () => {
      process.env["GATEWAY_LANE"] = "openai-compatible";
      const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
      const model = gatewayModel("mistral/mistral-small-latest") as unknown as {
        config: { fetch?: typeof globalThis.fetch };
      };
      const seen: Array<Headers> = [];
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return Promise.resolve(new Response("{}", { status: 200 }));
      });
      try {
        await model.config.fetch!("https://gw.example.test/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
      } finally {
        vi.unstubAllGlobals();
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]!.get("authorization")).toBe("Bearer test-gateway-key");
      expect(seen[0]!.get("accept-encoding")).toBe("identity");
    });

    it("throws the same missing-key error on request as the anthropic lane — no silent fallback", async () => {
      process.env["GATEWAY_LANE"] = "openai-compatible";
      const missing = join(dir, "does-not-exist");
      const { gatewayModel } = createGatewayProvider({ defaultKeyFile: missing });
      const model = gatewayModel("mistral/mistral-small-latest") as unknown as {
        config: { fetch?: typeof globalThis.fetch };
      };
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
      try {
        await expect(model.config.fetch!("https://gw.example.test/v1/chat/completions", { method: "POST" })).rejects.toThrow(
          `secret file not readable: ${missing}`,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("refuses a GATEWAY_LANE value that names neither lane, rather than silently picking one", () => {
      process.env["GATEWAY_LANE"] = "vertex-ai";
      const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
      expect(() => gatewayModel("claude-opus-4-8")).toThrow(/GATEWAY_LANE/);
    });
  });
});
