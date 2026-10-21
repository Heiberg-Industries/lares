/**
 * The neutral stack's model gateway (LiteLLM): the four chat purposes on one model, no telemetry, the local cost map. The
 * provider key and the proxy's own master key are NEVER literal here — both are `os.environ/…`
 * references LiteLLM itself resolves at container start, per LiteLLM's documented config format.
 * The actual secret files reach those environment variables via `images/gateway-runtime/start.sh`.
 */
import { stringify } from "yaml";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@lares/agent-kit/definition-model";

export interface GatewayConfigOptions {
  /** The brain alias — LARES_MODEL_ALIAS's value, "lares-brain" by install.sh's own default.
   *  Its `-brain` suffix is removed to get the installation's prefix; the writer, utility and gate
   *  aliases are served under that same prefix. */
  readonly alias: string;
  /** The provider+model LiteLLM routes that alias to, e.g. "anthropic/claude-sonnet-4-5". A
   *  release-pinned value — this file does not choose it. */
  readonly providerModel: string;
  /** Explicit HTTPS upstream for a reviewed profile (including isolated CI providers). */
  readonly providerBaseUrl?: string;
}

/** The purposes this gateway serves. No `embed`: one chat model cannot embed. */
const SERVED_PURPOSES = ["brain", "writer", "utility", "gate"] as const;

/** Bounds capabilities, not prices. Admission authority/pricing/recovery is separate. */
export function gatewayAdmissionProfile(opts: GatewayConfigOptions) {
  if (!opts.alias.endsWith("-brain") || opts.alias === "-brain")
    throw new Error("The model alias must end in -brain (for example lares-brain).");
  const slash = opts.providerModel.indexOf("/");
  const provider = opts.providerModel.slice(0, slash), model = opts.providerModel.slice(slash + 1);
  if (!["openai", "anthropic"].includes(provider) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(model))
    throw new Error("This gateway admission profile requires a reviewed OpenAI or Anthropic target.");
  const providerBaseUrl = opts.providerBaseUrl ?? (provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com");
  const url = new URL(providerBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || providerBaseUrl.endsWith("/"))
    throw new Error("The gateway provider must use an explicit HTTPS base URL.");
  return {
    version: 1, provider, model, providerBaseUrl,
    aliases: SERVED_PURPOSES.map(purpose => `${opts.alias.slice(0, -"-brain".length)}-${purpose}`),
    maxBodyBytes: 1_048_576,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/** Renders LiteLLM's config.yaml. Refuses an alias that does not end in `-brain`. */
export function renderGatewayConfig(opts: GatewayConfigOptions): string {
  if (!opts.alias.endsWith("-brain") || opts.alias === "-brain")
    throw new Error(
      `The model alias "${opts.alias}" must end in -brain (for example lares-brain): the writer, utility and gate names are built from the same prefix. Fix: set LARES_MODEL_ALIAS to <prefix>-brain.`,
    );
  const prefix = opts.alias.slice(0, -"-brain".length);
  const profile = gatewayAdmissionProfile(opts);
  const config = {
    model_list: SERVED_PURPOSES.map((purpose) => ({
      model_name: `${prefix}-${purpose}`,
      litellm_params: {
        model: opts.providerModel,
        api_key: "os.environ/LARES_MODEL_PROVIDER_KEY",
        api_base: profile.providerBaseUrl,
        max_retries: 0,
        num_retries: 0,
      },
    })),
    litellm_settings: {
      telemetry: false,
      callbacks: ["lares_gateway.gateway_hook"],
      disable_aiohttp_transport: true,
      drop_params: false,
      use_chat_completions_url_for_anthropic_messages: true,
    },
    router_settings: { num_retries: 0, fallbacks: [], context_window_fallbacks: [], content_policy_fallbacks: [] },
    general_settings: {
      master_key: "os.environ/LARES_GATEWAY_MASTER_KEY",
      background_health_checks: false,
    },
  };
  return stringify(config);
}
