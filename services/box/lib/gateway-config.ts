/**
 * The neutral stack's model gateway (LiteLLM): one alias, no telemetry, the local cost map. The
 * provider key and the proxy's own master key are NEVER literal here — both are `os.environ/…`
 * references LiteLLM itself resolves at container start, per LiteLLM's documented config format.
 * The actual secret files reach those environment variables via `images/gateway-runtime/start.sh`.
 */
import { stringify } from "yaml";

export interface GatewayConfigOptions {
  /** The one alias every agent's GATEWAY_URL request names — LARES_MODEL_ALIAS's value,
   *  "lares-brain" by install.sh's own default. */
  readonly alias: string;
  /** The provider+model LiteLLM routes that alias to, e.g. "anthropic/claude-sonnet-4-5". A
   *  release-pinned value — this file does not choose it. */
  readonly providerModel: string;
}

/** Renders LiteLLM's config.yaml. */
export function renderGatewayConfig(opts: GatewayConfigOptions): string {
  const config = {
    model_list: [
      {
        model_name: opts.alias,
        litellm_params: {
          model: opts.providerModel,
          api_key: "os.environ/LARES_MODEL_PROVIDER_KEY",
        },
      },
    ],
    litellm_settings: {
      telemetry: false,
    },
    general_settings: {
      master_key: "os.environ/LARES_GATEWAY_MASTER_KEY",
    },
  };
  return stringify(config);
}
