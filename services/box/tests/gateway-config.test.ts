import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { renderGatewayConfig, gatewayAdmissionProfile, gatewayOptionsFromSettings } from "../lib/gateway-config.js";
import { gatewayCanonical } from "@lares/agent-kit/gateway-admission-protocol";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@lares/agent-kit/definition-model";

describe("the generated LiteLLM config", () => {
  it("pins the real admission hook, disables automatic alternatives and reuses the output cap", () => {
    const options = {alias:"lares-brain",providerModel:"openai/gpt-4o-mini"};
    const doc = parse(renderGatewayConfig(options));
    expect(doc.litellm_settings.callbacks).toEqual(["lares_gateway.gateway_hook"]);
    expect(doc.litellm_settings.use_chat_completions_url_for_anthropic_messages).toBe(true);
    expect(doc.router_settings).toEqual({num_retries:0,fallbacks:[],context_window_fallbacks:[],content_policy_fallbacks:[]});
    expect(gatewayAdmissionProfile(options).maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(() => gatewayAdmissionProfile({...options,providerBaseUrl:"http://provider.invalid/v1"})).toThrow(/HTTPS/);
  });
  it("serves the four chat purposes under the alias's prefix, all on the one model, and no literal key", () => {
    const doc = parse(renderGatewayConfig({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" })) as any;
    const entry = doc.model_list[0];
    expect(entry.model_name).toBe("lares-brain");
    expect(entry.litellm_params.model).toBe("anthropic/claude-sonnet-4-5");
    expect(entry.litellm_params.api_key).toBe("os.environ/LARES_MODEL_PROVIDER_KEY");
    expect(JSON.stringify(doc)).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(doc.model_list.map((e: any) => e.model_name)).toEqual(["lares-brain", "lares-writer", "lares-utility", "lares-gate"]);
    for (const e of doc.model_list) expect(e.litellm_params).toEqual(entry.litellm_params);
  });

  it("builds the names from whatever prefix the alias carries", () => {
    const doc = parse(renderGatewayConfig({ alias: "home-brain", providerModel: "anthropic/claude-sonnet-4-5" })) as any;
    expect(doc.model_list.map((e: any) => e.model_name)).toEqual(["home-brain", "home-writer", "home-utility", "home-gate"]);
  });

  it("refuses an alias that does not end in -brain, saying how to fix it", () => {
    for (const alias of ["lares", "lares-writer", "-brain", ""])
      expect(() => renderGatewayConfig({ alias, providerModel: "anthropic/claude-sonnet-4-5" })).toThrow(/must end in -brain/);
  });

  it("carries the master key by reference only, never a literal", () => {
    const doc = parse(renderGatewayConfig({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" })) as any;
    expect(doc.general_settings.master_key).toBe("os.environ/LARES_GATEWAY_MASTER_KEY");
    expect(doc.general_settings.disable_auto_add_proxy_admin_to_teams).toBe(true);
    expect(doc.general_settings.background_health_checks).toBe(false);
  });

  it("switches telemetry off and turns the local cost map on", () => {
    const text = renderGatewayConfig({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" });
    expect(text).toMatch(/litellm_settings:\s*\n(.*\n)*?\s*telemetry:\s*[fF]alse/);
  });

  // Captured from the engine as it was before per-purpose models existed. With no purpose
  // models, the rendered file and the profile the budget policy is reviewed against must not
  // change by a single byte, or every existing installation's reviewed policy stops matching.
  it("renders the default config and profile exactly as before per-purpose models existed", () => {
    const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const anthropic = { alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" };
    expect(JSON.stringify(gatewayAdmissionProfile(anthropic))).toBe(
      '{"version":1,"provider":"anthropic","model":"claude-sonnet-4-5","providerBaseUrl":"https://api.anthropic.com",' +
      '"aliases":["lares-brain","lares-writer","lares-utility","lares-gate"],"maxBodyBytes":1048576,"maxOutputTokens":16384}');
    expect(sha(renderGatewayConfig(anthropic))).toBe("73f5fe69e0aedaaca03ebf3260cff5490834bf8d41fb5a287b26e1e2fb3dcbc4");
    expect(sha(gatewayCanonical(gatewayAdmissionProfile(anthropic)))).toBe("ae122056c646fbfacd8890c35493e33869719c3ac99c6c151f95f32040e43ddf");
    const openai = { alias: "lares-brain", providerModel: "openai/gpt-4o-mini", providerBaseUrl: "https://provider.example.com/v1" };
    expect(sha(renderGatewayConfig(openai))).toBe("0ac77f5d696f6698ca275cfda3c61a11e1aaa24ed483bfbc1a177e60c6760ed5");
    expect(sha(gatewayCanonical(gatewayAdmissionProfile(openai)))).toBe("4530a4e272d490b1c183f65fe97b797ebe9090fddb9edb491539017491baaa6b");
  });

  describe("a model per purpose", () => {
    const base = { alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" };

    it("routes each purpose that names its own model there, and every other purpose to the brain model", () => {
      const options = { ...base, purposeModels: { writer: "anthropic/claude-opus-4-5", gate: "anthropic/claude-haiku-4-5" } };
      const doc = parse(renderGatewayConfig(options)) as any;
      const models = Object.fromEntries(doc.model_list.map((e: any) => [e.model_name, e.litellm_params.model]));
      expect(models).toEqual({
        "lares-brain": "anthropic/claude-sonnet-4-5", "lares-writer": "anthropic/claude-opus-4-5",
        "lares-utility": "anthropic/claude-sonnet-4-5", "lares-gate": "anthropic/claude-haiku-4-5",
      });
      for (const e of doc.model_list) {
        expect(e.litellm_params.api_key).toBe("os.environ/LARES_MODEL_PROVIDER_KEY");
        expect(e.litellm_params.api_base).toBe("https://api.anthropic.com");
      }
      expect(gatewayAdmissionProfile(options)).toMatchObject({
        model: "claude-sonnet-4-5",
        purposeModels: { "lares-writer": "claude-opus-4-5", "lares-gate": "claude-haiku-4-5" },
      });
    });

    it("omits a purpose model that equals the brain model, so the output is the default output", () => {
      const options = { ...base, purposeModels: { writer: "anthropic/claude-sonnet-4-5" } };
      expect(renderGatewayConfig(options)).toBe(renderGatewayConfig(base));
      expect(gatewayAdmissionProfile(options)).toEqual(gatewayAdmissionProfile(base));
      expect("purposeModels" in gatewayAdmissionProfile(options)).toBe(false);
    });

    it("refuses a purpose model on another provider, saying which setting", () => {
      expect(() => gatewayAdmissionProfile({ ...base, purposeModels: { writer: "openai/gpt-4o-mini" } })).toThrow(/LARES_MODEL_WRITER.*same provider/);
      expect(() => renderGatewayConfig({ ...base, purposeModels: { utility: "openai/gpt-4o-mini" } })).toThrow(/LARES_MODEL_UTILITY.*same provider/);
      expect(() => gatewayAdmissionProfile({ ...base, purposeModels: { gate: "claude-haiku-4-5" } })).toThrow(/LARES_MODEL_GATE/);
      expect(() => gatewayAdmissionProfile({ ...base, purposeModels: { gate: "anthropic/bad model" } })).toThrow(/LARES_MODEL_GATE/);
    });

    it("reads the optional settings in one place and drops a value equal to the brain model", () => {
      expect(gatewayOptionsFromSettings({ LARES_MODEL_ALIAS: "lares-brain", LARES_MODEL: "anthropic/claude-sonnet-4-5" }))
        .toEqual({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5" });
      expect(gatewayOptionsFromSettings({
        LARES_MODEL_ALIAS: "lares-brain", LARES_MODEL: "anthropic/claude-sonnet-4-5",
        LARES_MODEL_WRITER: "anthropic/claude-opus-4-5", LARES_MODEL_UTILITY: "anthropic/claude-sonnet-4-5",
      })).toEqual({ alias: "lares-brain", providerModel: "anthropic/claude-sonnet-4-5", purposeModels: { writer: "anthropic/claude-opus-4-5" } });
      expect(() => gatewayOptionsFromSettings({ LARES_MODEL_ALIAS: "lares-brain" })).toThrow(/LARES_MODEL/);
    });
  });
});
