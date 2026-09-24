import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { renderGatewayConfig } from "../lib/gateway-config.js";

describe("the generated LiteLLM config", () => {
  it("names the one alias every agent calls, and no literal key", () => {
    const doc = parse(renderGatewayConfig({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" })) as any;
    const entry = doc.model_list[0];
    expect(entry.model_name).toBe("lares-brain");
    expect(entry.litellm_params.model).toBe("anthropic/claude-sonnet-4-5");
    expect(entry.litellm_params.api_key).toBe("os.environ/LARES_MODEL_PROVIDER_KEY");
    expect(JSON.stringify(doc)).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("carries the master key by reference only, never a literal", () => {
    const doc = parse(renderGatewayConfig({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" })) as any;
    expect(doc.general_settings.master_key).toBe("os.environ/LARES_GATEWAY_MASTER_KEY");
  });

  it("switches telemetry off and turns the local cost map on", () => {
    const text = renderGatewayConfig({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" });
    expect(text).toMatch(/litellm_settings:\s*\n(.*\n)*?\s*telemetry:\s*[fF]alse/);
  });
});
