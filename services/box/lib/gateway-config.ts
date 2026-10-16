/**
 * The neutral stack's model gateway (LiteLLM): the four chat purposes on one model, no telemetry, the local cost map. The
 * provider key and the proxy's own master key are NEVER literal here — both are `os.environ/…`
 * references LiteLLM itself resolves at container start, per LiteLLM's documented config format.
 * The actual secret files reach those environment variables via `images/gateway-runtime/start.sh`.
 */
import { stringify } from "yaml";

export interface GatewayConfigOptions {
  /** The brain alias — LARES_MODEL_ALIAS's value, "lares-brain" by install.sh's own default.
   *  Its `-brain` suffix is removed to get the installation's prefix; the writer, utility and gate
   *  aliases are served under that same prefix. */
  readonly alias: string;
  /** The provider+model LiteLLM routes that alias to, e.g. "anthropic/claude-sonnet-4-5". A
   *  release-pinned value — this file does not choose it. */
  readonly providerModel: string;
}

/** The purposes this gateway serves. No `embed`: one chat model cannot embed. */
const SERVED_PURPOSES = ["brain", "writer", "utility", "gate"] as const;

/** Renders LiteLLM's config.yaml. Refuses an alias that does not end in `-brain`. */
export function renderGatewayConfig(opts: GatewayConfigOptions): string {
  if (!opts.alias.endsWith("-brain") || opts.alias === "-brain")
    throw new Error(
      `The model alias "${opts.alias}" must end in -brain (for example lares-brain): the writer, utility and gate names are built from the same prefix. Fix: set LARES_MODEL_ALIAS to <prefix>-brain.`,
    );
  const prefix = opts.alias.slice(0, -"-brain".length);
  const config = {
    model_list: SERVED_PURPOSES.map((purpose) => ({
      model_name: `${prefix}-${purpose}`,
      litellm_params: {
        model: opts.providerModel,
        api_key: "os.environ/LARES_MODEL_PROVIDER_KEY",
      },
    })),
    litellm_settings: {
      telemetry: false,
    },
    general_settings: {
      master_key: "os.environ/LARES_GATEWAY_MASTER_KEY",
    },
  };
  return stringify(config);
}
