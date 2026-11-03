/**
 * The neutral stack's model gateway (LiteLLM): the four chat purposes, no telemetry, the local cost map. By default all
 * four serve the one model; an installation may name its own model for the writer, utility or gate purpose. An
 * installation that names an embedding model and its address also gets a fifth alias, `<prefix>-embed`, served with its own
 * provider key. The provider keys and the proxy's own master key are NEVER literal here — all are `os.environ/…`
 * references LiteLLM itself resolves at container start, per LiteLLM's documented config format.
 * The actual secret files reach those environment variables via `images/gateway-runtime/start.sh`.
 */
import { stringify } from "yaml";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@lares/agent-kit/definition-model";

/** The chat purposes that may name a model of their own. The brain's model is `providerModel`. */
export const PURPOSE_MODEL_PURPOSES = ["writer", "utility", "gate"] as const;
export type PurposeModelPurpose = (typeof PURPOSE_MODEL_PURPOSES)[number];

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
  /** A model of its own for a purpose, as "<provider>/<model>" on the SAME provider as `providerModel`.
   *  A purpose that is absent, or names the brain's model, is served by the brain's model. */
  readonly purposeModels?: Readonly<Partial<Record<PurposeModelPurpose, string>>>;
  /** An embedding model, served as `<prefix>-embed` over the OpenAI-compatible embeddings wire. It has its own address and
   *  its own provider key, so it does not have to share the chat provider. Absent means no embedding alias. */
  readonly embedding?: GatewayEmbeddingOptions;
}

export interface GatewayEmbeddingOptions {
  /** The provider's bare model name, for example "mistral-embed". */
  readonly model: string;
  /** Explicit HTTPS base URL, written with the version path the provider documents, and no trailing slash. */
  readonly baseUrl: string;
  /** The longest single input, in tokens, the model accepts. Defaults to DEFAULT_EMBED_MAX_INPUT_TOKENS. */
  readonly maxInputTokens?: number;
}

/** What the reviewed default embedding model accepts per input. */
export const DEFAULT_EMBED_MAX_INPUT_TOKENS = 8192;
/** The most inputs one embeddings call may carry. */
export const EMBED_MAX_INPUTS = 32;

/** The chat purposes this gateway always serves. The embedding alias is added only when one is configured. */
const SERVED_PURPOSES = ["brain", ...PURPOSE_MODEL_PURPOSES] as const;

const MODEL_NAME = /^[A-Za-z0-9_.:-]{1,160}$/;

const settingName = (purpose: PurposeModelPurpose) => `LARES_MODEL_${purpose.toUpperCase()}`;

/** The one place the optional per-purpose settings are read from installation.env. `settings` holds the file's
 *  values by name. A value equal to the brain's model is dropped: it is the default, and
 *  keeping it out keeps the rendered config and profile byte-identical to an installation that never set it. */
export function gatewayOptionsFromSettings(settings: Readonly<Record<string, string | undefined>>): GatewayConfigOptions {
  const alias = settings.LARES_MODEL_ALIAS, providerModel = settings.LARES_MODEL;
  if (!alias || !providerModel) throw new Error("LARES_MODEL_ALIAS and LARES_MODEL must both be set to describe the gateway.");
  const purposeModels: Partial<Record<PurposeModelPurpose, string>> = {};
  for (const purpose of PURPOSE_MODEL_PURPOSES) {
    const value = settings[settingName(purpose)];
    if (value === undefined || value === providerModel) continue;
    purposeModels[purpose] = value;
  }
  const embedding = embeddingFromSettings(settings);
  return {
    alias, providerModel,
    ...(Object.keys(purposeModels).length ? { purposeModels } : {}),
    ...(embedding ? { embedding } : {}),
  };
}

function embeddingFromSettings(settings: Readonly<Record<string, string | undefined>>): GatewayEmbeddingOptions | undefined {
  const model = settings.LARES_EMBED_MODEL, baseUrl = settings.LARES_EMBED_BASE_URL, tokens = settings.LARES_EMBED_MAX_INPUT_TOKENS;
  if (model === undefined && baseUrl === undefined && tokens === undefined) return undefined;
  if (!model || !baseUrl) throw new Error("LARES_EMBED_MODEL and LARES_EMBED_BASE_URL must be set together to describe the embedding model.");
  let maxInputTokens: number | undefined;
  if (tokens !== undefined) {
    if (!/^[1-9][0-9]{0,6}$/.test(tokens)) throw new Error("LARES_EMBED_MAX_INPUT_TOKENS must be a whole number of tokens.");
    maxInputTokens = Number(tokens);
  }
  return { model, baseUrl, ...(maxInputTokens === undefined ? {} : { maxInputTokens }) };
}

/** The checked embedding block of the profile, or undefined when none is configured. */
function embeddingProfile(opts: GatewayConfigOptions, prefix: string) {
  const embedding = opts.embedding;
  if (!embedding) return undefined;
  if (!MODEL_NAME.test(embedding.model)) throw new Error("LARES_EMBED_MODEL is not a usable model name.");
  let url: URL;
  try { url = new URL(embedding.baseUrl); } catch { throw new Error("The embedding provider must use an explicit HTTPS base URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || embedding.baseUrl.endsWith("/"))
    throw new Error("The embedding provider must use an explicit HTTPS base URL.");
  const maxInputTokens = embedding.maxInputTokens ?? DEFAULT_EMBED_MAX_INPUT_TOKENS;
  if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1 || maxInputTokens > 1_000_000)
    throw new Error("LARES_EMBED_MAX_INPUT_TOKENS must be a whole number of tokens.");
  return {
    alias: `${prefix}-embed`, provider: "openai", model: embedding.model, providerBaseUrl: embedding.baseUrl,
    maxInputs: EMBED_MAX_INPUTS, maxInputTokens,
  };
}

/** Each purpose that really differs from the brain, as a bare model name on the brain's provider. */
function ownPurposeModels(opts: GatewayConfigOptions, provider: string): Partial<Record<PurposeModelPurpose, string>> {
  const own: Partial<Record<PurposeModelPurpose, string>> = {};
  for (const purpose of PURPOSE_MODEL_PURPOSES) {
    const value = opts.purposeModels?.[purpose];
    if (value === undefined || value === opts.providerModel) continue;
    const slash = value.indexOf("/");
    if (slash < 1 || value.slice(0, slash) !== provider)
      throw new Error(`${settingName(purpose)} must use the same provider as LARES_MODEL (${provider}), written as ${provider}/<model>.`);
    const model = value.slice(slash + 1);
    if (!MODEL_NAME.test(model)) throw new Error(`${settingName(purpose)} is not a usable model name.`);
    own[purpose] = model;
  }
  return own;
}

/** Bounds capabilities, not prices. Admission authority/pricing/recovery is separate. */
export function gatewayAdmissionProfile(opts: GatewayConfigOptions) {
  if (!opts.alias.endsWith("-brain") || opts.alias === "-brain")
    throw new Error("The model alias must end in -brain (for example lares-brain).");
  const slash = opts.providerModel.indexOf("/");
  const provider = opts.providerModel.slice(0, slash), model = opts.providerModel.slice(slash + 1);
  if (!["openai", "anthropic"].includes(provider) || !MODEL_NAME.test(model))
    throw new Error("This gateway admission profile requires a reviewed OpenAI or Anthropic target.");
  const providerBaseUrl = opts.providerBaseUrl ?? (provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com");
  const url = new URL(providerBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || providerBaseUrl.endsWith("/"))
    throw new Error("The gateway provider must use an explicit HTTPS base URL.");
  const prefix = opts.alias.slice(0, -"-brain".length);
  const own = ownPurposeModels(opts, provider);
  const embedding = embeddingProfile(opts, prefix);
  const purposeModels = Object.fromEntries(PURPOSE_MODEL_PURPOSES.flatMap(purpose =>
    own[purpose] === undefined ? [] : [[`${prefix}-${purpose}`, own[purpose]]]));
  return {
    version: 1, provider, model, providerBaseUrl,
    aliases: [...SERVED_PURPOSES.map(purpose => `${prefix}-${purpose}`), ...(embedding ? [embedding.alias] : [])],
    maxBodyBytes: 1_048_576,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    // Only present when a purpose has a model of its own, so every other installation keeps its reviewed profile unchanged.
    ...(Object.keys(purposeModels).length ? { purposeModels } : {}),
    // Only present when an embedding model is configured, for the same reason.
    ...(embedding ? { embedding } : {}),
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
  const purposeModels = profile.purposeModels as Record<string, string> | undefined;
  const embedding = profile.embedding;
  /** The one routing decision: which provider model serves an alias. */
  const route = (alias: string) => purposeModels?.[alias] === undefined ? opts.providerModel : `${profile.provider}/${purposeModels[alias]}`;
  const config = {
    model_list: [
      ...SERVED_PURPOSES.map((purpose) => ({
        model_name: `${prefix}-${purpose}`,
        litellm_params: {
          model: route(`${prefix}-${purpose}`),
          api_key: "os.environ/LARES_MODEL_PROVIDER_KEY",
          api_base: profile.providerBaseUrl,
          max_retries: 0,
          num_retries: 0,
        },
      })),
      ...(embedding ? [{
        model_name: embedding.alias,
        litellm_params: {
          model: `openai/${embedding.model}`,
          api_key: "os.environ/LARES_EMBED_PROVIDER_KEY",
          api_base: embedding.providerBaseUrl,
          max_retries: 0,
          num_retries: 0,
        },
      }] : []),
    ],
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
      disable_auto_add_proxy_admin_to_teams: true,
    },
  };
  return stringify(config);
}
